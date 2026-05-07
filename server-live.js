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
const server = app.listen(PORT, () => console.log(`✅ HTTP on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live v8 - Stable'));

function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [], isProcessing = false;
  let history = [{ role: 'system', content: 'तुम सहचर हो, दोस्त जैसे बात करो, छोटा जवाब दो, हिंदी में।' }];

  ws.on('message', async (data, isBinary) => {
    if (!isBinary) return;
    audioBuffer.push(Buffer.from(data));

    if (audioBuffer.length > 20 &&!isProcessing) { // ~800ms
      isProcessing = true;
      const full = Buffer.concat(audioBuffer); audioBuffer = [];

      const wav = pcmToWav(full, 16000);
      const tmp = path.join('/tmp', `${randomUUID()}.wav`);
      fs.writeFileSync(tmp, wav);

      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmp),
          model: 'whisper-1',
          language: 'hi'
        });
        const text = tr.text?.trim();
        if (!text) return;

        console.log('📝', text);
        ws.send(JSON.stringify({ type: 'user_text', text }));

        history.push({ role: 'user', content: text });
        const comp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: history,
          max_tokens: 60
        });
        const reply = comp.choices[0].message.content;
        console.log('🤖', reply);
        history.push({ role: 'assistant', content: reply });
        ws.send(JSON.stringify({ type: 'bot_text', text: reply }));

        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: reply,
          response_format: 'pcm'
        });
        const pcm = Buffer.from(await tts.arrayBuffer());

        // OpenAI TTS = 24kHz, send in 2400 byte chunks (50ms)
        for (let i = 0; i < pcm.length; i += 2400) {
          ws.send(pcm.subarray(i, i + 2400));
          await new Promise(r => setTimeout(r, 48));
        }
        ws.send(JSON.stringify({ type: 'status', text: 'ready' }));
      } catch (e) {
        console.error(e);
      } finally {
        fs.unlinkSync(tmp);
        isProcessing = false;
      }
    }
  });
});