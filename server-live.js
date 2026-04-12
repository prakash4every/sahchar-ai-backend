import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import axios from 'axios';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Live audio server (Deepgram)'));
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
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // English voice, works for Hindi too

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

// ---------- Deepgram Live Transcription ----------
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let deepgramLive = null;
    let isUserSpeaking = false;
    let accumulatedText = '';
    let isBotSpeaking = false;
    let audioBuffer = [];
    let deepgramReady = false;

    // Start Deepgram live
    try {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'hi',
            smart_format: true,
            interim_results: true,
            endpointing: 500,
        });

        deepgramLive.on('open', () => {
            console.log('🎙️ Deepgram open');
            deepgramReady = true;
            // Send any buffered audio
            for (const chunk of audioBuffer) deepgramLive.send(chunk);
            audioBuffer = [];
        });

        deepgramLive.on('error', (err) => {
            console.error('❌ Deepgram error:', err);
            deepgramReady = false;
            ws.send(Buffer.from('🔇 Transcription service error'));
        });

        deepgramLive.on('transcriptReceived', (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (!transcript) return;

            if (data.is_final) {
                accumulatedText += transcript + ' ';
                console.log(`📝 Final: ${accumulatedText}`);
                if (accumulatedText.trim() && !isBotSpeaking) {
                    isBotSpeaking = true;
                    sendToLLM(accumulatedText.trim());
                    accumulatedText = '';
                }
            } else {
                if (!isUserSpeaking) {
                    isUserSpeaking = true;
                    // Send backchannel "हाँ" immediately
                    ttsStream('हाँ').then(stream => {
                        stream.on('data', chunk => ws.send(chunk));
                        stream.on('error', console.error);
                    }).catch(err => console.error('Backchannel TTS error:', err));
                }
            }
        });
    } catch (err) {
        console.error('Failed to start Deepgram:', err);
        ws.close(1011, 'Deepgram initialization failed');
        return;
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
            // Send a short error message as PCM (simple beep or silence)
            const silence = Buffer.alloc(320, 0); // 20ms silence
            ws.send(silence);
        }
    }

    ws.on('message', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (deepgramReady && deepgramLive && deepgramLive.readyState === 1) {
            deepgramLive.send(chunk);
        } else {
            // Buffer audio until Deepgram is ready
            if (!deepgramReady) audioBuffer.push(chunk);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: code=${code}, reason=${reason?.toString() || 'none'}`);
        if (deepgramLive) deepgramLive.finish();
    });
});