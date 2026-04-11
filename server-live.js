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

app.get('/', (req, res) => res.send('Live AI server'));
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

// ---------- Deepgram Live ----------
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', async (ws) => {
    console.log('🔌 Client connected');
    let deepgramLive = null;
    let isUserSpeaking = false;
    let accumulatedText = '';
    let isBotSpeaking = false;
    let useEchoFallback = false;

    // Attempt to start Deepgram live transcription
    try {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'hi',
            smart_format: true,
            interim_results: true,
            endpointing: 500,
        });

        deepgramLive.on('open', () => {
            console.log('🎙️ Deepgram connection open');
        });

        deepgramLive.on('error', (err) => {
            console.error('❌ Deepgram error:', err);
            // If Deepgram fails, switch to echo mode for this client
            if (!useEchoFallback) {
                useEchoFallback = true;
                console.warn('⚠️ Falling back to echo mode (no AI)');
                ws.send(Buffer.from('🔇 Deepgram failed, echo mode only.'));
            }
        });

        deepgramLive.on('transcriptReceived', (data) => {
            if (useEchoFallback) return;
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
                    console.log('👤 User started, sending backchannel');
                    ttsStream('हाँ').then(stream => {
                        stream.on('data', chunk => ws.send(chunk));
                        stream.on('error', console.error);
                    }).catch(err => console.error('Backchannel TTS error:', err));
                }
            }
        });
    } catch (err) {
        console.error('❌ Failed to create Deepgram live client:', err);
        useEchoFallback = true;
        ws.send(Buffer.from('🔇 Deepgram init failed, echo mode only.'));
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
        }
    }

    // Handle incoming audio chunks
    ws.on('message', (data) => {
        if (useEchoFallback) {
            // Echo mode: send back exactly what we received
            ws.send(data);
            return;
        }
        if (deepgramLive && deepgramLive.readyState === 1) {
            deepgramLive.send(data);
        } else {
            console.warn('Deepgram not ready, dropping audio chunk');
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: code=${code}, reason=${reason?.toString() || 'none'}`);
        if (deepgramLive) deepgramLive.finish();
    });
});
