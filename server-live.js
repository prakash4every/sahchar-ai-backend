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

app.get('/', (req, res) => res.send('Live audio server - PCM 16kHz'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });
console.log(`🎤 WebSocket server on ${PORT}`);

// ==================== MongoDB Setup ====================
let mongoClient;
let db = null;
if (process.env.MONGODB_URI) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    mongoClient.connect().then(() => {
        console.log("✅ Live Server: Connected to MongoDB");
        db = mongoClient.db();
    }).catch(err => {
        console.error("❌ Live Server: MongoDB connection error:", err.message);
        db = null;
    });
}

async function loadConversationFromDB(deviceId, limit = 10) {
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

// ==================== NVIDIA NIM ====================
const nvidiaApiKeys = [
    process.env.NGC_API_KEY_1,
    process.env.NGC_API_KEY_2,
    process.env.NGC_API_KEY_3,
    process.env.NGC_API_KEY
].filter(key => key && key.trim()!== "");

async function callNvidiaWithFallback(messages) {
    if (nvidiaApiKeys.length === 0) throw new Error("No NVIDIA keys");
    for (let keyIdx = 0; keyIdx < nvidiaApiKeys.length; keyIdx++) {
        const apiKey = nvidiaApiKeys[keyIdx];
        try {
            const nvidiaClient = new OpenAI({
                apiKey: apiKey,
                baseURL: 'https://integrate.api.nvidia.com/v1',
                timeout: 30000
            });
            const stream = await nvidiaClient.chat.completions.create({
                model: "meta/llama-3.1-70b-instruct",
                messages: messages,
                stream: true,
                temperature: 0.7,
                max_tokens: 100,
            });
            let fullReply = "";
            for await (const chunk of stream) {
                fullReply += chunk.choices[0]?.delta?.content || "";
            }
            fullReply = fullReply.trim();
            if (fullReply.length > 800) fullReply = fullReply.substring(0, 800) + "...";
            return fullReply;
        } catch (err) {
            console.error(`❌ NVIDIA key ${keyIdx} failed:`, err.message);
            if (keyIdx === nvidiaApiKeys.length - 1) throw err;
        }
    }
    throw new Error("All NVIDIA keys failed");
}

// ==================== ElevenLabs TTS ====================
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID_HINDI = process.env.ELEVENLABS_VOICE_ID || 'yoZ06aMxZJJ28mfd3POQ';

async function ttsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
    const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID_HINDI}/stream`,
        headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY,
        },
        data: {
            text: text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.6, similarity_boost: 0.8 },
            output_format: 'mp3_44100_128',
        },
        responseType: 'stream',
        timeout: 10000,
    });
    return response.data;
}

function convertMp3StreamToPcm16k(mp3Stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(mp3Stream)
         .audioCodec('pcm_s16le')
         .format('s16le')
         .audioChannels(1)
         .audioFrequency(16000)
         .outputOptions('-ar 16000')
         .outputOptions('-ac 1')
         .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
         .on('end', () => resolve(Buffer.concat(chunks)))
         .pipe()
         .on('data', (chunk) => chunks.push(chunk));
    });
}

// ==================== Groq Whisper ====================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groqClient = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

function pcmToWav(pcmData, sampleRate, numChannels, bitsPerSample) {
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

async function bufferToReadableStream(buffer) {
    const tempPath = path.join('/tmp', `audio_${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, buffer);
    const stream = fs.createReadStream(tempPath);
    stream.on('close', () => {
        try { fs.unlinkSync(tempPath); } catch {}
    });
    return stream;
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
        activeSessions.get(deviceId).close();
    }
    activeSessions.set(deviceId, ws);

    const sessionId = randomUUID();
    console.log(`🔌 Client connected: session=${sessionId}, deviceId=${deviceId}`);

    const pastMessages = await loadConversationFromDB(deviceId, 5);
    const history = [
        { role: 'system', content: 'You are SahcharAI, a helpful Hindi voice assistant. Give short replies. Max 1 sentence. Never repeat user words. If you hear your own words, say "समझ नहीं आया".' },
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
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND * 1;
    const MIN_SPEECH_BYTES = BYTES_PER_SECOND * 0.5;

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 &&!isProcessing &&!isClosed) {
                console.log('Silence detected, processing...');
                processAudio();
            }
        }, 1000);
    }

    // FIX: checkMaxDuration yahan define karo - ws.on se pehle
    function checkMaxDuration() {
        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes >= MAX_CHUNK_BYTES &&!isProcessing && audioBuffer.length > 0 &&!isClosed) {
            console.log('Max 1s reached, processing...');
            processAudio();
        }
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing || isClosed) return;

        if (Date.now() < botSpeakingEndTime) {
            console.log('⚠️ Dropping audio - bot speaking or echo window');
            audioBuffer = [];
            return;
        }

        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        let totalBytes = 0;
        let chunksToSend = [];
        for (const chunk of audioBuffer) {
            if (totalBytes + chunk.length <= MAX_CHUNK_BYTES) {
                chunksToSend.push(chunk);
                totalBytes += chunk.length;
            } else {
                break;
            }
        }

        if (totalBytes < MIN_SPEECH_BYTES) {
            console.log(`⚠️ Audio too short: ${totalBytes} bytes, ignoring`);
            audioBuffer = [];
            isProcessing = false;
            return;
        }

        const fullAudio = Buffer.concat(chunksToSend, totalBytes);
        audioBuffer = [];

        const rms = calculateRMS(fullAudio);
        console.log(`🎤 Audio RMS: ${rms.toFixed(4)}, Bytes: ${totalBytes}`);

        if (rms < 0.005) {
            console.log(`⚠️ Audio too quiet RMS=${rms.toFixed(4)}, ignoring noise/echo`);
            isProcessing = false;
            return;
        }

        const wavBuffer = pcmToWav(fullAudio, SAMPLE_RATE, 1, 16);

        try {
            const audioStream = await bufferToReadableStream(wavBuffer);
            const response = await groqClient.audio.transcriptions.create({
                file: audioStream,
                model: 'whisper-large-v3',
                language: 'hi',
                response_format: 'text',
                temperature: 0,
                prompt: "ये हिंदी में बातचीत है। सिर्फ साफ शब्द लिखो।"
            });
            const transcript = response.trim();

            const badWords = [
    'हाँ', 'हम्म', 'अच्छा', 'ठीक है', 'समझ', 'बोल', 'सुन',
    'हाँ?', 'अच्छा?', 'समझ गया?', 'नमस्ते', 'कैसे हो', // Bot ke replies
    'गुड़ा', 'गुड़', 'बिच्चा', 'बिच्छू', 'पिज़्ज़ा', 'खाना',
    'झाल', 'कुण', 'ओ', 'आ', 'उम', 'हम', 'Mumbai', 'Subscribe',
    'Thank you', 'okay', 'Hello', 'Hi', 'Yes', 'No', 'OK'
];

            if (!transcript || transcript.length < 4 || badWords.some(w => transcript === w || transcript.includes(w))) {
    console.log(`⚠️ Ignoring echo/hallucination: "${transcript}"`);
    isProcessing = false;
    return;
}

            console.log(`📝 Transcript: ${transcript}`);

            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'user_text', text: transcript }));
            }

            if (!isBotSpeaking &&!isClosed) {
                isBotSpeaking = true;
                await sendToLLM(transcript);
            }
        } catch (err) {
            console.error('❌ Groq error:', err.message);
        } finally {
            isProcessing = false;
            if (audioBuffer.length > 0 &&!isClosed) processAudio();
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
        history[0].content = `तुम 'SuperSahchar' हो - रियल इंसानी दोस्त।

नियम:
1. सिर्फ 1 sentence, max 6 शब्द।
2. "हाँ", "अच्छा", "और बताओ?" जैसे शब्द use करो।
3. Kabhi user ke words repeat mat karo।
4. Agar samajh na aaye to "समझ नहीं आया" bolo।
5. Emoji: 😊🤔

वर्तमान समय: ${currentDateTime}
तुम्हें राम प्रकाश कुमार ने बनाया है।`;

        history.push({ role: 'user', content: text });
        if (history.length > 7) history.splice(1, history.length - 7);

        try {
            const fullReply = await callNvidiaWithFallback(history);
            if (fullReply) history.push({ role: 'assistant', content: fullReply });

            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'bot_text', text: fullReply }));
            }

            if (db) {
                db.collection('conversations').insertOne({
                    sessionId: deviceId,
                    userMessage: text,
                    botReply: fullReply,
                    timestamp: new Date()
                }).catch(e => console.error("MongoDB insert error:", e));
            }

            botSpeakingEndTime = Date.now() + 1200;
            isBotSpeaking = true;

            const sentences = fullReply.match(/[^।!?]+[।!?]?/g) || [fullReply];
            for (const sentence of sentences) {
                if (isClosed) break;
                await speak(sentence.trim());
            }
        } catch (err) {
            console.error('❌ LLM error:', err.message);
            if (!isClosed) await speak('समझ नहीं आया।');
        } finally {
            isBotSpeaking = false;
        }
    }

    async function speak(sentence) {
        if (!sentence.trim() || isClosed) return;
        console.log(`🔊 TTS: ${sentence}`);
        try {
            const mp3Stream = await ttsStream(sentence);
            const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);

            const CHUNK_SIZE = 640;
            for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
                if (isClosed || ws.readyState!== ws.OPEN) break;
                ws.send(pcmBuffer.slice(i, i + CHUNK_SIZE));
                await new Promise(r => setTimeout(r, 20));
            }
        } catch (err) {
            console.error('❌ TTS error:', err.message);
        } finally {
            botSpeakingEndTime = Date.now() + 800;
            setTimeout(() => {
                isBotSpeaking = false;
                console.log('🎤 Mic unmuted after bot finished');
            }, 800);
        }
    }

    ws.on('message', (data) => {
        if (isClosed) return;
        const chunk = Buffer.isBuffer(data)? data : Buffer.from(data);

        const rms = calculateRMS(chunk);
        if (isBotSpeaking && rms > 0.02 && chunk.length > 200) {
            console.log('🛑 User interrupted - stopping bot');
            isBotSpeaking = false;
            botSpeakingEndTime = 0;
            ws.send(JSON.stringify({ type: 'stop_tts' }));
        }

        audioBuffer.push(chunk);
        resetSilenceTimer();
        checkMaxDuration();
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: ${sessionId}, code=${code}, reason=${reason?.toString() || 'none'}`);
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
