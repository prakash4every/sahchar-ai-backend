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

// ✅ MongoDB Connection (using existing env var)
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGOBD_URI || process.env.MONGOBD_URL;
const DB_NAME = 'sahchar_live';
const COLLECTION_NAME = 'conversations';

let db = null;
let conversationsCollection = null;
let mongoClient = null;

async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ No MongoDB URI found - running without memory');
    return;
  }
  
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    conversationsCollection = db.collection(COLLECTION_NAME);
    
    // Create indexes for faster queries
    await conversationsCollection.createIndex({ deviceId: 1, timestamp: -1 });
    await conversationsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 }); // Auto-delete after 7 days
    
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
  }
}

// Get conversation history for a device
async function getConversationHistory(deviceId, limit = 10) {
  if (!conversationsCollection) return [];
  
  try {
    const history = await conversationsCollection
      .find({ deviceId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    // Reverse to maintain chronological order (oldest first)
    return history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  } catch (error) {
    console.error('Error fetching history:', error.message);
    return [];
  }
}

// Save conversation to database
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
    console.error('Error saving conversation:', error.message);
  }
}

// Clear old conversations
async function clearOldConversations(daysOld = 7) {
  if (!conversationsCollection) return;
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  const result = await conversationsCollection.deleteMany({
    timestamp: { $lt: cutoffDate }
  });
  
  if (result.deletedCount > 0) {
    console.log(`🧹 Cleared ${result.deletedCount} old conversations`);
  }
}

// Call MongoDB connection
await connectMongoDB();

const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v5.4 (With Memory) on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - v5.4 (With Memory & MongoDB)'));

// Health check endpoint
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  mongodb: !!conversationsCollection,
  version: '5.4'
}));

// Convert 16kHz PCM to WAV
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

// Convert 24kHz to 16kHz if needed
function resampleAudio(pcmData, fromRate = 24000, toRate = 16000) {
  if (fromRate === toRate) return pcmData;
  
  const ratio = toRate / fromRate; // 16000/24000 = 2/3
  const sampleCount = pcmData.length / 2;
  const newSampleCount = Math.floor(sampleCount * ratio);
  const result = Buffer.alloc(newSampleCount * 2);
  
  for (let i = 0; i < newSampleCount; i++) {
    const srcIndex = Math.floor(i / ratio) * 2;
    if (srcIndex + 1 < pcmData.length) {
      const sample = pcmData.readInt16LE(srcIndex);
      result.writeInt16LE(sample, i * 2);
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
  
  // Store deviceId for this connection
  const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client connected: ${connectionId} (deviceId: ${deviceId})`);
  
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
      console.log(`⚠️ [${connectionId}] Audio too short: ${fullAudio.length} bytes`);
      isProcessing = false;
      return;
    }
    
    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));
    
    try {
      const wavBuffer = pcmToWav(fullAudio);
      console.log(`📞 [${connectionId}] Uploading to Whisper...`);
      
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
      
      // ✅ Save user message to MongoDB
      await saveConversation(deviceId, 'user', userMsg);
      
      if (isClosing) return;

      // ✅ Get previous conversation history
      const previousHistory = await getConversationHistory(deviceId, 10);
      
      // ✅ Build messages array with memory
      const messages = [
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
7. पिछली बातचीत याद रखो और संदर्भ के अनुसार जवाब दो

💬 जवाब:
- मददगार और मैत्रीपूर्ण बनो
- हिंदी में बात करो
- इमोजी का इस्तेमाल करो 🙏😊
- अगर पूछे तो नाम "राम प्रकाश कुमार" ही बताना`
        },
        ...previousHistory,  // ✅ Previous conversation from MongoDB
        { role: 'user', content: userMsg }
      ];
      
      // ✅ Generate response with longer tokens
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 200,  // ✅ Increased for longer answers
        temperature: 0.7
      });
      
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 [${connectionId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      
      // ✅ Save bot response to MongoDB
      await saveConversation(deviceId, 'assistant', botReply);
      
      if (isClosing || ws.readyState !== 1) return;
      
      // 3. Text-to-Speech
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
      
      // OpenAI returns 24kHz, convert to 16kHz for client
      audioPcm = resampleAudio(audioPcm, 24000, 16000);
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
      console.log(`✅ [${connectionId}] Finished Processing`);
      
    } catch (err) {
      console.error(`❌ [${connectionId}] Error: ${err.message}`);
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      safeSend(JSON.stringify({ type: 'error', text: err.message }));
    } finally {
      isProcessing = false;
    }
  };
  
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'interrupt') {
          console.log(`🛑 [${connectionId}] User interrupted bot`);
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
    
    // 500ms silence threshold for fast response
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isBotSpeaking && !isClosing) {
        processAudio();
      }
    }, 500);
  });
  
  ws.on('pong', () => {});
  
  ws.on('close', (code, reason) => {
    console.log(`🔌 Client ${connectionId} disconnected: ${code} - ${reason}`);
    isClosing = true;
    isBotSpeaking = false;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  ws.on('error', (err) => {
    console.error(`❌ WebSocket error ${connectionId}: ${err.message}`);
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });
  
  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
  console.log(`✅ [${connectionId}] Ready for audio sync`);
});

// Cleanup old conversations every 24 hours
setInterval(() => {
  clearOldConversations(7);
}, 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing MongoDB connection...');
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
