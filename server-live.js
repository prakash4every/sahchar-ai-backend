import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import fs from 'fs';
import { Readable } from 'stream';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Live audio server'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });
console.log(`🎤 WebSocket server on ${PORT}`);

// ---------- NVIDIA NIM ----------
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ---------- ElevenLabs TTS (official SDK) ----------
const elevenlabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George" – good neutral English/Hindi voice
// You can change to any voice from the library

async function ttsStream(text) {
    // Generate audio as a readable stream
    const audioStream = await elevenlabs.textToSpeech.convert(VOICE_ID, {
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
        output_format: 'pcm_16000', // PCM 16kHz for Android
    });
    return audioStream; // returns a ReadableStream
}

// ---------- Groq Whisper ----------
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
    const tempPath = '/tmp/audio.wav';
    fs.writeFileSync(tempPath, buffer);
    return fs.createReadStream(tempPath);
}

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let accumulatedText = '';
    let silenceTimer = null;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2;
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND / 4; // 0.25 seconds

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 && !isProcessing) {
                console.log('Silence detected, processing...');
                processAudio();
            }
        }, 600);
    }

    function checkMaxDuration() {
        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes >= MAX_CHUNK_BYTES && !isProcessing && audioBuffer.length > 0) {
            console.log('Max 0.25s reached, processing...');
            processAudio();
        }
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing) return;
        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        // Take only up to MAX_CHUNK_BYTES
        let totalBytes = 0;
        let chunksToSend = [];
        for (const chunk of audioBuffer) {
            if (totalBytes + chunk.length <= MAX_CHUNK_BYTES) {
                chunksToSend.push(chunk);
                totalBytes += chunk.length;
            } else {
                const remaining = MAX_CHUNK_BYTES - totalBytes;
                chunksToSend.push(chunk.slice(0, remaining));
                totalBytes += remaining;
                break;
            }
        }
        // Remove processed bytes
        let processedBytes = 0;
        const newBuffer = [];
        for (const chunk of audioBuffer) {
            if (processedBytes + chunk.length <= totalBytes) {
                processedBytes += chunk.length;
                continue;
            } else {
                const remaining = chunk.length - (totalBytes - processedBytes);
                newBuffer.push(chunk.slice(-remaining));
                processedBytes = totalBytes;
            }
        }
        audioBuffer = newBuffer;

        const fullAudio = Buffer.concat(chunksToSend, totalBytes);
        const wavBuffer = pcmToWav(fullAudio, SAMPLE_RATE, 1, 16);
        const audioStream = await bufferToReadableStream(wavBuffer);

        try {
            const response = await groqClient.audio.transcriptions.create({
                file: audioStream,
                model: 'whisper-large-v3',
                language: 'hi',
                response_format: 'text',
            });
            const transcript = response.trim();
            if (transcript) {
                console.log(`📝 Transcript: ${transcript}`);
                accumulatedText += transcript + ' ';
                if (!isBotSpeaking) {
                    isBotSpeaking = true;
                    await sendToLLM(accumulatedText.trim());
                    accumulatedText = '';
                }
            } else if (!isBotSpeaking) {
                await speak('हाँ');
            }
        } catch (err) {
            console.error('❌ Groq error:', err.message);
            if (!isBotSpeaking) {
                await speak('क्षमा करें, फिर से बोलें।');
            }
        } finally {
            isProcessing = false;
            if (audioBuffer.length > 0) processAudio();
        }
    }

    async function sendToLLM(text) {
        console.log(`🤖 LLM: ${text}`);
        try {
            const messages = [
                { role: 'system', content: 'You are a friendly human. Interject with "haan", "achha", "hmm". Give short Hindi responses.' },
                { role: 'user', content: text }
            ];
            const stream = await nvidiaClient.chat.completions.create({
                model: 'z-ai/glm5',
                messages: messages,
                stream: true,
                temperature: 0.9,
                max_tokens: 300,
            });
            let buffer = '';
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content || '';
                buffer += token;
                if (token.match(/[।!?]/) || buffer.length > 40 || token.match(/(हाँ|अच्छा|हम्म)/)) {
                    await speak(buffer);
                    buffer = '';
                }
            }
            if (buffer) await speak(buffer);
        } catch (err) {
            console.error('❌ LLM error:', err.message);
            await speak('मुझे समझ नहीं आया।');
        } finally {
            isBotSpeaking = false;
        }
    }

    async function speak(sentence) {
        if (!sentence.trim()) return;
        console.log(`🔊 TTS: ${sentence}`);
        try {
            const stream = await ttsStream(sentence);
            // stream is a ReadableStream (Web API). Convert to Node.js readable stream.
            const nodeStream = Readable.fromWeb(stream);
            nodeStream.on('data', (chunk) => ws.send(chunk));
            nodeStream.on('error', (err) => console.error('TTS error:', err.message));
            await new Promise((resolve) => nodeStream.on('end', resolve));
        } catch (err) {
            console.error('❌ TTS error:', err.message);
            const silence = Buffer.alloc(320, 0);
            ws.send(silence);
        }
    }

    ws.on('message', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        audioBuffer.push(chunk);
        resetSilenceTimer();
        checkMaxDuration();
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: code=${code}, reason=${reason?.toString() || 'none'}`);
        if (silenceTimer) clearTimeout(silenceTimer);
        audioBuffer = [];
    });
});
