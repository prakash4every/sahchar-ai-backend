import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GROQ_KEY = process.env.GROQ_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Hindi voice

app.get('/', (req, res) => res.send('Sahchar Live v10 - Frank Hindi'));

function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function calculateRMS(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) sum += buf.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (buf.length / 2)) / 32768;
}

async function ttsToPcm(text) {
  if (!ELEVEN_KEY) {
    const r = await openai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input: text, response_format: 'pcm' });
    return Buffer.from(await r.arrayBuffer());
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      output_format: 'pcm_16000',
      voice_settings: { stability: 0.6, similarity_boost: 0.9, style: 0.3, use_speaker_boost: true }
    })
  });
  return Buffer.from(await res.arrayBuffer());
}

async function getGroqReply(history) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: history,
        max_tokens: 70,
        temperature: 0.95
      })
    });
    const data = await res.json();
    if (!data.choices ||!data.choices[0]) {
      console.error('Groq error:', data);
      throw new Error('Groq no choices');
    }
    return data.choices[0].message.content;
  } catch (e) {
    console.error('Groq fail, using OpenAI:', e.message);
    // fallback to OpenAI
    const comp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: history,
      max_tokens: 70,
      temperature: 0.9
    });
    return comp.choices[0].message.content;
  }
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [], isProcessing = false, isBotSpeaking = false, stopTTS = false, silenceTimer = null;
  let lastBotEndTime = Date.now();

  const history = [{
    role: 'system',
    content: `तू SuperSahchar है, दोस्त जैसा। 
- बिल्कुल आम बोलचाल की Hindi बोल: "अरे", "हां", "बताओ", "क्या हुआ", "समझ गया"
- "कृपया", "क्षमा करें", "आपकी सहायता" मत बोलना
- 1-2 लाइन, 15 शब्द से कम
- यूजर Urdu बोले तो Urdu में, English बोले तो English में`
  }];

  const safeSend = (d) => { try { ws.readyState === 1 && ws.send(d); } catch {} };
  const resetSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = setTimeout(() => processAudio(), 800); };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0 || ws.readyState !== 1) return;
    isProcessing = true;
    const full = Buffer.concat(audioBuffer); audioBuffer = [];
    const rms = calculateRMS(full);
    const timeSinceBot = Date.now() - lastBotEndTime;

    if (rms < 0.008 || full.length < 5000 || isBotSpeaking || timeSinceBot < 1800) {
      isProcessing = false; return;
    }

    const wav = pcmToWav(full, 16000);
    const tmp = path.join('/tmp', `a_${randomUUID()}.wav`); fs.writeFileSync(tmp, wav);

    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        language: 'hi',
        prompt: 'नमस्ते, हेलो, क्या हाल है, बताओ, अरे यार'
      });
      if (ws.readyState !== 1) return;
      
      const text = (tr.text || '').trim(); if (!text) return;
      console.log(`📝 ${text}`); safeSend(JSON.stringify({ type: 'user_text', text }));

      history.push({ role: 'user', content: text }); if (history.length > 11) history.splice(1, 2);
      
      const reply = await getGroqReply(history);
      if (ws.readyState !== 1) return;
      
      console.log(`🤖 ${reply}`);
      history.push({ role: 'assistant', content: reply });
      safeSend(JSON.stringify({ type: 'bot_text', text: reply }));

      isBotSpeaking = true; stopTTS = false;
      const pcm = await ttsToPcm(reply);
      if (ws.readyState !== 1) return;

      for (let i = 0; i < pcm.length; i += 1920) {
        if (stopTTS || ws.readyState !== 1) break;
        safeSend(pcm.subarray(i, i + 1920));
        await new Promise(r => setTimeout(r, 60));
      }
    } catch (e) { console.error('❌', e.message);
    } finally {
      try { fs.unlinkSync(tmp); } catch {};
      isBotSpeaking = false; lastBotEndTime = Date.now();
      if (ws.readyState === 1) safeSend(JSON.stringify({ type: 'status', text: 'ready' }));
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (!isBotSpeaking) { audioBuffer.push(Buffer.from(data)); resetSilence(); }
  });

  ws.on('close', () => { if (silenceTimer) clearTimeout(silenceTimer); });
});
