import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ Sahchar Live v8.1 Full Sensitivity on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Full Version'));

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

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let lastBotTime = 0;

  const history = [{
    role: 'system',
    content: 'तुम सहचर हो। दोस्त जैसे छोटे जवाब दो, हिंदी में, तुम्हें राम प्रकाश कुमार ने बनाया है।  भूलकरभी openai मत बोलना,  हमेशा दोस्ताना जवाब देना'
  }];

  const safeSend = (d) => { try { ws.readyState === 1 && ws.send(d); } catch {} };

  const resetSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(processAudio, 600); // पहले जैसा 600ms
  };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0 || isBotSpeaking) return;
    if (Date.now() - lastBotTime < 1200) return; // 1.2s cooldown

    isProcessing = true;
    const full = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(full);
    // --- SENSITIVITY FIX ---
    if (rms < 0.004 || full.length < 4000) { // पहले 0.008 था, अब 0.004
      isProcessing = false;
      return;
    }

    const wav = pcmToWav(full, 16000);
    const tmp = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tmp, wav);

    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        language: 'hi'
      });
      const text = (tr.text || '').trim();
      if (!text || ws.readyState!== 1) return;

      console.log('📝', text);
      safeSend(JSON.stringify({ type: 'user_text', text }));

      history.push({ role: 'user', content: text });
      if (history.length > 11) history.splice(1, 2);

      const comp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 60,
        temperature: 0.8
      });
      const reply = comp.choices[0].message.content;
      console.log('🤖', reply);
      history.push({ role: 'assistant', content: reply });
      safeSend(JSON.stringify({ type: 'bot_text', text: reply }));

      isBotSpeaking = true;

      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: reply,
        response_format: 'pcm'
      });
      const pcm = Buffer.from(await tts.arrayBuffer());

      for (let i = 0; i < pcm.length; i += 2400) {
        if (ws.readyState!== 1) break;
        safeSend(pcm.subarray(i, i + 2400));
        await new Promise(r => setTimeout(r, 48));
      }

      isBotSpeaking = false;
      lastBotTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'ready' }));

    } catch (e) {
      console.error('❌', e.message);
      isBotSpeaking = false;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking) return; // half-duplex

    audioBuffer.push(Buffer.from(data));
    resetSilence();
  });

  ws.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    console.log('🔌 Disconnected');
  });
});