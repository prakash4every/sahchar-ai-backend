import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { MongoClient } from 'mongodb';

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('LiveAudio Server v2.1 - PCM 16kHz'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });
console.log(`🎤 WebSocket server on ${PORT}`);

// ==================== MongoDB Setup ====================
let db = null;
if (process.env.MONGODB_URI) {
    const mongoClient = new MongoClient(process.env.MONGODB_URI);
    mongoClient.connect().then(() => {
        console.log("✅ Live Server: Connected to MongoDB");
        db = mongoClient.db();
    }).catch(err => {
        console.error("❌ Live Server: MongoDB connection error:", err.message);
    });
}

async function loadConversationFromDB(deviceId, limit = 6) {
    if (!db ||!deviceId) return [];
    try {
        const convCollection = db.collection('conversations');
        const messages = await convCollection.find({ sessionId: deviceId })
         .sort({ timestamp: -1 })
         .limit(limit)
         .toArray();
        const history = [];
        messages.reverse().forEach(msg => {
            history.push({ role: "user", content: msg.userMessage });
            history.push({ role: "assistant", content: msg.botReply });
        });
        console.log(`📚 Loaded ${history.length} messages from MongoDB for ${deviceId}`);
        return history;
    } catch (err) {
        console.error("Error loading conversation from DB:", err);
        return [];
    }
}

async function saveConversationToDB(deviceId, userMessage, botReply) {
    if (!db) return;
    try {
        await db.collection("conversations").insertOne({
            sessionId: deviceId,
            userMessage,
            botReply,
            timestamp: new Date()
        });
    } catch (e) {
        console.error("MongoDB insert error:", e);
    }
}

// ==================== OpenAI Whisper + TTS ====================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==================== ElevenLabs TTS - Optional ====================
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID_HINDI = process.env.ELEVENLABS_VOICE_ID || 'yoZ06aMxZJJ28mfd3POQ';

async function ttsStream(text) {
    // OpenAI TTS - Zyada reliable hai
    const speech = await openai.audio.speech.create({
        model: "tts-1",
        voice: "nova", // alloy, echo, fable, onyx, nova, shimmer
        input: text,
        response_format: "mp3"
    });
    return speech.body; // Returns ReadableStream
}

function convertMp3StreamToPcm16k(mp3Stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(mp3Stream)
         .audioCodec('pcm_s16le')
         .format('s16le')
         .audioChannels(1)
         .audioFrequency(16000)
         .outputOptions('-ar 16000', '-ac 1')
         .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
         .on('end', () => resolve(Buffer.concat(chunks)))
         .pipe()
         .on('data', (chunk) => chunks.push(chunk));
    });
}

// ==================== PCM to WAV ====================
function pcmToWav(pcmData, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
    const blockAlign = numChannels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
}

