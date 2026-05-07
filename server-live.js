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

app.get('/', (req, res) => res.send('Sahchar Live v9'));

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
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/wav' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'pcm_24000',
        voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
      })
    });
    if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (e) {
    console.error('ElevenLabs fail:', e.message);
    const r = await openai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input: text, response_format: 'pcm' });
    return Buffer.from(await r.arrayBuffer());
  }
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let stopTTS = false;
  let silenceTimer = null;
  let lastBotEndTime = 0; 

  const history = [{
    role: 'system',
    content: 'तुम SuperSahchar हो। तुम्हें Sahchar टीम ने बनाया है। हमेशा 1-2 लाइन में जवाब दो, जिस भाषा में user बोले उसी में।'
  }];

  const safeSend = (d) => { try { ws.readyState === 1 && ws.send(d); } catch {} };
  const resetSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = setTimeout(() => processAudio(), 800); };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0 || ws.readyState!== 1) return;
    isProcessing = true;
    const full = Buffer.concat(audioBuffer); audioBuffer = [];
    const rms = calculateRMS(full);
    const timeSinceBot = Date.now() - lastBotEndTime;

    console.log(`🎤 Audio: ${full.length} bytes, RMS=${rms.toFixed(4)}, sinceBot=${timeSinceBot}ms`);

    if (rms < 0.015 || full.length < 3200 || isBotSpeaking || timeSinceBot < 700) {
      isProcessing = false;
      return;
    }

    const wav = pcmToWav(full, 16000);
    const tmp = path.join('/tmp', `a_${randomUUID()}.wav`); fs.writeFileSync(tmp, wav);

    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        language: 'hi',
       prompt: 'नमस्ते, अस्सलाम वालेकुम, हेलो, how are you, क्या हाल है, कैसे हो, good morning, good evening, शुक्रिया, धन्यवाद, please, मदद, बताइए, सुनिए'
      });
      const text = (tr.text || '').trim(); if (!text || text.length < 2) return;
      console.log(`📝 ${text}`); safeSend(JSON.stringify({ type: 'user_text', text }));

      history.push({ role: 'user', content: text }); if (history.length > 11) history.splice(1, 2);
      const comp = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history, max_tokens: 60, temperature: 0.7 });
      const reply = comp.choices[0].message.content; console.log(`🤖 ${reply}`);
      history.push({ role: 'assistant', content: reply });
      safeSend(JSON.stringify({ type: 'bot_text', text: reply }));

      isBotSpeaking = true; stopTTS = false;
      const pcm = await ttsToPcm(reply);
      if (ws.readyState!== 1) return;

      const CHUNK = 1920;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        if (stopTTS || ws.readyState!== 1) break;
        safeSend(pcm.subarray(i, i + CHUNK));
        await new Promise(r => setTimeout(r, 38));
      }
      console.log(`🔊 Sent ${pcm.length} bytes`);
    } catch (e) { console.error('❌', e.message);
    } finally {
      try { fs.unlinkSync(tmp); } catch {};
      isBotSpeaking = false;
      lastBotEndTime = Date.now(); // <-- यहाँ set किया
      safeSend(JSON.stringify({ type: 'status', text: 'ready' }));
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) { try { const j = JSON.parse(data.toString()); if (j.type === 'barge-in') { stopTTS = true; isBotSpeaking = false; } } catch {}; return; }
    if (!isBotSpeaking) { audioBuffer.push(Buffer.from(data)); resetSilence(); }
  });

  ws.on('close', () => { console.log('🔌 Disconnected'); if (silenceTimer) clearTimeout(silenceTimer); });
});
