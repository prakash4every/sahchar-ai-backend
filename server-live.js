// ============================================================
// 🤖 SAHCHAR AI - FIXED server-live.js v7.1
// ============================================================

import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { Blob } from 'buffer';
import axios from 'axios';
import FormData from 'form-data';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const MONGODB_URI =
  process.env.MONGODB_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGOBD_URL ||
  process.env.MONGODB_URI_LIVE ||
  'mongodb://localhost:27017';

const DB_NAME = 'sahchar_live';
const COLLECTION_NAME = 'conversations';

let db = null;
let conversationsCollection = null;
let mongoClient = null;

const providers = {
  groq: {
    name: 'Groq',
    key: process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    chat: true,
    whisper: true
  },
  openai: {
    name: 'OpenAI',
    key: process.env.OPENAI_API_KEY,
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    chat: true,
    whisper: true
  },
  serpapi: {
    key: process.env.SERPAPI_API_KEY
  }
};

async function smartSearch(query) {
    if (!providers.serpapi.key) return null;
    try {
        console.log(`🔍 Searching web for: "${query}"...`);
        const response = await axios.get('https://serpapi.com/search', {
            params: {
                api_key: providers.serpapi.key,
                engine: 'google',
                q: query,
                google_domain: 'google.co.in',
                gl: 'in',
                hl: 'hi'
            },
            timeout: 10000
        });

        const results = response.data.organic_results?.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n');
        const answerBox = response.data.answer_box?.answer || response.data.answer_box?.snippet;
        const knowledgeGraph = response.data.knowledge_graph?.description;

        const finalContext = [answerBox, knowledgeGraph, results].filter(Boolean).join('\n\n');
        console.log(`✅ Search successful! (Results length: ${finalContext.length})`);
        return finalContext || "No clear results found.";
    } catch (error) {
        console.error('❌ SerpApi search failed:', error.message);
        return null;
    }
}

async function smartChat(messages) {
    const orderedProviders = ['groq', 'openai'];

    // Define tools for the model
    const tools = [
        {
            type: "function",
            function: {
                name: "search_web",
                description: "Search Google for current events, facts, or real-time information that you don't know.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query" }
                    },
                    required: ["query"]
                }
            }
        }
    ];

    for (const providerName of orderedProviders) {
        const provider = providers[providerName];
        if (!provider || !provider.key || !provider.chat) continue;
        try {
            console.log(`🔄 Trying ${providerName}...`);

            // First attempt to see if tool call is needed
            let response = await axios.post(
                provider.url,
                {
                    model: provider.model,
                    messages,
                    tools: tools,
                    tool_choice: "auto",
                    max_tokens: 300,
                    temperature: 0.5
                },
                { headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            );

            let message = response.data.choices?.[0]?.message;

            // Handle Tool Calls (Search)
            if (message?.tool_calls) {
                const toolCall = message.tool_calls[0];
                if (toolCall.function.name === "search_web") {
                    const query = JSON.parse(toolCall.function.arguments).query;
                    const searchResult = await smartSearch(query);

                    if (searchResult) {
                        // Add tool result to history and call again
                        const newMessages = [
                            ...messages,
                            message,
                            {
                                role: "tool",
                                tool_call_id: toolCall.id,
                                name: "search_web",
                                content: searchResult
                            }
                        ];

                        console.log(`🔄 Getting final response from ${providerName} with search data...`);
                        response = await axios.post(
                            provider.url,
                            { model: provider.model, messages: newMessages, max_tokens: 300, temperature: 0.5 },
                            { headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, timeout: 15000 }
                        );
                        message = response.data.choices?.[0]?.message;
                    }
                }
            }

            const reply = message?.content;
            if (reply) {
                console.log(`✅ ${providerName} success!`);
                return { reply: reply.trim(), provider: provider.name };
            }
        } catch (error) {
            console.error(`❌ ${providerName} failed:`, error.message);
            if (error.response?.data) console.error(JSON.stringify(error.response.data));
        }
    }
    return null;
}

