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
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

async function ttsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
    const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
        headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY,
        },
        data: {
            text: text,
            model_id: 'eleven_turbo_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.5 },
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

// ==================== WebSocket Handler ====================
const sessionHistories = new Map();

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get('deviceId') || 'default';
    const sessionId = randomUUID();

    console.log(`🔌 Client connected: session=${sessionId}, deviceId=${deviceId}`);

    const pastMessages = await loadConversationFromDB(deviceId, 10);
    const history = [
        { role: 'system', content: 'You are SahcharAI, a helpful Hindi voice assistant. Give short replies. Max 2 sentences. Remember context. Behave like a friend. Never make up facts. If you don\'t understand, say "समझ नहीं आया".' },
       ...pastMessages
    ];
    sessionHistories.set(sessionId, history);

    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let silenceTimer = null;
    let isClosed = false;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2;
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND / 4;

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 &&!isProcessing &&!isClosed) {
                console.log('Silence detected, processing...');
                processAudio();
            }
        }, 800);
    }

    function checkMaxDuration() {
        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes >= MAX_CHUNK_BYTES &&!isProcessing && audioBuffer.length > 0 &&!isClosed) {
            console.log('Max 0.25s reached, processing...');
            processAudio();
        }
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing || isClosed) return;
        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        let totalBytes = 0;
        let
