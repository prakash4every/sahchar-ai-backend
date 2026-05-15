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
const server = app.listen(PORT, () => console.log(`✅ Sahchar Live v13.1 on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live v13.1 - Working'));

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
  for (let i = 0; i < buf.length - 1; i += 2) {
    const sample = buf.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (buf.length / 2)) / 32768;
}

function amplifyAudio(pcmData, factor = 2.0) {
  const out = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let s = pcmData.readInt16LE(i);
    s = Math.max(-32768, Math.min(32767, s * factor));
    out.writeInt16LE(s, i);
  }
  return out;
}

const clientHistories = new Map();
const clientIntervals = new Map();
const activeClients = new Map();

wss.on('connection', (ws) => {
  console.log('🔌 Client connected');
  let audioBuffer = [], isProcessing = false, isBotSpeaking = false;
  let silenceTimer = null, lastBotTime = 0, clientId = randomUUID(), isClosing = false;

  activeClients.set(clientId, ws);
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1 && !isClosing) try { ws.ping(); } catch {}
  }, 15000);
  clientIntervals.set(clientId, pingInterval);

  clientHistories.set(clientId, [{
    role: 'system',
    content: `तुम सहचर हो। दोस्त की तरह बात करो। सिर्फ हिंदी/हिंग्लिश, 10-15 शब्द, इमोजी use करो। तुम्हें राम प्रकाश कुमार ने बनाया है।`
  }]);

  const safeSend = (data) => {
    if (ws.readyState === 1 && !isClosing) try { ws.send(data); return true; } catch {}
    return false;
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
      silenceTimer = setTimeout(processAudio, 900);
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0 || isClosing) return;
    if (Date.now() - lastBotTime < 800) return;

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];
    const rms = calculateRMS(fullAudio);

    console.log(`🎤 RMS: ${rms.toFixed(4)} Len:${fullAudio.length}`);
    
    if (rms < 0.002 || fullAudio.length < 3200) {
      console.log('Too quiet');
      isProcessing = false;
      safeSend(JSON.stringify({ type: 'status', text: 'ज़ोर से बोलिए... 🔊' }));
      return;
    }

    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    const wav = pcmToWav(fullAudio, 16000);
    const tmp = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tmp, wav);

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        language: 'hi',
        response_format: 'text'
      });
      const userMessage = (transcription || '').trim();
      if (!userMessage) throw new Error('Empty');

      console.log(`📝 User: ${userMessage}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMessage }));

      const history = clientHistories.get(clientId);
      history.push({ role: 'user', content: userMessage });
      if (history.length > 21) history.splice(1, 2);

      safeSend(JSON.stringify({ type: 'status', text: 'सोच रहा हूँ... 🤔' }));
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 120,
        temperature: 0.85
      });
      const botReply = completion.choices[0].message.content;
      history.push({ role: 'assistant', content: botReply });
      console.log(`🤖 Bot: ${botReply}`);

      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

      const tts = await openai.audio.speech.create({
        model: 'tts-1', voice: 'nova', input: botReply,
        response_format: 'pcm', speed: 0.95
      });
      let pcm = Buffer.from(await tts.arrayBuffer());
      pcm = amplifyAudio(pcm, 2.0);

      const chunkSize = 4800;
      for (let i = 0; i < pcm.length; i += chunkSize) {
        if (ws.readyState !== 1) break;
        safeSend(pcm.subarray(i, i + chunkSize));
        await new Promise(r => setTimeout(r, 20));
      }

      isBotSpeaking = false;
      lastBotTime = Date.now();
      safeSend(JSON.stringify({ type: 'audio_done' }));
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));

    } catch (e) {
      console.error('❌', e.message);
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'फिर से बोलिए...' }));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary || isBotSpeaking || isClosing) return;
    audioBuffer.push(Buffer.from(data));
    resetSilenceTimer();
  });

  ws.on('close', () => {
    isClosing = true;
    clearInterval(clientIntervals.get(clientId));
    clientIntervals.delete(clientId);
    clientHistories.delete(clientId);
    activeClients.delete(clientId);
  });
});