async function smartTranscription(fileObject) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
        try {
            console.log('🔄 Transcribing with Groq Whisper...');
            const audioBuffer = await fileObject.arrayBuffer();
            const buffer = Buffer.from(audioBuffer);
            const formData = new FormData();
            formData.append('file', buffer, { filename: 'speech.wav', contentType: 'audio/wav' });
            formData.append('model', 'whisper-large-v3-turbo');
            formData.append('language', 'hi');
            formData.append('prompt', 'SahcharAI, नमस्ते, आप कैसे हैं? बातचीत हिंदी में है।'); // Help Whisper stay in context
            formData.append('response_format', 'json');
            const response = await axios.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                formData,
                { headers: { 'Authorization': `Bearer ${groqKey}`, ...formData.getHeaders() }, timeout: 30000 }
            );
            const text = response.data.text;
            console.log(`✅ Groq Transcription: ${text}`);
            return text;
        } catch (error) { console.error('❌ Groq Whisper failed:', error.message); }
    }
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            console.log('🔄 Transcribing with OpenAI Whisper...');
            const audioBuffer = await fileObject.arrayBuffer();
            const buffer = Buffer.from(audioBuffer);
            const formData = new FormData();
            formData.append('file', buffer, { filename: 'speech.wav', contentType: 'audio/wav' });
            formData.append('model', 'whisper-1');
            formData.append('language', 'hi');
            const response = await axios.post(
                'https://api.openai.com/v1/audio/transcriptions',
                formData,
                { headers: { 'Authorization': `Bearer ${openaiKey}`, ...formData.getHeaders() }, timeout: 30000 }
            );
            const text = response.data.text;
            console.log(`✅ OpenAI Transcription: ${text}`);
            return text;
        } catch (error) { console.error('❌ OpenAI Whisper failed:', error.message); }
    }
    return null;
}

async function smartTTS(text) {
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    if (elevenLabsKey) {
        try {
            console.log(`🔄 Generating TTS for: "${text.substring(0, 30)}..."`);
            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
                {
                    text: text,
                    model_id: 'eleven_multilingual_v2',
                    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 }
                },
                { headers: { 'xi-api-key': elevenLabsKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
            );

            let pcmData = Buffer.from(response.data);

            // ✅ Check if it's a small JSON error instead of audio
            if (pcmData.length < 1000 && pcmData.toString().includes('"detail"')) {
                console.error('❌ ElevenLabs JSON Error:', pcmData.toString());
                return null;
            }

            // ✅ Strip WAV header if present
            if (pcmData.length > 44 && pcmData.slice(0, 4).toString() === 'RIFF') {
                console.log("⚠️ WAV header detected in TTS, stripping 44 bytes");
                pcmData = pcmData.slice(44);
            }

            console.log(`✅ TTS generated: ${pcmData.length} bytes PCM`);
            return pcmData;
        } catch (error) {
            if (error.response && error.response.data) {
                try {
                    const errorText = Buffer.from(error.response.data).toString();
                    console.error('❌ ElevenLabs API error response:', errorText);
                } catch (e) {
                    console.error('❌ ElevenLabs API error (buffer fail)');
                }
            } else {
                console.error('❌ ElevenLabs TTS failed:', error.message);
            }
        }
    }
    return null;
}

async function connectMongoDB() {
    if (!MONGODB_URI) { console.log('⚠️ No MongoDB URI found'); return; }
    try {
        console.log('🔄 Connecting to MongoDB...');
        mongoClient = new MongoClient(MONGODB_URI, { connectTimeoutMS: 5000, socketTimeoutMS: 45000, serverSelectionTimeoutMS: 5000 });
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        conversationsCollection = db.collection(COLLECTION_NAME);
        console.log('✅ MongoDB connected successfully!');
    } catch (error) { console.error('❌ MongoDB connection error:', error.message); }
}

async function getConversationHistory(deviceId, limit = 5) {
    if (!conversationsCollection || !deviceId) return [];
    try {
        const history = await conversationsCollection.find({ deviceId: deviceId.trim() }).sort({ timestamp: -1 }).limit(limit).toArray();
        return history.reverse().map(msg => ({ role: msg.role, content: msg.content }));
    } catch (error) { return []; }
}

async function saveConversation(deviceId, role, content) {
    if (!conversationsCollection || !deviceId) return;
    try { await conversationsCollection.insertOne({ deviceId: deviceId.trim(), role, content, timestamp: new Date() }); } catch (error) {}
}