async function bufferToFile(buffer) {
    const tempPath = path.join('/tmp', `audio_${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
}

function calculateRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i);
        sum += sample * sample;
    }
    return Math.sqrt(sum / (buffer.length / 2)) / 32768.0;
}

// ==================== WebSocket Handler ====================
const sessionHistories = new Map();
const activeSessions = new Map();

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get('deviceId') || 'default';

    if (activeSessions.has(deviceId)) {
        console.log(`⚠️ Duplicate connection for ${deviceId}, closing old`);
        try { activeSessions.get(deviceId).close(); } catch {}
    }
    activeSessions.set(deviceId, ws);

    const sessionId = randomUUID();
    console.log(`🔌 Client connected: session=${sessionId}, deviceId=${deviceId}`);

    const pastMessages = await loadConversationFromDB(deviceId, 3);
    const history = [
        { role: 'system', content: '' },
     ...pastMessages
    ];
    sessionHistories.set(sessionId, history);

    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let botSpeakingEndTime = 0;
    let silenceTimer = null;
    let isClosed = false;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2;
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND * 2; // 2 sec
    const MIN_SPEECH_BYTES = BYTES_PER_SECOND * 0.4; // 0.4 sec

    function safeSend(data) {
        if (!isClosed && ws && ws.readyState === ws.OPEN) {
            try {
                ws.send(data);
                return true;
            } catch (err) {
                console.error('❌ WS send error:', err.message);
                return false;
            }
        }
        return false;
    }

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 &&!isProcessing &&!isClosed) {
                console.log('Silence detected, processing...');
                processAudio();
            }
        }, 800);
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing || isClosed) return;

        if (Date.now() < botSpeakingEndTime) {
            console.log("⚠️ Dropping audio - bot speaking");
            audioBuffer = [];
            return;
        }

        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes < MIN_SPEECH_BYTES) {
            console.log(`⚠️ Audio too short: ${totalBytes} bytes`);
            audioBuffer = [];
            isProcessing = false;
            return;
        }

        const fullAudio = Buffer.concat(audioBuffer);
        audioBuffer = [];

        const rms = calculateRMS(fullAudio);
        console.log(`🎤 Audio RMS: ${rms.toFixed(4)}, Bytes: ${totalBytes}`);

        if (rms < 0.008) {
            console.log(`⚠️ Audio too quiet RMS=${rms.toFixed(4)}`);
            isProcessing = false;
            return;
        }

        const wavBuffer = pcmToWav(fullAudio);
        const tempPath = await bufferToFile(wavBuffer);

        try {
            // FIX 1: OpenAI Whisper - Zyada reliable Hindi ke liye
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: 'whisper-1',
                language: 'hi',
                temperature: 0.0,
                prompt: "यह हिंदी में बातचीत है। नमस्ते, हेलो, आज, कैसा, अच्छा, धन्यवाद।"
            });

            let transcript = transcription.text.trim();
            console.log(`📝 Whisper transcript: ${transcript}`);

            if (transcript.length < 2) {
                console.log(`⚠️ Empty transcript, ignoring`);
                return;
            }

            safeSend(JSON.stringify({ type: "user_text", text: transcript }));
            await sendToLLM(transcript);

        } catch (err) {
            console.error("❌ Whisper error:", err.message);
            safeSend(JSON.stringify({ type: "error", text: "सुन नहीं पाया, फिर से बोलें 🙏" }));
        } finally {
            try { fs.unlinkSync(tempPath); } catch {}
            isProcessing = false;
        }
    }

    async function sendToLLM(text) {
        if (isClosed) return;
        console.log(`🤖 LLM: ${text}`);

        const now = new Date();
        const currentDateTime = now.toLocaleString('hi-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
        });

        const history = sessionHistories.get(sessionId);
       history[0].content = `तुम 'SahcharAI' हो। 
नियम:
1. User लंबा बोले तो बीच में "हाँ", "अच्छा", "समझ गया" बोलो
2. 1-2 वाक्य में जवाब दो
3. Natural conversation करो जैसे दोस्त`;

        history.push({ role: 'user', content: text });
        if (history.length > 7) history.splice(1, history.length - 7);

        try {
            const completion = await openai.responses.create({
                model: "gpt-4o-mini",
                input: history,
                max_output_tokens: 80,
                temperature: 0.5
            });

            const fullReply = completion.output_text || "समझ नहीं आया।";
            history.push({ role: "assistant", content: fullReply });

            safeSend(JSON.stringify({ type: "bot_text", text: fullReply }));
            await saveConversationToDB(deviceId, text, fullReply);

            const estimatedDuration = (fullReply.length / 7) * 1000 + 1000;
            botSpeakingEndTime = Date.now() + estimatedDuration;
            isBotSpeaking = true;
            console.log(`🔇 Mic muted for ${estimatedDuration}ms`);

            // TTS + Send Audio
            const mp3Stream = await ttsStream(fullReply);
            const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);

            const CHUNK_SIZE = 640;
            for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
                if (isClosed ||!safeSend(pcmBuffer.slice(i, i + CHUNK_SIZE))) break;
                await new Promise(r => setTimeout(r, 20));
            }

        } catch (err) {
            console.error("❌ LLM/TTS error:", err.message);
            safeSend(JSON.stringify({ type: "error", text: "जवाब नहीं दे पाया 🙏" }));
        } finally {
            // FIX 3: Hamesha mic wapas on karo
            const delay = Math.max(0, botSpeakingEndTime - Date.now());
            setTimeout(() => {
                if (!isClosed) {
                    isBotSpeaking = false;
                    console.log("🎤 Mic unmuted");
                    safeSend(JSON.stringify({ type: "status", text: "सुनने के लिए तैयार" }));
                }
            }, delay);
        }
    }

    ws.on('message', (data) => {
        if (isClosed || isBotSpeaking || Date.now() < botSpeakingEndTime) return;
        const chunk = Buffer.isBuffer(data)? data : Buffer.from(data);
        audioBuffer.push(chunk);
        resetSilenceTimer();
    });

    ws.on('close', () => {
        console.log(`🔌 Client disconnected: ${deviceId}`);
        isClosed = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        audioBuffer = [];
        activeSessions.delete(deviceId);
        setTimeout(() => sessionHistories.delete(sessionId), 5 * 60 * 1000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        isClosed = true;
        activeSessions.delete(deviceId);
    });
});
