import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
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

app.get('/', (req, res) => res.send('LiveAudio Server v2.2 - Fixed FFmpeg'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });

// ==================== MongoDB ====================
let db = null;
if (process.env.MONGODB_URI) {
    const mongoClient = new MongoClient(process.env.MONGODB_URI);
    mongoClient.connect().then(() => {
        console.log("✅ Connected to MongoDB");
        db = mongoClient.db();
    }).catch(err => console.error("MongoDB error:", err.message));
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==================== FIXED TTS ====================
async function ttsStream(text) {
    // Direct PCM 24kHz - NO FFmpeg needed
    const speech = await openai.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: text,
        response_format: "pcm"
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    return buffer; 
}
function pcmToWav(pcmData, sampleRate = 16000) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcmData.length, 40);
    return Buffer.concat([header, pcmData]);
}

function calculateRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i);
        sum += sample * sample;
    }
    return Math.sqrt(sum / (buffer.length / 2)) / 32768.0;
}

// ==================== WebSocket ====================
wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get('deviceId') || 'default';
    console.log(`🔌 Connected: ${deviceId}`);

    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let botSpeakingEndTime = 0;
    let silenceTimer = null;
    let isClosed = false;

    const history = [{ role: 'system', content: 'तुम SahcharAI हो। छोटा, दोस्ताना जवाब दो।' }];

    function safeSend(data) {
        if (!isClosed && ws.readyState === 1) {
            try { ws.send(data); return true; } catch { return false; }
        }
        return false;
    }

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 &&!isProcessing) processAudio();
        }, 700);
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing) return;
        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        const fullAudio = Buffer.concat(audioBuffer);
        audioBuffer = [];
        const rms = calculateRMS(fullAudio);

        console.log(`🎤 RMS: ${rms.toFixed(4)}, Bytes: ${fullAudio.length}`);

        // 🔥 FIX 2: RMS threshold बढ़ाया (0.008 → 0.015)
        if (rms < 0.015 || fullAudio.length < 12000) {
            console.log('⚠️ Too quiet/short');
            isProcessing = false;
            return;
        }

        const wavBuffer = pcmToWav(fullAudio);
        const tempPath = path.join('/tmp', `audio_${randomUUID()}.wav`);
        fs.writeFileSync(tempPath, wavBuffer);

        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: 'whisper-1',
                language: 'hi',
                temperature: 0
            });

            const transcript = transcription.text.trim();
            console.log(`📝 Transcript: ${transcript}`);

            if (transcript.length > 1 &&!transcript.includes('प्रस्तुत्र')) {
                safeSend(JSON.stringify({ type: "user_text", text: transcript }));

                history.push({ role: 'user', content: transcript });
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: history,
                    max_tokens: 60
                });

                const reply = completion.choices[0].message.content;
                console.log(`🤖 Reply: ${reply}`);
                history.push({ role: 'assistant', content: reply });

                safeSend(JSON.stringify({ type: "bot_text", text: reply }));

                // TTS
                isBotSpeaking = true;
                const mp3Stream = await ttsStream(reply);
                const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);

                // 🔥 FIX 3: Mic mute time कम
                botSpeakingEndTime = Date.now() + (pcmBuffer.length / 32);

                for (let i = 0; i < pcmBuffer.length; i += 640) {
                    if (isClosed) break;
                    safeSend(pcmBuffer.slice(i, i + 640));
                    await new Promise(r => setTimeout(r, 18));
                }

                setTimeout(() => {
                    isBotSpeaking = false;
                    safeSend(JSON.stringify({ type: "status", text: "सुनने के लिए तैयार" }));
                }, 500);
            }
        } catch (err) {
            console.error("❌ Error:", err.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch {}
            isProcessing = false;
        }
    }

    ws.on('message', (data) => {
        if (isClosed || isBotSpeaking || Date.now() < botSpeakingEndTime) return;
        audioBuffer.push(Buffer.from(data));
        resetSilenceTimer();
    });

    ws.on('close', () => { isClosed = true; console.log('🔌 Disconnected'); });
});
