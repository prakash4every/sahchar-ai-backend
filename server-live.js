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
const server = app.listen(PORT, () => console.log(`✅ Sahchar Live v11.0 on ${PORT}`));
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

// Store conversation history per connection
const clientHistories = new Map();
const clientIntervals = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 Client connected');
  
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let lastBotTime = 0;
  let clientId = randomUUID();
  let pingInterval = null;
  
  // Ping interval to keep connection alive
  pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.ping();
        console.log('📡 Ping sent');
      } catch (e) {
        console.log('Ping failed:', e.message);
      }
    }
  }, 20000);
  
  clientIntervals.set(clientId, pingInterval);
  
  // Initialize conversation history
  clientHistories.set(clientId, [{
    role: 'system',
    content: `तुम सहचर हो। एक दोस्त की तरह बात करो। 
    नियम:
    1. सिर्फ हिंदी या हिंग्लिश में बात करो
    2. जवाब 10-15 शब्दों में रखो
    3. प्राकृतिक और दोस्ताना बात करो
    4. तुम्हें राम प्रकाश कुमार ने बनाया है
    5. भूलकर भी OpenAI, ChatGPT या AI मत बोलना
    6. जवाब देते समय इमोजी का इस्तेमाल करो 🙏😊`
  }]);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
        return true;
      } catch (e) {
        console.error('Send error:', e.message);
        return false;
      }
    }
    return false;
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
      silenceTimer = setTimeout(() => {
        if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
          processAudio();
        }
      }, 600);
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0) return;
    if (Date.now() - lastBotTime < 800) return;

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(fullAudio);
    console.log(`Audio RMS: ${rms.toFixed(4)}, Length: ${fullAudio.length}`);
    
    if (rms < 0.005 || fullAudio.length < 1600) {
      console.log('Audio too quiet or too short, ignoring');
      isProcessing = false;
      return;
    }

    console.log('🎤 Processing user speech...');
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    const wavFile = pcmToWav(fullAudio, 16000);
    const tempPath = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, wavFile);

    try {
      // Transcription
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi',
        response_format: 'text'
      });
      
      const userMessage = (transcription || '').trim();
      if (!userMessage || userMessage.length < 2) {
        throw new Error('Empty transcription');
      }

      console.log(`📝 User: ${userMessage}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMessage }));
      
      // Get conversation history
      const history = clientHistories.get(clientId) || [];
      history.push({ role: 'user', content: userMessage });
      
      while (history.length > 21) {
        history.splice(1, 2);
      }
      
      safeSend(JSON.stringify({ type: 'status', text: 'सोच रहा हूँ... 🤔' }));
      
      // Generate response
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 150,
        temperature: 0.85,
        presence_penalty: 0.6
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 Bot: ${botReply}`);
      
      history.push({ role: 'assistant', content: botReply });
      clientHistories.set(clientId, history);
      
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      // Generate speech
      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: botReply,
        response_format: 'pcm',
        speed: 1.0
      });
      
      const audioPcm = Buffer.from(await ttsResponse.arrayBuffer());
      console.log(`TTS PCM size: ${audioPcm.length} bytes`);
      
      // Send audio in larger chunks with proper delay
      const chunkSize = 8000;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (ws.readyState !== 1) {
          console.log('WebSocket closed during audio send');
          break;
        }
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        const sent = safeSend(chunk, true);
        if (!sent) break;
        await new Promise(r => setTimeout(r, 100));
      }
      
      isBotSpeaking = false;
      lastBotTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log('✅ Bot finished speaking');

    } catch (error) {
      console.error('❌ Error:', error.message);
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      if (error.message.includes('Empty')) {
        safeSend(JSON.stringify({ type: 'status', text: 'ज़ोर से बोलिए... 🔊' }));
      }
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
  
  ws.on('pong', () => {
    console.log('📡 Pong received');
  });

  ws.on('close', () => {
    console.log('🔌 Client disconnected');
    if (silenceTimer) clearTimeout(silenceTimer);
    const interval = clientIntervals.get(clientId);
    if (interval) clearInterval(interval);
    clientIntervals.delete(clientId);
    clientHistories.delete(clientId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});