function cleanTranscript(rawText) {
    if (!rawText) return "";
    let text = rawText.trim();
    if (!text) return "";
    const lowerText = text.toLowerCase();
    if (lowerText.includes("hvað") || lowerText.includes("þau") || lowerText.includes("árrvík") || lowerText.includes("kannski")) {
        console.log("⚠️ Icelandic filtered");
        return "";
    }
    const leaks = ["आम बोलचाल", "दोस्त की बातचीत", "प्रस्तु", "परवारण", "धन्यवाद", "सब्सक्राइब", "झाल झाल", "झाल", "वेतवार", "पुल्प्लेज", "चुटरा"];
    if (leaks.some(leak => lowerText.includes(leak))) {
        console.log(`⚠️ Noise/Filler filtered: "${text}"`);
        return "";
    }
    const words = text.split(/\s+/);
    if (words.length >= 3 && new Set(words).size === 1) return "";
    if (text.replace(/[।,.!?]/g, '').trim().length < 1) return "";
    return text;
}

await connectMongoDB();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Live Audio Server v7.2 running on port ${PORT}`);
    console.log(`🔑 GROQ: ${process.env.GROQ_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 OPENAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 ELEVENLABS: ${process.env.ELEVENLABS_API_KEY ? '✅' : '❌'}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    if (socket.destroyed) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
        if (ws.readyState === ws.OPEN) wss.emit('connection', ws, request);
        else ws.terminate();
    });
});

app.get('/', (req, res) => res.send('Sahchar Live Ready'));
app.get('/health', (req, res) => res.json({ status: 'ok', mongodb: !!conversationsCollection, providers: { groq: !!process.env.GROQ_API_KEY, openai: !!process.env.OPENAI_API_KEY, elevenlabs: !!process.env.ELEVENLABS_API_KEY } }));

function calculateRMS(pcmBuffer) {
    let sum = 0;
    const count = pcmBuffer.length / 2;
    if (count === 0) return 0;
    for (let i = 0; i < pcmBuffer.length; i += 2) {
        const sample = pcmBuffer.readInt16LE(i);
        sum += sample * sample;
    }
    return Math.sqrt(sum / count) / 32768.0;
}

