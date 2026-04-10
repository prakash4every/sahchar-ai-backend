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

// HTTP health check (Render के लिए)
const httpPort = process.env.PORT || 3001;
app.get('/health', (req, res) => res.send('Live audio server OK'));
const httpServer = app.listen(httpPort, () => console.log(`✅ HTTP health check on ${httpPort}`));

// WebSocket server on same port? Actually Render needs separate port? We'll use process.env.PORT for both? Better to use same port for WebSocket.
// But WebSocketServer can listen on same port as HTTP server. So we'll reuse the same port.
const wss = new WebSocketServer({ server: httpServer });
console.log(`🎤 Live audio WebSocket server on port ${httpPort}`);

// ---------- NVIDIA NIM (streaming LLM) – uses NGC_API_KEY ----------
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ---------- ElevenLabs streaming TTS ----------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // 'Rachel' (English), but we can change to Hindi voice if needed

async function* elevenlabsStream(text) {
    if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing');
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
            output_format: 'pcm_16000',   // PCM 16kHz for better compatibility
        },
        responseType: 'stream',
    });
    const stream = response.data;
    for await (const chunk of stream) {
        yield chunk;
    }
}

// ---------- Deepgram live transcription ----------
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ---------- WebSocket connection handler ----------
wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let deepgramLive = null;
    let isUserSpeaking = false;
    let accumulatedUserText = '';
    let ttsStreamActive = false;

    // Start Deepgram live transcription
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

    deepgramLive.on('transcriptReceived', (data) => {
        const transcript = data.channel.alternatives[0].transcript;
        if (!transcript) return;

        if (data.is_final) {
            accumulatedUserText += transcript + ' ';
            isUserSpeaking = false;
            if (accumulatedUserText.trim().length > 0 && !ttsStreamActive) {
                sendToLLM(accumulatedUserText.trim());
                accumulatedUserText = '';
            }
        } else {
            if (!isUserSpeaking) {
                isUserSpeaking = true;
                sendBackchannel('हाँ');
            }
        }
    });

    deepgramLive.on('error', (err) => console.error('Deepgram error:', err));

    async function sendBackchannel(word) {
        try {
            const audioStream = await elevenlabsStream(word);
            for await (const chunk of audioStream) {
                ws.send(chunk);
            }
        } catch (err) {
            console.error('Backchannel TTS error:', err);
        }
    }

    async function sendToLLM(userText) {
        if (ttsStreamActive) return;
        ttsStreamActive = true;

        try {
            const messages = [
                { role: 'system', content: `तुम एक इंसानी दोस्त हो। जब दूसरा व्यक्ति बोल रहा हो, तो बीच-बीच में 'हाँ', 'अच्छा', 'हम्म', 'ठीक है' बोलते रहो। जब वह रुक जाए, तो पूरा जवाब दो। अपने जवाब को छोटे-छोटे वाक्यों में तोड़ो ताकि हम तुरंत बोल सकें।` },
                { role: 'user', content: userText }
            ];

            const stream = await nvidiaClient.chat.completions.create({
                model: 'z-ai/glm5',
                messages: messages,
                stream: true,
                temperature: 1.0,
                max_tokens: 500,
            });

            let sentenceBuffer = '';
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content || '';
                sentenceBuffer += token;
                if (token.match(/[।!?]/) || sentenceBuffer.length > 50) {
                    await speakSentence(sentenceBuffer);
                    sentenceBuffer = '';
                } else if (token.match(/(हाँ|अच्छा|हम्म|ठीक है)/)) {
                    await speakSentence(token);
                }
            }
            if (sentenceBuffer.trim()) await speakSentence(sentenceBuffer);
        } catch (err) {
            console.error('LLM or TTS error:', err);
        } finally {
            ttsStreamActive = false;
        }
    }

    async function speakSentence(sentence) {
        if (!sentence.trim()) return;
        try {
            const audioStream = await elevenlabsStream(sentence);
            for await (const chunk of audioStream) {
                ws.send(chunk);
            }
        } catch (err) {
            console.error('Sentence TTS error:', err);
        }
    }

    ws.on('message', (data) => {
        if (deepgramLive && deepgramLive.readyState === 1) {
            deepgramLive.send(data);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Client disconnected');
        if (deepgramLive) deepgramLive.finish();
    });
});

// No separate PORT for WebSocket; using the same HTTP port.
console.log(`WebSocket server running on same port ${httpPort}`);