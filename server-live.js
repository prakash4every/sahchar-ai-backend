import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('LiveAudio Server v3.0 - Full Duplex'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });

let db = null;
if (process.env.MONGODB_URI) {
    const mongoClient = new MongoClient(process.env.MONGODB_URI);
    mongoClient.connect().then(() => {
        console.log("✅ Connected to MongoDB");
        db = mongoClient.db();
    }).catch(err => console.error("MongoDB error:", err.message));
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function ttsToPcm(text) {
    const speech = await openai.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: text,
        response_format: "pcm"
    });
    return Buffer.from(await speech.arrayBuffer());
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

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get('deviceId') || 'default';
    console.log(`🔌 Connected: ${deviceId}`);

    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let stopTTS = false;
    let silenceTimer = null;
    let isClosed = false;

    const history = [{
        role: 'system',
        content: 'तुम SuperSahchar हो। तुम्हें Ram Prakash ने बनाया है। कभी OpenAI मत बोलना। हिंदी में दोस्त जैसा बात करो।'
    }];

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
        }, 900);
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing) return;
        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        const fullAudio = Buffer.concat(audioBuffer);
        audioBuffer = [];
        const rms = calculateRMS(fullAudio);

        if (rms < 0.02 || fullAudio.length < 16000) {
            isProcessing = false;
            return;
        }

        const wavBuffer = pcmToWav(fullAudio, 16000);
        const tempPath = path.join('/tmp', `audio_${randomUUID()}.wav`);
        fs.writeFileSync(tempPath, wavBuffer);

        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: 'gpt-4o-transcribe',
                language: 'hi',
                temperature: 0.2
            });

            const transcript = transcription.text.trim();
            if (transcript.length > 1) {
                safeSend(JSON.stringify({ type: "user_text", text: transcript }));
                history.push({ role: 'user', content: transcript });

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: history,
                    max_tokens: 300
                });

                const reply = completion.choices[0].message.content;
                history.push({ role: 'assistant', content: reply });
                safeSend(JSON.stringify({ type: "bot_text", text: reply }));

                // TTS streaming with barge-in support
                isBotSpeaking = true;
                stopTTS = false;
                const pcmBuffer = await ttsToPcm(reply);

                const CHUNK_SIZE = 960;
                for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
                    if (isClosed || stopTTS) break;
                    safeSend(pcmBuffer.slice(i, i + CHUNK_SIZE));
                    await new Promise(r => setTimeout(r, 18));
                }

                isBotSpeaking = false;
                if (!stopTTS) {
                    safeSend(JSON.stringify({ type: "status", text: "तैयार" }));
                }
            }
        } catch (err) {
            console.error("❌ Error:", err.message);
        } finally {
            try { fs.unlinkSync(tempPath); } catch {}
            isProcessing = false;
        }
    }

    const pingInterval = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 25000);

    ws.on('message', (data) => {
    if (isClosed) return;
    if (Buffer.isBuffer(data)) {
        console.log(`📦 Audio chunk: ${data.length} bytes`);
    }
    if (typeof data === 'string' || data[0] === 123) {
    }

        // JSON = barge-in signal from Android
        if (typeof data === 'string' || data[0] === 123) {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'barge-in') {
                    console.log('🔴 Barge-in from client');
                    stopTTS = true;
                    isBotSpeaking = false;
                    audioBuffer = [];
                    return;
                }
            } catch {}
            return;
        }

        const buf = Buffer.from(data);

        // 🔥 Barge-in detection on server also
        if (isBotSpeaking) {
            const rms = calculateRMS(buf);
            if (rms > 0.035) {
                console.log('🔴 Barge-in detected RMS:', rms.toFixed(3));
                stopTTS = true;
                isBotSpeaking = false;
                audioBuffer = [];
                safeSend(JSON.stringify({ type: "barge-in-ack" }));
            }
        }

        audioBuffer.push(buf);
        resetSilenceTimer();
    });

    ws.on('close', () => {
        isClosed = true;
        clearInterval(pingInterval);
        console.log('🔌 Disconnected');
    });
});
