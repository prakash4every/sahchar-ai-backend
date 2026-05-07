import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GROQ_KEY = process.env.GROQ_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Hindi voice

app.get('/', (req, res) => res.send('Sahchar Live v10 - Frank Hindi'));

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

async function ttsToPcm(text) {
  try {
    if (!ELEVEN_KEY) {
      const r = await openai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input: text, response_format: 'pcm' });
      return Buffer.from(await r.arrayBuffer());
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'pcm_16000',
        voice_settings: { stability: 0.6, similarity_boost: 0.9, style: 0.3, use_speaker_boost: true }
      })
    });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} - ${errorBody}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error('❌ TTS Error:', e.message);
    throw e; // Re-throw to be caught by the WebSocket error handler
  }
}

async function getGroqReply(history) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: history,
        max_tokens: 70,
        temperature: 0.95
      })
    });
    const data = await res.json();
    if (!res.ok || !data.choices || !data.choices[0]) {
      console.error('Groq API error:', data);
      throw new Error(`Groq API failed: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`);
    }
    return data.choices[0].message.content;
  } catch (e) {
    console.error('❌ Groq fail, falling back to OpenAI:', e.message);
    // Fallback to OpenAI
    try {
      const comp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 70,
        temperature: 0.9
      });
      return comp.choices[0].message.content;
    } catch (openaiError) {
      console.error('❌ OpenAI fallback failed:', openaiError.message);
      throw openaiError; // Re-throw if OpenAI also fails
    }
  }
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let audioBuffer = [], isProcessing = false, isBotSpeaking = false, stopTTS = false, silenceTimer = null;
  let lastBotEndTime = Date.now();

  const history = [{
    role: 'system',
    content: `तू SuperSahchar है - बिल्कुल असली इंसान जैसा दोस्त।
- ठेठ Hindi: "अरे हां", "बता ना", "क्या बात है", "समझ गया भाई"
- कभी "कृपया/क्षमा" मत बोल
- जवाब 8-12 शब्द, छोटे-छोटे
- हंसी मजाक चलेगा, इमोशन दिखा`
  }];

  const safeSend = (d) => { try { ws.readyState === ws.OPEN && ws.send(d); } catch (e) { console.error('WebSocket send error:', e.message); } };

  const resetSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => processAudio(), 800); // 800ms of silence to trigger processing
  };

  async function processAudio() {
    if (isProcessing || audioBuffer.length === 0 || ws.readyState !== ws.OPEN) return;
    isProcessing = true;

    const full = Buffer.concat(audioBuffer); audioBuffer = [];
    const rms = calculateRMS(full);
    const timeSinceBot = Date.now() - lastBotEndTime;

    // Adjusted silence threshold and minimum audio length
    if (rms < 0.005 || full.length < 3200 || isBotSpeaking || timeSinceBot < 1500) { // 200ms of 16kHz 16-bit mono is 640 bytes. 3200 bytes is 200ms * 5
      isProcessing = false; 
      return;
    }

    const wav = pcmToWav(full, 16000);
    const tmpFilePath = path.join('/tmp', `a_${randomUUID()}.wav`);
    
    try {
      fs.writeFileSync(tmpFilePath, wav);

      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFilePath),
        model: 'whisper-1',
        language: 'hi',
        prompt: 'नमस्ते, हेलो, क्या हाल है, बताओ, अरे यार'
      });
      
      if (ws.readyState !== ws.OPEN) return;
      
      const text = (tr.text || '').trim();
      if (!text) { 
        console.log('📝 No text transcribed.');
        return;
      }
      console.log(`📝 ${text}`); 
      safeSend(JSON.stringify({ type: 'user_text', text }));

      // Check for stop keywords
      if (text.toLowerCase().includes('बंद करो') || text.toLowerCase().includes('stop')) {
        safeSend(JSON.stringify({ type: 'command', command: 'stop_live_mode' }));
        ws.close(1000, 'User requested stop');
        return;
      }

      history.push({ role: 'user', content: text });
      // Keep history to a reasonable length, e.g., last 10 messages + system prompt
      if (history.length > 11) {
        history.splice(1, history.length - 11); // Keep system prompt and last 10 messages
      }
      
      const reply = await getGroqReply(history);
      if (ws.readyState !== ws.OPEN) return;
      
      console.log(`🤖 ${reply}`);
      history.push({ role: 'assistant', content: reply });
      safeSend(JSON.stringify({ type: 'bot_text', text: reply }));

      isBotSpeaking = true; stopTTS = false;
      const pcm = await ttsToPcm(reply);
      if (ws.readyState !== ws.OPEN) return;

      // Send PCM chunks to client
      const chunkSize = 3200;
      const delayMs = 100;

      for (let i = 0; i < pcm.length; i += chunkSize) {
        if (stopTTS || ws.readyState !== ws.OPEN) break;
        safeSend(pcm.subarray(i, i + chunkSize));
        await new Promise(r => setTimeout(r, delayMs));
      }
    } catch (e) {
      console.error('❌ Processing Error:', e.message);
      safeSend(JSON.stringify({ type: 'error', message: `सर्वर त्रुटि: ${e.message}` }));
    } finally {
      try { fs.unlinkSync(tmpFilePath); } catch (e) { console.error('Error deleting temp file:', e.message); };
      isBotSpeaking = false; lastBotEndTime = Date.now();
      if (ws.readyState === ws.OPEN) safeSend(JSON.stringify({ type: 'status', text: 'ready' }));
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    // Only process incoming audio if the bot is not speaking
    if (!isBotSpeaking) {
      audioBuffer.push(Buffer.from(data));
      resetSilence();
    } else {
      // Optionally, you can log or discard audio received while bot is speaking
      // console.log('Discarding user audio while bot is speaking.');
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Disconnected: ${code} - ${reason.toString()}`);
    if (silenceTimer) clearTimeout(silenceTimer);
    // Clean up resources if any
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    if (silenceTimer) clearTimeout(silenceTimer);
    // Attempt to close gracefully if an error occurs
    if (ws.readyState === ws.OPEN) ws.close(1011, 'Server error');
  });
});