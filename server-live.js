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
const server = app.listen(PORT, () => console.log(`✅ Full Duplex Live v2.0 on ${PORT}`));
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

function amplifyAudio(pcmData, factor = 2.5) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

const clientHistories = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 Client connected (Full Duplex Mode v2.0)');

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let clientId = randomUUID();
  let isInterrupted = false;
  let ttsStartTime = 0;
  let lastAudioTime = Date.now();
  let totalBytesReceived = 0;
  let packetCount = 0;
  let lastPacketTime = Date.now();

  console.log(`📱 Client ID: ${clientId.substring(0, 8)}`);

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
        console.error('Send error:', e.message);
        return false;
      }
    }
    return false;
  };

  const interruptBot = () => {
    if (isBotSpeaking) {
      console.log('🔴 USER INTERRUPTED BOT');
      isInterrupted = true;
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बीच में रोका गया, सुन रहा हूँ... 🎤' }));
    }
  };

  const processNow = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && !isProcessing && audioBuffer.length > 8000) {
      console.log(`🔄 FORCE processing ${audioBuffer.length} bytes`);
      processAudio();
    }
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    lastAudioTime = Date.now();
    silenceTimer = setTimeout(() => {
      if (!isBotSpeaking && !isProcessing && audioBuffer.length > 8000) {
        console.log(`🔄 Silence detected, processing ${audioBuffer.length} bytes`);
        processAudio();
      } else if (audioBuffer.length > 8000) {
        console.log(`⚠️ Buffer has data but can't process: botSpeaking=${isBotSpeaking}, processing=${isProcessing}`);
      }
    }, 800);
  };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0) {
      console.log(`Skip processAudio: isProcessing=${isProcessing}, buffer=${audioBuffer.length}`);
      return;
    }

    console.log(`🚀 STARTING processAudio with buffer size: ${audioBuffer.length} chunks`);
    isProcessing = true;
    isInterrupted = false;

    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(fullAudio);
    const duration = fullAudio.length / 32000;
    console.log(`🎤 Audio RMS: ${rms.toFixed(4)}, Length: ${fullAudio.length}, Duration: ${duration.toFixed(2)}s`);
    
    if (fullAudio.length < 8000 || rms < 0.002) {
      console.log(`Audio too short or too quiet (rms=${rms.toFixed(4)}), ignoring`);
      isProcessing = false;
      return;
    }

    console.log('🔄 Processing user speech...');
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));

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
      if (!userMessage || userMessage.length < 2) {
        throw new Error('Empty transcription');
      }

      console.log(`📝 User: ${userMessage}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMessage }));

      const history = clientHistories.get(clientId) || [];
      history.push({ role: 'user', content: userMessage });

      while (history.length > 21) {
        history.splice(1, 2);
      }

      safeSend(JSON.stringify({ type: 'status', text: 'सोच रहा हूँ... 🤔' }));

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

      if (isInterrupted) {
        console.log('Skipping TTS due to interruption');
        safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
        isProcessing = false;
        return;
      }

      isBotSpeaking = true;
      ttsStartTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: botReply,
        response_format: 'pcm',
        speed: 0.95
      });

      let audioPcm = Buffer.from(await ttsResponse.arrayBuffer());
      console.log(`🔊 TTS PCM size: ${audioPcm.length} bytes`);

      audioPcm = amplifyAudio(audioPcm, 2.5);

      const chunkSize = 3000;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isInterrupted) {
          console.log('🔴 TTS interrupted mid-stream');
          break;
        }
        if (ws.readyState !== 1) break;

        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 60));
      }

      safeSend(JSON.stringify({ type: 'audio_done' }));
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log('✅ Bot finished speaking');

    } catch (error) {
      console.error('❌ Error:', error.message);
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'audio_done' }));
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    packetCount++;
    lastPacketTime = Date.now();
    
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'interrupt') {
          interruptBot();
        }
      } catch(e) {}
      return;
    }
    
    totalBytesReceived += data.length;
    
    // Log every 100 packets
    if (packetCount % 100 === 0) {
      console.log(`📥 Audio packet #${packetCount}: ${data.length} bytes, Total: ${totalBytesReceived} bytes`);
    }
    
    if (packetCount === 1) {
      console.log(`🎙️ FIRST AUDIO PACKET RECEIVED! Size: ${data.length} bytes`);
    }

    if (isBotSpeaking) {
      if (Date.now() - ttsStartTime < 800) return;
      console.log('🔴 User spoke while bot speaking - interrupting');
      interruptBot();
    }
    
    audioBuffer.push(Buffer.from(data));
    
    // Reset timer on each packet
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (!isBotSpeaking && !isProcessing && audioBuffer.length > 8000) {
        console.log(`🔄 Timer triggered, processing ${audioBuffer.length} bytes`);
        processAudio();
      }
    }, 800);
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Client ${clientId.substring(0, 8)} disconnected: ${code} - ${reason}`);
    if (silenceTimer) clearTimeout(silenceTimer);
    clientHistories.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
  
  // Send initial status
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
});

console.log('✅ WebSocket server ready v2.0');
