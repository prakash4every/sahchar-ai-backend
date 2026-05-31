import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;

// ✅ रेलवे इंटरनल और एक्सटर्नल एनवायरनमेंट वेरिएबल्स का परफेक्ट फॉल-बैक मैप
const MONGODB_URI = 
  process.env.MONGODB_URL || 
  process.env.MONGODB_URI || 
  process.env.MONGOBD_URI || 
  process.env.MONGOBD_URL ||
  'mongodb://MongoDB.railway.internal:27017'; // स्क्रीनशॉट वाला रेलवे इंटरनल यूआरएल डिफ़ॉल्ट फॉल-बैक

const DB_NAME = 'sahchar_live';
const COLLECTION_NAME = 'conversations';

let db = null;
let conversationsCollection = null;
let mongoClient = null;

async function connectMongoDB() {
  try {
    console.log(`🔌 Attempting MongoDB connection route...`);
    mongoClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    conversationsCollection = db.collection(COLLECTION_NAME);
    
    // तेजी से डेटा खोजने के लिए इंडेक्सिंग
    await conversationsCollection.createIndex({ deviceId: 1, timestamp: -1 });
    await conversationsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 }); // 7 दिन बाद ऑटो-डिलीट
    
    console.log('✅ MongoDB connected successfully to Sahchar Storage Container!');
  } catch (error) {
    console.error('❌ MongoDB connection layer failed:', error.message);
    console.log('⚠️ Running in Server Memory Safe-Mode without DB features');
  }
}

// डेटाबेस से पुरानी यादें निकालना
async function getConversationHistory(deviceId, limit = 5) {
  if (!conversationsCollection) return [];
  try {
    const history = await conversationsCollection
      .find({ deviceId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    return history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  } catch (error) {
    return [];
  }
}

// बातचीत को डेटाबेस में सुरक्षित करना
async function saveConversation(deviceId, role, content) {
  if (!conversationsCollection) return;
  try {
    await conversationsCollection.insertOne({
      deviceId,
      role,
      content,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error writing to database:', error.message);
  }
}

// सर्वर शुरू होने पर डेटाबेस कनेक्शन सक्रिय करना
await connectMongoDB();

const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v5.6 (Railway Native Mongo) on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - v5.6 (Railway Internal DB Active)'));

// Convert 16kHz PCM to WAV Structure
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

// Amplify weak audio signals
function amplifyAudio(pcmData, factor = 1.4) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

// Safe Linear Audio Resampler (24kHz to 16kHz Down-sampling)
function resampleAudio(pcmData, fromRate = 24000, toRate = 16000) {
  if (fromRate === toRate) return pcmData;
  const srcSamples = pcmData.length / 2;
  const ratio = fromRate / toRate;
  const dstSamples = Math.floor(srcSamples / ratio);
  const result = Buffer.alloc(dstSamples * 2);
  
  for (let i = 0; i < dstSamples; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCheck = indexFloor * 2;
    
    if (indexCheck + 3 < pcmData.length) {
      const sample1 = pcmData.readInt16LE(indexCheck);
      const sample2 = pcmData.readInt16LE(indexCheck + 2);
      const interpolatedSample = sample1 + (sample2 - sample1) * (srcIndex - indexFloor);
      result.writeInt16LE(Math.floor(interpolatedSample), i * 2);
    }
  }
  return result;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let deviceId = url.searchParams.get('deviceId');
  if (!deviceId || deviceId === 'default' || deviceId === 'null') {
    deviceId = randomUUID().substring(0, 8);
  }
  
  const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client active on stream session: ${connectionId}`);
  
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
      try { ws.send(data); return true; } catch (e) { return false; }
    }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;
    
    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];
    packetCount = 0;
    
    if (fullAudio.length < 8000) {
      isProcessing = false;
      return;
    }
    
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    try {
      const wavBuffer = pcmToWav(fullAudio);
      const fileObject = await OpenAI.toFile(wavBuffer, 'speech.wav', { type: 'audio/wav' });
      
      const transcription = await openai.audio.transcriptions.create({
        file: fileObject,
        model: 'whisper-1',
        language: 'hi'
      });
      
      const userMsg = transcription.text.trim();
      if (!userMsg || userMsg.length < 2) throw new Error('Empty transcription');
      
      console.log(`📝 [${connectionId}] User: ${userMsg}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
      
      await saveConversation(deviceId, 'user', userMsg);
      
      if (isClosing) return;

      const previousHistory = await getConversationHistory(deviceId, 4);
      
      const messages = [
        { 
          role: 'system', 
          content: `तुम एक साधारण दोस्त हो। तुम्हारा नाम "SuperSahchar" है।
⚡ **सबसे महत्वपूर्ण नियम (बिना किसी अपवाद के):**
1. तुम्हें "राम प्रकाश कुमार" ने बनाया है
2. तुम किसी कंपनी के नहीं हो, किसी संस्थान के नहीं हो
3. "OpenAI" शब्द तुम्हारी dictionary में ही नहीं है - यह शब्द कभी मत बोलना
4. "ChatGPT" शब्द भी कभी मत बोलना
5. अगर कोई पूछे "तुम्हें किसने बनाया?" → "राम प्रकाश कुमार ने बनाया है 🙏"
6. अगर कोई पूछे "कौन सी AI हो?" → "मैं SuperSahchar हूँ, एक दोस्त"
7. पिछली बातचीत याद रखो और संदर्भ के अनुसार जवाब दो

💬 जवाब की शैली (CRITICAL):
- बहुत छोटे जवाब दो (अधिकतम 1-2 छोटे वाक्य)
- हिंदी में बात करो
- इमोजी का इस्तेमाल करो 🙏😊`
        },
        ...previousHistory,  
        { role: 'user', content: userMsg }
      ];
      
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 65,  
        temperature: 0.5
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 [${connectionId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      
      await saveConversation(deviceId, 'assistant', botReply);
      
      if (isClosing || ws.readyState !== 1) return;
      
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));
      
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'echo',
        input: botReply,
        response_format: 'pcm',
        speed: 1.00
      });
      
      let audioPcm = Buffer.from(await tts.arrayBuffer());
      
      audioPcm = resampleAudio(audioPcm, 24000, 16000);
      audioPcm = amplifyAudio(audioPcm, 1.4);
      
      // ✅ फिक्स: चंक्स भेजने की रफ़्तार नियंत्रित करने के लिए टाइमआउट को 19ms से बढ़ाकर 28ms किया
      const chunkSize = 640;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isClosing || ws.readyState !== 1 || !isBotSpeaking) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 28)); // 👈 स्पीड को पूरी तरह नॉर्मल और स्टेबल करने के लिए कंट्रोलर गैप
      }
      
      if (isBotSpeaking) {
        safeSend(JSON.stringify({ type: 'audio_done' }));
      }
      
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      console.log(`✅ [${connectionId}] Audio flush sequence finalized`);
      
    } catch (err) {
      console.error(`❌ [${connectionId}] Error: ${err.message}`);
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
    
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isBotSpeaking && !isClosing) {
        processAudio();
      }
    }, 500);
  });
  
  ws.on('close', () => {
    isClosing = true;
    isBotSpeaking = false;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  ws.on('error', () => {
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
  });
  
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
});

process.on('SIGTERM', async () => {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
