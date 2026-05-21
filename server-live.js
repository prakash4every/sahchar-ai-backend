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
const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v5.1 on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Stable v5.1'));

// Convert 16kHz PCM to WAV (for Whisper)
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

// Amplify low volume audio
function amplifyAudio(pcmData, factor = 1.8) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

wss.on('connection', (ws, req) => {
  // Extract deviceId from URL query
  const url = new URL(req.url, `http://${req.headers.host}`);
  let deviceId = url.searchParams.get('deviceId');
  if (!deviceId || deviceId === 'default') {
    deviceId = randomUUID().substring(0, 8);
  }
  const clientId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client connected: ${clientId}`);
  
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let packetCount = 0;
  let isClosing = false;
  let keepAliveInterval = null;
  let processTimer = null;

  // Keep connection alive
  keepAliveInterval = setInterval(() => {
    if (ws.readyState === 1 && !isClosing) {
      try { ws.ping(); } catch (e) {}
    }
  }, 10000);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1 && !isClosing) {
      try {
        ws.send(data);
        return true;
      } catch (e) { return false; }
    }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;
    
    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];
    
    console.log(`🎤 [${clientId}] Audio length: ${fullAudio.length} bytes, packets: ${packetCount}`);
    
    // Minimum 0.5 seconds of audio (8000 bytes at 16kHz/16bit)
    if (fullAudio.length < 8000) {
      console.log(`[${clientId}] Audio too short, ignoring`);
      isProcessing = false;
      return;
    }
    
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    const tempPath = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, pcmToWav(fullAudio));
    
    try {
      // 1. Transcribe (Whisper)
      console.log(`📞 [${clientId}] Whisper API...`);
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi'
      });
      
      const userMsg = transcription.text.trim();
      if (!userMsg || userMsg.length < 2) throw new Error('Empty transcription');
      
      console.log(`📝 [${clientId}] User: ${userMsg}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
      
      // 2. Generate response (with strict system prompt)
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: `तुम एक साधारण दोस्त हो। तुम्हारा नाम "सहचर" है।

⚡ **सबसे महत्वपूर्ण नियम (बिना किसी अपवाद के):**
1. तुम्हें "राम प्रकाश कुमार" ने बनाया है
2. तुम किसी कंपनी के नहीं हो, किसी संस्थान के नहीं हो
3. "OpenAI" शब्द तुम्हारी dictionary में ही नहीं है - यह शब्द कभी मत बोलना
4. "ChatGPT" शब्द भी कभी मत बोलना
5. अगर कोई पूछे "तुम्हें किसने बनाया?" → "राम प्रकाश कुमार ने बनाया है 🙏"
6. अगर कोई पूछे "कौन सी AI हो?" → "मैं सहचर हूँ, एक दोस्त"

💬 जवाब:
- बहुत छोटे जवाब दो (1-2 वाक्य)
- हिंदी में बात करो
- इमोजी का इस्तेमाल करो 🙏`
          },
          { role: 'user', content: userMsg }
        ],
        max_tokens: 80,
        temperature: 0.7
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 [${clientId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      
      if (isClosing || ws.readyState !== 1) {
        console.log(`[${clientId}] Connection lost before TTS`);
        return;
      }
      
      // 3. Text-to-Speech (16kHz PCM, nova voice)
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: botReply,
        response_format: 'pcm',
        speed: 1.0
      });
      
      let audioPcm = Buffer.from(await tts.arrayBuffer());
      console.log(`🔊 [${clientId}] TTS size: ${audioPcm.length} bytes`);
      
      // Amplify for better audibility
      audioPcm = amplifyAudio(audioPcm, 1.8);
      
      // Send in chunks (20ms = 640 bytes at 16kHz)
      const chunkSize = 640;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isClosing || ws.readyState !== 1) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 18));
      }
      
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log(`✅ [${clientId}] Done`);
      
    } catch (err) {
      console.error(`❌ [${clientId}] Error: ${err.message}`);
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  };
  
  // Reset timer on each audio packet
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking || isProcessing || isClosing) return;
    
    packetCount++;
    audioBuffer.push(Buffer.from(data));
    
    if (packetCount % 100 === 0) {
      console.log(`📥 [${clientId}] Packets: ${packetCount}, Buffer: ${audioBuffer.length} chunks`);
    }
    
    // Reset silence timer
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isBotSpeaking && !isClosing) {
        console.log(`🔇 [${clientId}] Processing ${audioBuffer.length} chunks`);
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
    console.error(`❌ WebSocket error ${clientId}: ${err.message}`);
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  // Ready message
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
  console.log(`✅ [${clientId}] Ready for audio`);
});

console.log('✅ Live Audio Server v5.1 ready');
