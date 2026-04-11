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

// Simple root endpoint to verify server is running
app.get('/', (req, res) => res.send('Live audio server is running'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`✅ HTTP server listening on ${PORT}`);
});

// WebSocket server attached to the same HTTP server
const wss = new WebSocketServer({ server });
console.log(`🎤 WebSocket server running on port ${PORT}`);

// NVIDIA NIM (uses NGC_API_KEY)
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ElevenLabs TTS
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

async function* elevenlabsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
    const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        headers: {
            'Accept': 'audio/mpeg',
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

// Deepgram live transcription
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let deepgramLive = null;
    let accumulatedText = '';
    let ttsActive = false;
    let userSpeaking = false;

    deepgramLive = deepgram.listen.live({
        model: 'nova-2',
        language: 'hi',
        smart_format: true,
        interim_results: true,
        endpointing: 500,
    });

    deepgramLive.on('open', () => console.log('🎙️ Deepgram open'));
    deepgramLive.on('transcriptReceived', (data) => {
        const transcript = data.channel.alternatives[0].transcript;
        if (!transcript) return;
        if (data.is_final) {
            accumulatedText += transcript + ' ';
            userSpeaking = false;
            if (accumulatedText.trim() && !ttsActive) {
                sendToLLM(accumulatedText.trim());
                accumulatedText = '';
            }
        } else {
            if (!userSpeaking) {
                userSpeaking = true;
                sendBackchannel('हाँ');
            }
        }
    });
    deepgramLive.on('error', (err) => console.error('Deepgram error:', err));

    async function sendBackchannel(word) {
        try {
            const stream = await elevenlabsStream(word);
            for await (const chunk of stream) {
                ws.send(chunk);
            }
        } catch (err) {
            console.error('Backchannel error:', err);
        }
    }

    async function sendToLLM(text) {
        if (ttsActive) return;
        ttsActive = true;
        try {
            const messages = [
                { role: 'system', content: 'You are a friendly human. While the user speaks, interject with "haan", "achha", "hmm". When user pauses, give short responses in Hindi.' },
                { role: 'user', content: text }
            ];
            const stream = await nvidiaClient.chat.completions.create({
                model: 'z-ai/glm5',
                messages: messages,
                stream: true,
                temperature: 1.0,
                max_tokens: 500,
            });
            let buffer = '';
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content || '';
                buffer += token;
                if (token.match(/[।!?]/) || buffer.length > 50) {
                    await speak(buffer);
                    buffer = '';
                } else if (token.match(/(हाँ|अच्छा|हम्म|ठीक है)/)) {
                    await speak(token);
                }
            }
            if (buffer) await speak(buffer);
        } catch (err) {
            console.error('LLM error:', err);
        } finally {
            ttsActive = false;
        }
    }

    async function speak(sentence) {
        if (!sentence.trim()) return;
        try {
            const stream = await elevenlabsStream(sentence);
            for await (const chunk of stream) {
                ws.send(chunk);
            }
        } catch (err) {
            console.error('TTS error:', err);
        }
    }

    ws.on('message', (data) => {
        if (deepgramLive && deepgramLive.readyState === 1) {
            deepgramLive.send(data);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (deepgramLive) deepgramLive.finish();
    });
});
