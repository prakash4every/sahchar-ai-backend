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
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

app.get('/', (req, res) => res.send('Sahchar Live v9.1'));

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
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'pcm_24000',
        voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0, use_speaker_boost: true }
      })
    });
    return Buffer.from(await response.arrayBuffer());
  } catch {
    const r = await openai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input: text, response_format: 'pcm' });
    return Buffer.from(await r.arrayBuffer());
  }
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [], isProcessing = false, isBotSpeaking = false, stopTTS = false, silenceTimer = null;
  let lastBotEndTime = Date.now();

  const history = [{
    role: 'system',
    content: 'तुम SuperSahchar हो, Sahchar टीम का AI। यूज़र की भाषा में (Hindi/Urdu/English) 1-2 लाइन में मदद करो। छोटा, clear जवाब दो।'
  }];

  const safeSend = (d) => { try { ws.readyState === 1 && ws.send(d); } catch {} };
  const resetSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = setTimeout(() => processAudio(), 800); };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0 || ws.readyState !== 1) return;
    isProcessing = true;
    const full = Buffer.concat(audioBuffer); audioBuffer = [];
    const rms = calculateRMS(full);
    const timeSinceBot = Date.now() - lastBotEndTime;

    console.log(`🎤 Audio: ${full.length} bytes, RMS=${rms.toFixed(4)}, sinceBot=${timeSinceBot}ms`);

    if (rms < 0.025 || full.length < 5000 || isBotSpeaking || timeSinceBot < 1200) {
      isProcessing = false; return;
    }

    const wav = pcmToWav(full, 16000);
    const tmp = path.join('/tmp', `a_${randomUUID()}.wav`); fs.writeFileSync(tmp, wav);

    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        language: 'hi',
        prompt: 'नमस्ते, अस्सलाम वालेकुम, hello, क्या हाल है, good evening'
      });
      if (ws.readyState !== 1) return;
      
      const text = (tr.text || '').trim(); if (!text) return;
      console.log(`📝 ${text}`); safeSend(JSON.stringify({ type: 'user_text', text }));

      history.push({ role: 'user', content: text }); if (history.length > 11) history.splice(1, 2);
      const comp = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history, max_tokens: 60, temperature: 0.7 });
      if (ws.readyState !== 1) return;
      
      const reply = comp.choices[0].message.content; console.log(`🤖 ${reply}`);
      history.push({ role: 'assistant', content: reply });
      safeSend(JSON.stringify({ type: 'bot_text', text: reply }));

      isBotSpeaking = true; stopTTS = false;
      const pcm = await ttsToPcm(reply);
      if (ws.readyState !== 1) return;

      for (let i = 0; i < pcm.length; i += 1920) {
        if (stopTTS || ws.readyState !== 1) break;
        safeSend(pcm.subarray(i, i + 1920));
        await new Promise(r => setTimeout(r, 38));
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
