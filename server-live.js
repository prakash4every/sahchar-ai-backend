import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk'; // or use Groq
import axios from 'axios';
import { Readable } from 'stream';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// HTTP server (health check)
const httpPort = process.env.HTTP_PORT || 3001;
app.get('/health', (req, res) => res.send('Live audio server OK'));
const httpServer = app.listen(httpPort, () => console.log(`✅ HTTP health check on ${httpPort}`));

// WebSocket server
const wss = new WebSocketServer({ port: process.env.WS_PORT || 3002 });
console.log(`🎤 Live audio WebSocket server on port ${process.env.WS_PORT || 3002}`);

// ---------- NVIDIA NIM (streaming LLM) ----------
const nvidiaClient = new OpenAI({
    apiKey: process.env.NGC_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ---------- ElevenLabs streaming TTS ----------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // 'Rachel' – change if needed

async function* elevenlabsStream(text) {
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
        },
        responseType: 'stream',
    });
    const stream = response.data;
    for await (const chunk of stream) {
        yield chunk;
    }
}

// ---------- Groq Whisper streaming ASR (using WebSocket) ----------
// Groq does not directly support WebSocket streaming, but we can use Deepgram or Groq's non-streaming with small chunks.
// For simplicity, we'll use Deepgram's live transcription WebSocket (better for real-time).
// Install: npm install @deepgram/sdk

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ---------- WebSocket connection handler ----------
wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    let deepgramLive = null;
    let currentLlmStream = null;
    let isUserSpeaking = false;
    let accumulatedUserText = '';
    let botReplyBuffer = '';
    let ttsStreamActive = false;

    // 1. Start Deepgram live transcription
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
            // User finished a sentence
            accumulatedUserText += transcript + ' ';
            isUserSpeaking = false;
            // Send to LLM (streaming) when user stops speaking
            if (accumulatedUserText.trim().length > 0 && !ttsStreamActive) {
                sendToLLM(accumulatedUserText.trim());
                accumulatedUserText = '';
            }
        } else {
            // Interim result – we can optionally send back a "hmm" or "haan" using a separate small TTS
            if (!isUserSpeaking) {
                isUserSpeaking = true;
                // Immediately send a backchannel acknowledgement (optional)
                sendBackchannel('हाँ');
            }
        }
    });

    deepgramLive.on('error', (err) => console.error('Deepgram error:', err));

    // 2. Function to send backchannel (hmm, haan) instantly
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

    // 3. Function to send user text to NVIDIA NIM (streaming) and pipe to TTS
    async function sendToLLM(userText) {
        if (ttsStreamActive) return;
        ttsStreamActive = true;

        try {
            // Prepare messages (keep conversation history per session – we can extend with sessionId)
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
                // Split by punctuation or natural breaks
                if (token.match(/[।!?]/) || sentenceBuffer.length > 50) {
                    // Send this sentence to TTS
                    await speakSentence(sentenceBuffer);
                    sentenceBuffer = '';
                } else if (token.match(/(हाँ|अच्छा|हम्म|ठीक है)/)) {
                    // Backchannel token detected – send immediately as short audio
                    await speakSentence(token);
                }
            }
            if (sentenceBuffer.trim()) await speakSentence(sentenceBuffer);
        } catch (err) {
            console.error('LLM or TTS error:', err);
        } finally {
            ttsStreamActive = false;
            // After bot finishes, re-enable user speech detection (Deepgram already continues)
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

    // 4. Handle incoming audio chunks from client
    ws.on('message', (data) => {
        // Client sends raw PCM (16kHz, 16-bit, mono) chunks
        if (deepgramLive && deepgramLive.readyState === 1) {
            deepgramLive.send(data);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Client disconnected');
        if (deepgramLive) deepgramLive.finish();
        if (currentLlmStream) currentLlmStream.destroy?.();
    });
});
