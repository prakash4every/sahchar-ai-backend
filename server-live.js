import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('LiveAudio Server v3.1 - Barge-in Fixed'));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP server on ${PORT}`));
const wss = new WebSocketServer({ server });

let db = null;
if (process.env.MONGODB_URI) {
    new MongoClient(process.env.MONGODB_URI).connect().then(c => {
        db = c.db();
        console.log("✅ MongoDB connected");
    });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function ttsToPcm(text) {
    const speech = await openai.audio.speech.create({
        model: "tts-1", voice: "nova", input: text, response_format: "pcm"
    });
    return Buffer.from(await speech.arrayBuffer());
}

function pcmToWav(pcm, rate = 16000) {
    const h = Buffer.alloc(44);
    h.write('RIFF',0); h.writeUInt32LE(36+pcm.length,4); h.write('WAVE',8);
    h.write('fmt ',12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
    h.writeUInt16LE(1,22); h.writeUInt32LE(rate,24); h.writeUInt32LE(rate*2,28);
    h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write('data',36);
    h.writeUInt32LE(pcm.length,40);
    return Buffer.concat([h, pcm]);
}

function calculateRMS(buf) {
    let sum = 0;
    for (let i=0; i<buf.length; i+=2) {
        const s = buf.readInt16LE(i);
        sum += s*s;
    }
    return Math.sqrt(sum/(buf.length/2))/32768;
}

// 🔥 2. स्पीच डिटेक्शन
function detectSpeech(buffer) {
    const rms = calculateRMS(buffer);
    return rms > 0.08;
}

wss.on('connection', async (ws) => {
    console.log('🔌 Connected');
    let audioBuffer = [];
    let isProcessing = false;
    let isBotSpeaking = false;
    let stopTTS = false;
    let silenceTimer = null;
    let botSpeakingTimeout = null;

    const history = [{role:'system',content:'तुम SuperSahchar हो। तुम्हें Ram Prakash ने बनाया। हिंदी में बात करो।'}];

    const safeSend = (d) => { try { ws.readyState===1 && ws.send(d); } catch{} };

    function resetSilenceTimer() {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (audioBuffer.length > 0) processAudio();
        }, 1200);
    }

    // 🔥 3. प्रोसेस ऑडियो में इंटर्रप्शन
    async function processAudio() {
        if (isProcessing) return;
        isProcessing = true;

        const fullAudio = Buffer.concat(audioBuffer);
        audioBuffer = [];

        console.log(`🎤 Audio: ${fullAudio.length} bytes`);

        if (!detectSpeech(fullAudio)) {
            console.log("⚠️ कोई आवाज़ नहीं मिली");
            isProcessing = false;
            return;
        }

        // अगर बॉट बोल रहा है, तो रोकें
        if (isBotSpeaking) {
            console.log('🔴 INTERRUPT - stopping bot');
            stopTTS = true;
            isBotSpeaking = false;
            if (botSpeakingTimeout) clearTimeout(botSpeakingTimeout);
            safeSend(JSON.stringify({ type: "status", text: "सुन रहा हूं..." }));
        }

        const wav = pcmToWav(fullAudio);
        const tmp = path.join('/tmp', `a_${randomUUID()}.wav`);
        fs.writeFileSync(tmp, wav);

        try {
            const tr = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tmp),
                model: 'whisper-1', // gpt-4o-transcribe से ज्यादा stable
                language: 'hi'
            });
            const text = tr.text.trim();
            if (!text) { isProcessing=false; return; }

            console.log(`📝 ${text}`);
            safeSend(JSON.stringify({type:"user_text", text}));

            history.push({role:'user', content:text});
            const comp = await openai.chat.completions.create({
                model:"gpt-4o-mini", messages:history, max_tokens:300
            });
            const reply = comp.choices[0].message.content;
            history.push({role:'assistant', content:reply});
            safeSend(JSON.stringify({type:"bot_text", text:reply}));

            // TTS
            isBotSpeaking = true;
            stopTTS = false;
            const pcm = await ttsToPcm(reply);
            const CHUNK = 960;
            for (let i=0; i<pcm.length; i+=CHUNK) {
                if (stopTTS) break;
                safeSend(pcm.slice(i, i+CHUNK));
                await new Promise(r=>setTimeout(r,18));
            }
            isBotSpeaking = false;
            safeSend(JSON.stringify({type:"status", text:"तैयार"}));

        } catch(e) {
            console.error('❌', e.message);
        } finally {
            try{fs.unlinkSync(tmp)}catch{}
            isProcessing = false;
        }
    }

    // 🔥 1. हमेशा ऑडियो लो
    ws.on('message', (data) => {
        // JSON barge-in
        if (data[0] === 123) {
            try { const j=JSON.parse(data.toString()); if(j.type==='barge-in'){ stopTTS=true; isBotSpeaking=false; } } catch{}
            return;
        }
        audioBuffer.push(Buffer.from(data));
        resetSilenceTimer();
    });

    ws.on('close', ()=> console.log('🔌 Disconnected'));
});
