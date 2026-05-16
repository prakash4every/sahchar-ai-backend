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
const server = app.listen(PORT, () => console.log(`✅ Full Duplex Live v1.0 on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Full Duplex Working'));

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

function amplifyAudio(pcmData, factor = 2.0) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

// Store conversation history per connection
const clientHistories = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 Client connected (Full Duplex Mode)');
  
  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let clientId = randomUUID();
  let currentTTSStream = null;
  let isInterrupted = false;
  
  // Initialize conversation history
  clientHistories.set(clientId, [{
    role: 'system',
    content: `तुम सहचर हो। एक दोस्त की तरह बात करो। 
    नियम:
    1. सिर्फ हिंदी या हिंग्लिश में बात करो
    2. जवाब छोटे और प्राकृतिक रखो (10-15 शब्द)
    3. तुम्हें राम प्रकाश कुमार ने बनाया है
    4. भूलकर भी OpenAI, ChatGPT या AI मत बोलना
    5. इमोजी का इस्तेमाल करो 🙏😊`
  }]);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  };

  // Function to interrupt bot speaking
  const interruptBot = () => {
    if (isBotSpeaking) {
      console.log('🔴 USER INTERRUPTED BOT');
      isInterrupted = true;
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बीच में रोका गया, सुन रहा हूँ... 🎤' }));
    }
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
      silenceTimer = setTimeout(() => {
        if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0) {
          processAudio();
        }
      }, 500); // 500ms silence triggers processing
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0) return;
    
    isProcessing = true;
    isInterrupted = false;
    
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(fullAudio);
    console.log(`🎤 Audio RMS: ${rms.toFixed(4)}, Length: ${fullAudio.length}`);
    
    if (rms < 0.004 || fullAudio.length < 1200) {
      console.log('Audio too quiet or too short, ignoring');
      isProcessing = false;
      return;
    }

    console.log('🔄 Processing user speech...');
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
      
      // Keep last 10 exchanges
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
      
      // Check if interrupted before speaking
      if (isInterrupted) {
        console.log('Skipping TTS due to interruption');
        safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
        isProcessing = false;
        return;
      }
      let ttsStartTime = 0;
      isBotSpeaking = true;
      ttsStartTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      // Generate speech (streaming)
      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: botReply,
        response_format: 'pcm',
        speed: 0.95
      });
      
      let audioPcm = Buffer.from(await ttsResponse.arrayBuffer());
      console.log(`🔊 TTS PCM size: ${audioPcm.length} bytes`);
      
      // Amplify audio
      audioPcm = amplifyAudio(audioPcm, 3.5);
      
      // Send audio chunks
      const chunkSize = 3000;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        // Check for interruption during playback
        if (isInterrupted) {
          console.log('🔴 TTS interrupted mid-stream');
          break;
        }
        if (ws.readyState !== 1) break;
        
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 60));
      }
      
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log('✅ Bot finished speaking');

    } catch (error) {
      console.error('❌ Error:', error.message);
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Handle text messages (like interrupt commands)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'interrupt') {
          interruptBot();
        }
      } catch(e) {}
      return;
    }
    
    // If user is speaking and bot is speaking, interrupt bot
    if (isBotSpeaking) {
      if (Date.now() - ttsStartTime < 800) return;
      interruptBot();
      // Still add to buffer for next processing
      audioBuffer.push(Buffer.from(data));
      resetSilenceTimer();
      return;
    }
    
    audioBuffer.push(Buffer.from(data));
    resetSilenceTimer();
  });
  
  ws.on('close', () => {
    console.log(`🔌 Client ${clientId.substring(0, 8)} disconnected`);
    if (silenceTimer) clearTimeout(silenceTimer);
    clientHistories.delete(clientId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});
