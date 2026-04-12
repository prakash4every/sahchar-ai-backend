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

// NVIDIA NIM - Fast model
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// Fix 1: ElevenLabs - Use Rachel (free & stable) + better error handling
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel - always free

async function ttsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
    try {
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
                model_id: 'eleven_turbo_v2', // Fix 2: Fastest model
                voice_settings: { stability: 0.5, similarity_boost: 0.5 },
                output_format: 'mp3_44100_128',
            },
            responseType: 'stream',
            timeout: 10000,
        });
        return response.data;
    } catch (err) {
        // Fix 3: Log full error for debugging
        console.error('ElevenLabs API Error:', err.response?.status, err.response?.data || err.message);
        throw err;
    }
}

// MP3 stream -> PCM 16kHz mono s16le Buffer
function convertMp3StreamToPcm16k(mp3Stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(mp3Stream)
       .audioCodec('pcm_s16le')
       .format('s16le')
       .audioChannels(1)
       .audioFrequency(16000)
       .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
       .on('end', () => resolve(Buffer.concat(chunks)))
       .pipe()
       .on('data', (chunk) => chunks.push(chunk));
    });
}

// Groq Whisper
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

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let accumulatedText = '';
    let silenceTimer = null;
    let isClosed = false;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2;
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND / 4; // 0.25 seconds

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 &&!isProcessing &&!isClosed) {
                console.log('Silence detected, processing...');
                processAudio();
            }
        }, 600);
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
        let chunksToSend = [];
        for (const chunk of audioBuffer) {
            if (totalBytes + chunk.length <= MAX_CHUNK_BYTES) {
                chunksToSend.push(chunk);
                totalBytes += chunk.length;
            } else {
                const remaining = MAX_CHUNK_BYTES - totalBytes;
                if (remaining > 0) chunksToSend.push(chunk.slice(0, remaining));
                break;
            }
        }

        let processedBytes = 0;
        const newBuffer = [];
        for (const chunk of audioBuffer) {
            if (processedBytes + chunk.length <= totalBytes) {
                processedBytes += chunk.length;
                continue;
            } else {
                const remaining = chunk.length - (totalBytes - processedBytes);
                if (remaining > 0) newBuffer.push(chunk.slice(-remaining));
                break;
            }
        }
        audioBuffer = newBuffer;

        const fullAudio = Buffer.concat(chunksToSend, totalBytes);
        const wavBuffer = pcmToWav(fullAudio, SAMPLE_RATE, 1, 16);

        try {
            const audioStream = await bufferToReadableStream(wavBuffer);
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
                if (!isBotSpeaking &&!isClosed) {
                    isBotSpeaking = true;
                    await sendToLLM(accumulatedText.trim());
                    accumulatedText = '';
                }
            } else if (!isBotSpeaking &&!isClosed) {
                await speak('हाँ');
            }
        } catch (err) {
            console.error('❌ Groq error:', err.message);
            if (!isBotSpeaking &&!isClosed) {
                await speak('क्षमा करें, फिर से बोलें।');
            }
        } finally {
            isProcessing = false;
            if (audioBuffer.length > 0 &&!isClosed) processAudio();
        }
    }

    async function sendToLLM(text) {
        if (isClosed) return;
        console.log(`🤖 LLM: ${text}`);
        try {
            const messages = [
                { role: 'system', content: 'You are a friendly human. Interject with "haan", "achha", "hmm". Give short Hindi responses. Max 2 sentences.' },
                { role: 'user', content: text }
            ];
            const stream = await nvidiaClient.chat.completions.create({
                model: 'meta/llama-3.1-70b-instruct',
                messages: messages,
                stream: true,
                temperature: 0.9,
                max_tokens: 100,
            });
            let buffer = '';
            for await (const chunk of stream) {
                if (isClosed) break;
                const token = chunk.choices[0]?.delta?.content || '';
                buffer += token;
                if (token.match(/[।!?]/) || buffer.length > 40 || token.match(/(हाँ|अच्छा|हम्म)/)) {
                    await speak(buffer);
                    buffer = '';
                }
            }
            if (buffer &&!isClosed) await speak(buffer);
        } catch (err) {
            console.error('❌ LLM error:', err.message);
            if (!isClosed) await speak('मुझे समझ नहीं आया।');
        } finally {
            isBotSpeaking = false;
        }
    }

    async function speak(sentence) {
        if (!sentence.trim() || isClosed) return;
        console.log(`🔊 TTS: ${sentence}`);
        console.log('🔊 MP3 stream received from ElevenLabs'); 
        try {
            const mp3Stream = await ttsStream(sentence);
            const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);
            console.log(`🔊 PCM converted: ${pcmBuffer.length} bytes`);

            const CHUNK_SIZE = 320; // 20ms @ 16kHz 16-bit mono
            for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
                if (isClosed || ws.readyState!== ws.OPEN) break;
                const chunk = pcmBuffer.slice(i, i + CHUNK_SIZE);
                ws.send(chunk);
                await new Promise(r => setTimeout(r, 18));
            }
            console.log('🔊 PCM sent to client complete');
        } catch (err) {
            console.error('❌ TTS error:', err.message);
        }
    }

    ws.on('message', (data) => {
        if (isClosed) return;
        const chunk = Buffer.isBuffer(data)? data : Buffer.from(data);
        audioBuffer.push(chunk);
        resetSilenceTimer();
        checkMaxDuration();
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: code=${code}, reason=${reason?.toString() || 'none'}`);
        isClosed = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        audioBuffer = [];
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        isClosed = true;
    });
});
