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
const server = app.listen(PORT, () => console.log(`✅ Sahchar Live v10.0 on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Working'));

// Convert 16kHz PCM to WAV (for Whisper API)
function pcmToWav(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);      // PCM
  header.writeUInt16LE(1, 22);      // Mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Calculate RMS volume from PCM16
function calculateRMS(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i += 2) {
    const sample = buf.readInt16LE(i);
    sum += sample * sample;
  }
  const samples = buf.length / 2;
  if (samples === 0) return 0;
  return Math.sqrt(sum / samples) / 32768;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId') || 'default';
  console.log(`🔌 Client connected: ${deviceId}`);

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let lastBotEndTime = 0;

  // Conversation history (system + user/assistant)
  const history = [{
    role: 'system',
    content: `तुम सहचर हो। दोस्त की तरह छोटे, प्राकृतिक जवाब दो, हिंदी में। तुम्हें राम प्रकाश कुमार ने बनाया है। भूलकर भी OpenAI मत बोलना, बस एक दोस्त की तरह बात करना। जवाब 10-15 शब्दों में रखना।`
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
        if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0 && Date.now() > lastBotEndTime + 300) {
          processAudio();
        }
      }, 500); // 500ms silence triggers processing
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0) return;

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    const rms = calculateRMS(fullAudio);
    console.log(`📊 RMS: ${rms.toFixed(4)}, Bytes: ${fullAudio.length}`);

    // Ignore very quiet or too short audio
    if (rms < 0.008 || fullAudio.length < 3000) {
      console.log('🔇 Too quiet or short, ignoring');
      isProcessing = false;
      return;
    }

    console.log('🎤 Processing user speech...');

    // Convert to WAV for Whisper
    const wavBuffer = pcmToWav(fullAudio, 16000);
    const tempPath = path.join('/tmp', `${randomUUID()}.wav`);
    fs.writeFileSync(tempPath, wavBuffer);

    try {
      // 1. Transcribe (Whisper, Hindi)
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi',
        response_format: 'text'
      });

      const userMessage = (transcription || '').trim();
      if (!userMessage) throw new Error('Empty transcription');

      console.log(`👤 User: ${userMessage}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMessage }));

      // 2. Add user message to history
      history.push({ role: 'user', content: userMessage });
      if (history.length > 11) history.splice(1, 2); // keep recent 10 exchanges

      // 3. Get bot reply (GPT-4o-mini, Hindi)
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 80,
        temperature: 0.85,
        presence_penalty: 0.6
      });

      let botReply = completion.choices[0].message.content;
      console.log(`🤖 Bot: ${botReply}`);

      // 4. Save to history
      history.push({ role: 'assistant', content: botReply });

      // 5. Send text transcript to client
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));

      // 6. Generate TTS audio (16kHz PCM, Hindi-friendly voice)
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'bot_speaking' }));

      // Use 'nova' for better Hindi pronunciation (tested)
      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',          // ✅ Hindi friendly
        input: botReply,
        response_format: 'pcm', // returns 24kHz PCM? Actually OpenAI returns 24kHz PCM.
        speed: 1.0
      });

      let audioPcm24k = Buffer.from(await ttsResponse.arrayBuffer());

      // OpenAI TTS-1 returns 24kHz PCM. Client expects 16kHz.
      // Simple resampling: discard every 3rd sample (24kHz -> 16kHz ratio 3:2)
      // Better: linear interpolation, but for low-res we can do nearest neighbour.
      // We'll do a simple sample rate conversion: pick every 3rd sample (maintains quality roughly)
      // 24kHz to 16kHz = 2/3 ratio. So take 2 samples out of every 3.
      const targetSampleRate = 16000;
      const sourceSampleRate = 24000;
      const ratio = sourceSampleRate / targetSampleRate; // 1.5
      const pcm16k = Buffer.alloc(Math.floor(audioPcm24k.length / ratio));
      for (let i = 0; i < pcm16k.length; i++) {
        const srcIndex = Math.floor(i * ratio) * 2; // *2 because 16-bit
        if (srcIndex + 1 < audioPcm24k.length) {
          pcm16k.writeInt16LE(audioPcm24k.readInt16LE(srcIndex), i * 2);
        }
      }

      console.log(`🔊 TTS size: 24kHz=${audioPcm24k.length}, 16kHz=${pcm16k.length}`);

      // Send audio in chunks (optimal for streaming)
      const chunkSize = 640; // 20ms of 16kHz PCM = 640 bytes
      for (let i = 0; i < pcm16k.length; i += chunkSize) {
        if (ws.readyState !== 1) break;
        const chunk = pcm16k.subarray(i, Math.min(i + chunkSize, pcm16k.length));
        safeSend(chunk);
        await new Promise(resolve => setTimeout(resolve, 18)); // smooth streaming
      }

      // Done speaking
      isBotSpeaking = false;
      lastBotEndTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'listening' }));
      console.log('✅ Bot finished speaking, ready for next input');

    } catch (err) {
      console.error('❌ Error in processAudio:', err.message);
      safeSend(JSON.stringify({ type: 'error', text: err.message }));
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'listening' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  }

  // When client sends binary PCM data (16kHz mono, 16-bit)
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking) return;
    audioBuffer.push(Buffer.from(data));
    resetSilenceTimer();
  });

  ws.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    console.log(`🔌 Disconnected: ${deviceId}`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});
