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
const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v5.0 on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Stable v5.0'));

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

function amplifyAudio(pcmData, factor = 1.8) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

wss.on('connection', (ws) => {
  console.log('🔌 Client connected');
  
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let clientId = randomUUID().substring(0, 8);
  let packetCount = 0;
  let isClosing = false;
  let keepAliveInterval = null;
  
  console.log(`📱 Client ID: ${clientId}`);

  // Keep connection alive
  keepAliveInterval = setInterval(() => {
    if (ws.readyState === 1 && !isClosing) {
      try {
        ws.ping();
      } catch (e) {}
    }
  }, 10000);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1 && !isClosing) {
      try {
        ws.send(data);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;
    
    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];
    
    console.log(`🎤 Audio length: ${fullAudio.length} bytes, packets: ${packetCount}`);
    
    // Minimum 0.5 seconds of audio (8000 bytes at 16kHz/16bit)
    if (fullAudio.length < 8000) {
      console.log('Audio too short, ignoring');
      isProcessing = false;
      return;
    }
    
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    const tempPath = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, pcmToWav(fullAudio));
    
    try {
      // Transcribe
      console.log('📞 Whisper API...');
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi'
      });
      
      const userMsg = transcription.text.trim();
      if (!userMsg || userMsg.length < 2) {
        throw new Error('Empty transcription');
      }
      
      console.log(`📝 User: ${userMsg}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
      
      // Generate response
      console.log('📞 GPT API...');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'तुम सहचर हो। हिंदी में बहुत छोटे, दोस्ताना जवाब दो। 10 शब्दों से कम। 🙏' },
          { role: 'user', content: userMsg }
        ],
        max_tokens: 80,
        temperature: 0.8
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      
      // Check connection before TTS
      if (isClosing || ws.readyState !== 1) {
        console.log('Connection lost before TTS');
        return;
      }
      
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      console.log('📞 TTS API...');
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: botReply,
        response_format: 'pcm',
        speed: 1.0
      });
      
      let audioPcm = Buffer.from(await tts.arrayBuffer());
      console.log(`🔊 TTS size: ${audioPcm.length} bytes`);
      audioPcm = amplifyAudio(audioPcm, 1.8);
      
      // Send audio in chunks
      const chunkSize = 4000;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isClosing || ws.readyState !== 1) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 40));
      }
      
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log('✅ Done');
      
    } catch (err) {
      console.error('❌ Error:', err.message);
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  };
  
  // Reset timer on each packet
  let processTimer = null;
  
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking || isProcessing || isClosing) return;
    
    packetCount++;
    audioBuffer.push(Buffer.from(data));
    
    if (packetCount % 100 === 0) {
      console.log(`📥 Packets: ${packetCount}, Buffer: ${audioBuffer.length} chunks`);
    }
    
    // Reset timer
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isBotSpeaking && !isClosing) {
        console.log(`🔇 Processing ${audioBuffer.length} chunks`);
        processAudio();
      }
    }, 800);
  });
  
  ws.on('pong', () => {});
  
  ws.on('close', (code, reason) => {
    console.log(`🔌 Client ${clientId} disconnected: ${code} - ${reason}`);
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
  console.log('✅ Ready for audio');
});

console.log('✅ Server v5.0 ready');
