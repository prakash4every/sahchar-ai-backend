import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v5.3 (Ultra Stable) on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - Ultra Stable v5.3 (Buffer Fixed)'));

// Convert 16kHz PCM to WAV (Buffer only - No Disk Write)
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
function amplifyAudio(pcmData, factor = 1.5) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

wss.on('connection', (ws, req) => {
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
    packetCount = 0;
    
    // Minimum 0.5 seconds of audio (8000 bytes at 16kHz/16bit)
    if (fullAudio.length < 8000) {
      isProcessing = false;
      return;
    }
    
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    try {
      // 1. Convert PCM to WAV Buffer
      const wavBuffer = pcmToWav(fullAudio);
      
      console.log(`📞 [${clientId}] Uploading In-Memory Buffer to Whisper...`);
      
      // ✅ फ़िक्स: OpenAI.toFile का उपयोग करके सीधे बफ़र को मान्य फ़ाइल ऑब्जेक्ट में बदलना
      const fileObject = await OpenAI.toFile(wavBuffer, 'speech.wav', { type: 'audio/wav' });
      
      // Transcribe (Whisper API)
      const transcription = await openai.audio.transcriptions.create({
        file: fileObject,
        model: 'whisper-1',
        language: 'hi'
      });
      
      const userMsg = transcription.text.trim();
      if (!userMsg || userMsg.length < 2) throw new Error('Empty transcription');
      
      console.log(`📝 [${clientId}] User: ${userMsg}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
      
      if (isClosing) return;

      // 2. Generate response (GPT-4o-mini)
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
        max_tokens: 60,
        temperature: 0.6
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 [${clientId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      
      if (isClosing || ws.readyState !== 1) return;
      
      // 3. Text-to-Speech (16kHz PCM, nova voice)
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: botReply,
        response_format: 'pcm',
        speed: 1.00
      });
      
      let audioPcm = Buffer.from(await tts.arrayBuffer());
      audioPcm = amplifyAudio(audioPcm, 1.6);
      
      // Send in chunks (20ms = 640 bytes at 16kHz)
      const chunkSize = 640;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isClosing || ws.readyState !== 1 || !isBotSpeaking) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 19));
      }
      
      if (isBotSpeaking) {
        safeSend(JSON.stringify({ type: 'audio_done' }));
      }
      
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log(`✅ [${clientId}] Finished Processing`);
      
    } catch (err) {
      console.error(`❌ [${clientId}] Error during pipeline: ${err.message}`);
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      isProcessing = false;
    }
  };
  
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'interrupt') {
          console.log(`🛑 [${clientId}] User interrupted the bot.`);
          isBotSpeaking = false; 
          audioBuffer = [];
          packetCount = 0;
          if (processTimer) clearTimeout(processTimer);
        }
      } catch (e) {}
      return;
    }

    if (isBotSpeaking || isProcessing || isClosing) return;
    
    packetCount++;
    audioBuffer.push(Buffer.from(data));
    
    // 500ms साइलेंस थ्रेशोल्ड फॉर फ़ास्ट रिस्पॉन्स
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isBotSpeaking && !isClosing) {
        processAudio();
      }
    }, 500);
  });
  
  ws.on('pong', () => {});
  
  ws.on('close', (code, reason) => {
    console.log(`🔌 Client ${clientId} disconnected: ${code} - ${reason}`);
    isClosing = true;
    isBotSpeaking = false;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  ws.on('error', (err) => {
    console.error(`❌ WebSocket error ${clientId}: ${err.message}`);
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
  console.log(`✅ [${clientId}] Ready for audio sync`);
});