function pcmToWav(pcm, rate = 16000) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let deviceId = url.searchParams.get('deviceId') || "default_user";
    const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
    console.log(`🔌 Client connected: ${connectionId}`);

    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let isClosing = false;
    let silenceChunks = 0;
    const SILENCE_THRESHOLD = 0.008; // More sensitive to actual speech
    const REQUIRED_SILENCE_CHUNKS = 45; // ~0.9 seconds of silence to ensure user finished

    const safeSend = (data, isBinary = false) => {
        if (ws.readyState === 1 && !isClosing) {
            try { ws.send(data, { binary: isBinary }); return true; } catch (e) { return false; }
        }
        return false;
    };

    // ✅ Keep-alive heartbeat
    const heartbeat = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
        else clearInterval(heartbeat);
    }, 30000);

    const processAudio = async () => {
        if (isProcessing || audioBuffer.length === 0 || isClosing) return;
        isProcessing = true;

        const chunksToProcess = [...audioBuffer];
        audioBuffer = []; // Clear for next batch
        silenceChunks = 0;

        console.log(`🔄 Processing audio batch (${chunksToProcess.length} chunks)`);
        const fullAudio = Buffer.concat(chunksToProcess);

        // Require at least 0.6 seconds of audio to process
        if (fullAudio.length < 19200) {
            console.log('⚠️ Batch too short, ignoring');
            isProcessing = false;
            return;
        }

        const rms = calculateRMS(fullAudio);
        if (rms < 0.001) {
            console.log('⚠️ Batch too quiet, skipping');
            isProcessing = false;
            return;
        }

        safeSend(JSON.stringify({ type: 'status', text: 'सोच रहा हूँ... 🤔' }));

        try {
            const wavBuffer = pcmToWav(fullAudio);
            const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
            const fileObject = await OpenAI.toFile(audioBlob, 'speech.wav');

            const userMsgRaw = await smartTranscription(fileObject);
            const userMsg = cleanTranscript(userMsgRaw || '');

            if (!userMsg) {
                safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
                isProcessing = false;
                return;
            }

            console.log(`📝 User: ${userMsg}`);
            safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
            await saveConversation(deviceId, 'user', userMsg);

            const previousHistory = await getConversationHistory(deviceId, 5);
            const messages = [
                { role: 'system', content: `तुम "SuperSahchar" हो। एक दोस्ताना हिंदी सहायक। छोटे और प्यारे जवाब दो। बातचीत ऐसी करो जैसे दो दोस्त बात कर रहे हों। अगर तुम्हें कोई ताजा जानकारी (जैसे वर्तमान नेता, खबरें, या तथ्य) नहीं पता, तो 'search_web' टूल का इस्तेमाल करो। जवाब हमेशा शुद्ध और सरल हिंदी में दो।` },
                ...previousHistory,
                { role: 'user', content: userMsg }
            ];

            const chatResult = await smartChat(messages, 150);
            const botReply = chatResult ? chatResult.reply : "अरे यार, नेट थोड़ा स्लो है। फिर से बोलिये? 😊";

            console.log(`🤖 Bot: ${botReply}`);
            safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
            await saveConversation(deviceId, 'assistant', botReply);

            isBotSpeaking = true;
            audioBuffer = []; // 🧹 Clear buffer
            silenceChunks = 0;

            safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

            let audioPcm = await smartTTS(botReply);
            if (!audioPcm) {
                safeSend(JSON.stringify({ type: 'audio_done' }));
                isBotSpeaking = false;
                isProcessing = false;
                return;
            }

            // Ensure even length for 16-bit PCM
            if (audioPcm.length % 2 !== 0) audioPcm = audioPcm.slice(0, -1);

            console.log(`📢 Sending audio (${audioPcm.length} bytes)`);

            // ✅ Send audio in 4KB chunks for better stability
            const CHUNK_SIZE = 4096;
            for (let i = 0; i < audioPcm.length; i += CHUNK_SIZE) {
                if (isClosing || ws.readyState !== 1) break;
                safeSend(audioPcm.subarray(i, Math.min(i + CHUNK_SIZE, audioPcm.length)), true);
            }

            // ✅ Calculate duration to keep isBotSpeaking true
            // 32000 bytes = 1 second.
            const playDurationMs = (audioPcm.length / 32000) * 1000;
            console.log(`🕒 Audio will play for ~${playDurationMs}ms`);

            // Wait for audio to finish playing on phone + safety margin
            await new Promise(r => setTimeout(r, playDurationMs + 1000));

            safeSend(JSON.stringify({ type: 'audio_done' }));
        } catch (err) {
            console.error(`❌ Error in processAudio: ${err.message}`);
        } finally {
            isBotSpeaking = false;
            isProcessing = false;
            audioBuffer = []; // 🧹 Final clear
            safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
        }
    };

    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            try {
                const json = JSON.parse(data.toString());
                if (json.type === 'interrupt') {
                    isBotSpeaking = false;
                    audioBuffer = [];
                    silenceChunks = 0;
                }
            } catch (e) {}
            return;
        }

        // ✅ AUTO-INTERRUPT: If audio comes in with high volume, stop the bot
        const chunk = Buffer.from(data);
        const chunkRms = calculateRMS(chunk);

        if (isBotSpeaking && chunkRms > 0.035) {
            console.log("⚡ User interrupted bot (detected by RMS)!");
            isBotSpeaking = false;
            audioBuffer = [];
            silenceChunks = 0;
            safeSend(JSON.stringify({ type: 'status', text: 'जी, सुन रहा हूँ... 🎤' }));
        }

        // 🔇 IGNORE audio while bot is speaking (after checking interrupt) or already processing
        if (isBotSpeaking || isProcessing) {
            audioBuffer = []; // 🧹 Keep buffer empty while bot speaks to prevent loops
            silenceChunks = 0;
            return;
        }

        // ✅ Monitor audio stream in real-time
        audioBuffer.push(chunk);

        if (chunkRms < SILENCE_THRESHOLD) {
            silenceChunks++;
        } else {
            silenceChunks = 0; // User is speaking
        }

        // ✅ Trigger processing if:
        // 1. We have enough audio AND
        // 2. We've seen significant silence OR
        // 3. Buffer is getting too long (safety limit - 20 seconds)
        if (audioBuffer.length > 15) {
            if (silenceChunks >= REQUIRED_SILENCE_CHUNKS || audioBuffer.length > 1000) {
                console.log(`🎯 Triggering processing: silence=${silenceChunks}, buffer=${audioBuffer.length}`);
                processAudio();
            }
        }
    });

    ws.on('close', () => {
        isClosing = true;
        clearInterval(heartbeat);
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket error: ${error.message}`);
        isClosing = true;
    });

    safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    if (mongoClient) await mongoClient.close();
    process.exit(0);
});



