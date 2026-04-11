import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Live audio server (Groq)'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });
console.log(`🎤 WebSocket server on ${PORT}`);

// NVIDIA NIM
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ElevenLabs TTS
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

async function ttsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
    const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
        headers: {
            'Accept': 'audio/pcm',
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY,
        },
        data: {
            text: text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: { stability: 0.5, similarity_boost: 0.5 },
            output_format: 'pcm_16000',
        },
        responseType: 'stream',
    });
    return response.data;
}

// Groq Whisper
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groqClient = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

// PCM to WAV converter
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

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let audioBuffer = [];
    let isProcessing = false;
    let accumulatedTranscript = '';
    let isBotSpeaking = false;
    let silenceTimer = null;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit
    const MAX_CHUNK_BYTES = BYTES_PER_SECOND; // 1 second exactly

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 && !isProcessing) {
                console.log('Silence detected, processing audio...');
                processAudio();
            }
        }, 800);
    }

    function checkMaxDuration() {
        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes >= MAX_CHUNK_BYTES && !isProcessing && audioBuffer.length > 0) {
            console.log(`Max buffer reached (1s), processing...`);
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
        const audioBase64 = wavBuffer.toString('base64');

        try {
            const response = await groqClient.audio.transcriptions.create({
                file: Buffer.from(audioBase64, 'base64'),
                model: 'whisper-large-v3',
                language: 'hi',
                response_format: 'text',
            });
            const transcript = response.trim();
            if (transcript) {
                console.log(`📝 Transcript: ${transcript}`);
                accumulatedTranscript += transcript + ' ';
                if (!isBotSpeaking) {
                    isBotSpeaking = true;
                    await sendToLLM(accumulatedTranscript.trim());
                    accumulatedTranscript = '';
                }
            }
        } catch (err) {
            console.error('❌ Groq error:', err);
            // If still too large, fallback to echo
            ws.send(Buffer.from('🔇 Transcription failed, echo mode'));
            // Echo back the audio (simple fallback)
            ws.send(fullAudio);
        } finally {
            isProcessing = false;
            if (audioBuffer.length > 0) processAudio();
        }
    }

    async function sendToLLM(text) {
        console.log(`🤖 LLM request: ${text}`);
        try {
            const messages = [
                { role: 'system', content: 'You are a friendly human. Interject with "haan", "achha", "hmm" while user speaks. When user pauses, give short responses in Hindi.' },
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
            console.error('❌ LLM error:', err);
            await speak('मुझे समझ नहीं आया, कृपया फिर से बोलें।');
        } finally {
            isBotSpeaking = false;
            accumulatedTranscript = '';
        }
    }

    async function speak(sentence) {
        if (!sentence.trim()) return;
        console.log(`🔊 TTS: ${sentence}`);
        try {
            const stream = await ttsStream(sentence);
            stream.on('data', (chunk) => ws.send(chunk));
            stream.on('error', (err) => console.error('TTS stream error:', err));
            await new Promise((resolve) => stream.on('end', resolve));
        } catch (err) {
            console.error('❌ TTS error:', err);
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