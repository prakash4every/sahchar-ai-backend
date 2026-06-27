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
  }
};

async function smartChat(messages) {
    const orderedProviders = ['groq', 'openai'];
    for (const providerName of orderedProviders) {
        const provider = providers[providerName];
        if (!provider || !provider.key || !provider.chat) continue;
        try {
            console.log(`🔄 Trying ${providerName}...`);
            const response = await axios.post(
                provider.url,
                { model: provider.model, messages, max_tokens: 60, temperature: 0.4 },
                { headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            const reply = response.data.choices?.[0]?.message?.content;
            if (reply) {
                console.log(`✅ ${providerName} success!`);
                return { reply: reply.trim(), provider: provider.name };
            }
        } catch (error) { console.error(`❌ ${providerName} failed:`, error.message); }
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
    console.log(`🔄 Generating TTS for: "${text.substring(0, 50)}..."`);
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    if (elevenLabsKey) {
        try {
            const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.3, similarity_boost: 0.5, speed: 1.0 }, output_format: 'pcm_16000' },
                { headers: { 'xi-api-key': elevenLabsKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
            );
            const pcmData = Buffer.from(response.data);
            if (pcmData.length < 1000) { console.warn('⚠️ TTS too small:', pcmData.length); return null; }
            let hasAudio = false;
            for (let i = 0; i < Math.min(pcmData.length, 200); i += 2) {
                if (Math.abs(pcmData.readInt16LE(i)) > 10) { hasAudio = true; break; }
            }
            if (!hasAudio) { console.warn('⚠️ TTS silent'); return null; }
            console.log(`✅ ElevenLabs TTS: ${pcmData.length} bytes`);
            return pcmData;
        } catch (error) { console.error('❌ ElevenLabs error:', error.message); }
    }
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            console.log('🔄 Trying OpenAI TTS...');
            const response = await axios.post(
                'https://api.openai.com/v1/audio/speech',
                { model: 'tts-1', input: text, voice: 'nova', response_format: 'pcm' },
                { headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
            );
            const pcmData = Buffer.from(response.data);
            console.log(`✅ OpenAI TTS: ${pcmData.length} bytes`);
            return pcmData;
        } catch (error) { console.error('❌ OpenAI TTS error:', error.message); }
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
    const leaks = ["आम बोलचाल", "दोस्त की बातचीत", "प्रस्तु", "परवारण", "धन्यवाद", "सब्सक्राइब"];
    if (leaks.some(leak => lowerText.includes(leak))) return "";
    const words = text.split(/\s+/);
    if (words.length >= 3 && new Set(words).size === 1) return "";
    if (text.replace(/[।,.!?]/g, '').trim().length < 3) return "";
    return text;
}

await connectMongoDB();

const server = app.listen(PORT, () => {
    console.log(`✅ Live Audio Server v7.1 running on port ${PORT}`);
    console.log(`🔑 GROQ_API_KEY: ${process.env.GROQ_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? '✅' : '❌'}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    if (socket.destroyed) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
        if (ws.readyState === ws.OPEN) { wss.emit('connection', ws, request); } else { ws.terminate(); }
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
    let processTimer = null;

    const safeSend = (data, isBinary = false) => {
        if (ws.readyState === 1 && !isClosing) {
            try { ws.send(data, { binary: isBinary }); return true; } catch (e) { return false; }
        }
        return false;
    };

    // ✅ FIXED: Lower threshold from 0.025 to 0.010
    const processAudio = async () => {
        if (isProcessing || audioBuffer.length === 0 || isClosing) return;
        isProcessing = true;
        console.log(`🔄 Processing audio (${audioBuffer.length} chunks)`);
        
        const fullAudio = Buffer.concat(audioBuffer);
        audioBuffer = [];

        console.log(`📊 Audio size: ${fullAudio.length} bytes`);

        if (fullAudio.length < 12000) {
            console.log('⚠️ Audio too short, skipping');
            isProcessing = false;
            return;
        }
        
        const rms = calculateRMS(fullAudio);
        console.log(`📊 RMS: ${rms}`);
        
        // ✅ FIX: Lowered threshold for better detection
        if (rms < 0.010) {
            console.log('⚠️ Audio too quiet, skipping');
            isProcessing = false;
            return;
        }

        safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));

        try {
            const wavBuffer = pcmToWav(fullAudio);
            const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
            const fileObject = await OpenAI.toFile(audioBlob, 'speech.wav');
            
            console.log('🔄 Transcribing...');
            const userMsgRaw = await smartTranscription(fileObject);
            console.log(`📝 Raw: ${userMsgRaw}`);
            
            const userMsg = cleanTranscript(userMsgRaw || '');

            if (!userMsg) {
                console.log('⚠️ No valid transcription');
                safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
                isProcessing = false;
                return;
            }
            
            console.log(`📝 User: ${userMsg}`);
            safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
            await saveConversation(deviceId, 'user', userMsg);

            const previousHistory = await getConversationHistory(deviceId, 5);
            const messages = [
                { role: 'system', content: `तुम "SuperSahchar" हो। दोस्त जैसा बर्ताव करो। जवाब छोटा और हिंदी में।` },
                ...previousHistory,
                { role: 'user', content: userMsg }
            ];

            console.log('🔄 Getting AI response...');
            const chatResult = await smartChat(messages);
            const botReply = chatResult ? chatResult.reply : "अरे यार, सब busy है। 😊";
            console.log(`🤖 Bot: ${botReply}`);
            
            safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
            await saveConversation(deviceId, 'assistant', botReply);

            isBotSpeaking = true;
            safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

            console.log('🔄 Generating TTS...');
            
            const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY;
            const hasOpenAI = !!process.env.OPENAI_API_KEY;
            console.log(`🔑 ElevenLabs: ${hasElevenLabs ? '✅' : '❌'}, OpenAI: ${hasOpenAI ? '✅' : '❌'}`);
            
            let audioPcm = null;
            
            if (hasElevenLabs) {
                try {
                    console.log('🔄 Trying ElevenLabs TTS...');
                    audioPcm = await smartTTS(botReply);
                    if (audioPcm) {
                        console.log(`✅ ElevenLabs success: ${audioPcm.length} bytes`);
                    }
                } catch (e) {
                    console.error('❌ ElevenLabs error:', e.message);
                }
            }
            
            if (!audioPcm && hasOpenAI) {
                try {
                    console.log('🔄 Trying OpenAI TTS fallback...');
                    const response = await axios.post(
                        'https://api.openai.com/v1/audio/speech',
                        { model: 'tts-1', input: botReply, voice: 'nova', response_format: 'pcm' },
                        { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
                    );
                    audioPcm = Buffer.from(response.data);
                    console.log(`✅ OpenAI TTS success: ${audioPcm.length} bytes`);
                } catch (e) {
                    console.error('❌ OpenAI TTS error:', e.message);
                }
            }
            
            if (!audioPcm) {
                console.log('⚠️ No TTS available, generating beep');
                const sampleRate = 16000;
                const duration = 1.0;
                const numSamples = Math.floor(sampleRate * duration);
                const beepBuffer = Buffer.alloc(numSamples * 2);
                for (let i = 0; i < numSamples; i++) {
                    const sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 8000;
                    beepBuffer.writeInt16LE(sample, i * 2);
                }
                audioPcm = beepBuffer;
                console.log(`✅ Generated beep: ${audioPcm.length} bytes`);
            }

            if (!audioPcm || audioPcm.length < 100) {
                console.log('⚠️ Invalid audio PCM, skipping');
                safeSend(JSON.stringify({ type: 'audio_done' }));
                isBotSpeaking = false;
                isProcessing = false;
                return;
            }

            if (audioPcm.length % 2 !== 0) {
                console.log('⚠️ PCM length odd, truncating');
                audioPcm = audioPcm.slice(0, audioPcm.length - 1);
            }

            const hexFirst16 = audioPcm.slice(0, Math.min(16, audioPcm.length)).toString('hex');
            console.log(`🔊 PCM first 16 bytes: ${hexFirst16}`);

            console.log(`📢 Sending audio (${audioPcm.length} bytes)`);
            const CHUNK_SIZE = 640;
            let sentBytes = 0;
            
            for (let i = 0; i < audioPcm.length; i += CHUNK_SIZE) {
                if (isClosing || ws.readyState !== 1) break;
                const chunk = audioPcm.subarray(i, Math.min(i + CHUNK_SIZE, audioPcm.length));
                if (chunk.length > 0) {
                    safeSend(chunk, true);
                    sentBytes += chunk.length;
                }
                await new Promise(r => setTimeout(r, 5));
            }
            
            console.log(`✅ Sent ${sentBytes} bytes of PCM audio`);

            safeSend(JSON.stringify({ type: 'audio_done' }));
            isBotSpeaking = false;
            safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));

        } catch (err) {
            console.error(`❌ Error: ${err.message}`);
            console.error(`📊 Stack: ${err.stack}`);
            safeSend(JSON.stringify({ type: 'status', text: 'Error occurred' }));
        } finally {
            isProcessing = false;
        }
    };

    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            try {
                const json = JSON.parse(data.toString());
                console.log(`📨 Received: ${json.type}`);
                if (json.type === 'interrupt') {
                    console.log('🛑 Interrupt received');
                    isBotSpeaking = false;
                    audioBuffer = [];
                }
            } catch (e) {}
            return;
        }
        
        const chunkSize = data.length;
        if (chunkSize > 0) {
            if (audioBuffer.length % 50 === 0) {
                console.log(`📊 Audio chunk #${audioBuffer.length + 1}: ${chunkSize} bytes`);
            }
            audioBuffer.push(Buffer.from(data));
        }
        
        if (processTimer) clearTimeout(processTimer);
        processTimer = setTimeout(() => {
            if (audioBuffer.length > 0 && !isProcessing && !isClosing) {
                processAudio();
            }
        }, 300);
    });

    ws.on('close', () => {
        console.log(`🔌 Client disconnected: ${connectionId}`);
        isClosing = true;
        if (processTimer) clearTimeout(processTimer);
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
