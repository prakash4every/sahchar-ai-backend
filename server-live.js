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

app.get('/', (req, res) => res.send('Live AI server (Groq Whisper)'));
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

// ---------- ElevenLabs TTS ----------
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

// ---------- Groq Whisper ----------
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

// ---------- WebSocket connection ----------
wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let audioBuffer = [];
    let lastChunkTime = Date.now();
    let isProcessing = false;
    let silenceTimer = null;
    let accumulatedTranscript = '';
    let isBotSpeaking = false;

    const SILENCE_MS = 500;           // shorter silence detection
    const MAX_BUFFER_MS = 8000;       // process after 8 seconds regardless
    const SAMPLE_RATE = 16000;
    const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit = 2 bytes

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0 && !isProcessing) {
                console.log('Silence detected, processing audio...');
                processAudio();
            }
        }, SILENCE_MS);
    }

    function checkMaxDuration() {
        const totalBytes = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        const durationMs = (totalBytes / BYTES_PER_SECOND) * 1000;
        if (durationMs >= MAX_BUFFER_MS && !isProcessing && audioBuffer.length > 0) {
            console.log(`Max buffer duration reached (${durationMs}ms), processing...`);
            processAudio();
        }
    }

    async function processAudio() {
        if (audioBuffer.length === 0 || isProcessing) return;
        isProcessing = true;
        if (silenceTimer) clearTimeout(silenceTimer);

        const totalLength = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        const fullAudio = Buffer.concat(audioBuffer, totalLength);
        audioBuffer = [];

        // Convert PCM to WAV
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
            // If error is due to size, try to split buffer (optional)
            if (err.message?.includes('message too large') && fullAudio.length > 200000) {
                console.log('Audio too large, splitting...');
                // Split into two halves and process recursively
                const half = Math.floor(fullAudio.length / 2);
                audioBuffer = [fullAudio.slice(0, half), fullAudio.slice(half)];
                processAudio(); // process first half
            }
        } finally {
            isProcessing = false;
            // Process any remaining audio that arrived during processing
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