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
const server = app.listen(PORT, () => console.log(`✅ Sahchar Live v9.0 on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Working'));

function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function calculateRMS(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i += 2) {
    const sample = buf.readInt16LE(i);
    sum += sample * sample;
  }
  const samples = buf.length / 2;
  return Math.sqrt(sum / samples) / 32768;
}

wss.on('connection', (ws) => {
  console.log('🔌 Client connected');
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let lastBotTime = 0;
  let audioStreamTimeout = null;

  const history = [{
    role: 'system',
    content: 'तुम सहचर हो। दोस्त की तरह छोटे, प्राकृतिक जवाब दो, हिंदी में। तुम्हें राम प्रकाश कुमार ने बनाया है। भूलकर भी OpenAI मत बोलना, बस एक दोस्त की तरह बात करना। जवाब 10-15 शब्दों में रखना।'
  }];

  const safeSend = (data) => {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch (e) {
        console.error('Send error:', e.message);
      }
    }
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && audioBuffer.length > 0) {
      silenceTimer = setTimeout(() => {
        if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
          processAudio();
        }
      }, 400); 
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0) return;
    if (Date.now() - lastBotTime < 1000) return; 

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(fullAudio);
    console.log(`Audio RMS: ${rms.toFixed(4)}, Length: ${fullAudio.length}`);
    if (rms < 0.006 || fullAudio.length < 2000) {
      console.log('Audio too quiet or too short, ignoring');
      isProcessing = false;
      return;
    }

    console.log('Processing audio...');
    
    const wavFile = pcmToWav(fullAudio, 16000);
    const tempPath = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, wavFile);

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi',
        response_format: 'text'
      });
      
      const userMessage = (transcription || '').trim();
      if (!userMessage || userMessage.length < 1) {
        throw new Error('Empty transcription');
      }

      console.log(`📝 User: ${userMessage}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMessage }));
      history.push({ role: 'user', content: userMessage });
      if (history.length > 11) history.splice(1, 2);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 80,
        temperature: 0.85,
        presence_penalty: 0.6
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 Bot: ${botReply}`);
      
      history.push({ role: 'assistant', content: botReply });
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      isBotSpeaking = true;
      
      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: botReply,
        response_format: 'pcm',
        speed: 1.0
      });
      
      const audioPcm = Buffer.from(await ttsResponse.arrayBuffer());
      console.log(`TTS PCM size: ${audioPcm.length} bytes`);
      const chunkSize = 2000; 
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (ws.readyState !== 1) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk);
        await new Promise(r => setTimeout(r, 40));
      }
      isBotSpeaking = false;
      lastBotTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'ready' }));
      
      console.log('Bot finished speaking, ready for next input');

    } catch (error) {
      console.error('❌ Error:', error.message);
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'ready' }));
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking) return;
    audioBuffer.push(Buffer.from(data));
    resetSilenceTimer();
  });

  ws.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (audioStreamTimeout) clearTimeout(audioStreamTimeout);
    console.log('🔌 Client disconnected');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});
