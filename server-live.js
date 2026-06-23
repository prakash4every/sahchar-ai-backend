import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { Blob } from 'buffer';
import axios from 'axios';
import FormData from 'form-data';

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const MONGODB_URI =
  process.env.MONGODB_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGOBD_URL ||
  'mongodb://MongoDB.railway.internal:27017';

const DB_NAME = 'sahchar_live';
const COLLECTION_NAME = 'conversations';

let db = null;
let conversationsCollection = null;
let mongoClient = null;

// ✅ PROVIDER CONFIGURATION
const providers = {
  groq: {
    name: 'Groq',
    key: process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    chat: true,
    audio: false,
    whisper: true
  },
  openai: {
    name: 'OpenAI',
    key: process.env.OPENAI_API_KEY,
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    chat: true,
    audio: true,
    whisper: true
  },
  deepseek: {
    name: 'DeepSeek',
    key: process.env.DEEPSEEK_API_KEY,
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    chat: true,
    audio: false,
    whisper: false
  },
  kimi: {
    name: 'Kimi',
    key: process.env.KIMI_API_KEY,
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    chat: true,
    audio: false,
    whisper: false
  },
  gemini: {
    name: 'Gemini',
    key: process.env.GEMINI_API_KEY,
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    chat: true,
    audio: false,
    whisper: false
  }
};

// ✅ SMART CHAT - FIXED: max_tokens 50 + temp 0.4
async function smartChat(messages, preferAudio = true) {
    const priorityOrder = ['groq', 'deepseek', 'kimi', 'gemini'];
    const orderedProviders = preferAudio? ['groq', 'deepseek', 'kimi', 'gemini'] : priorityOrder;

    for (const providerName of orderedProviders) {
        const provider = providers[providerName];
        if (!provider ||!provider.key ||!provider.chat) continue;

        try {
            console.log(`🔄 Trying ${provider.name}...`);

            const formattedMessages = messages.map(m => ({
                role: m.role || 'user',
                content: m.content || ''
            }));

            if (provider.name === 'Gemini') {
                const geminiResponse = await axios.post(
                    `${provider.url}?key=${provider.key}`,
                    {
                        contents: [{
                            parts: [{ text: messages.map(m => `${m.role}: ${m.content}`).join('\n') }]
                        }],
                        generationConfig: {
                            maxOutputTokens: 60,
                            temperature: 0.4
                        }
                    },
                    { timeout: 15000 }
                );
                const reply = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) return { reply: reply.trim(), provider: provider.name };
            } else {
                const response = await axios.post(
                    provider.url,
                    {
                        model: provider.model,
                        messages: formattedMessages,
                        max_tokens: 50, // ✅ FIX 1: 100 -> 50 = short replies
                        temperature: 0.4 // ✅ FIX 2: 0.7 -> 0.4 = less hallucination
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${provider.key}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    }
                );
                const reply = response.data.choices?.[0]?.message?.content;
                if (reply) {
                    console.log(`✅ ${provider.name} success!`);
                    return { reply: reply.trim(), provider: provider.name };
                }
            }
        } catch (error) {
            console.error(`❌ ${provider.name} failed:`, error.message);
        }
    }
    return null;
}

// ✅ SMART TRANSCRIPTION - FIXED: verbose_json + no_speech_prob
async function smartTranscription(fileObject) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
        try {
            console.log('🔄 Trying Groq Whisper...');
            const audioBuffer = await fileObject.arrayBuffer();
            const buffer = Buffer.from(audioBuffer);

            const formData = new FormData();
            formData.append('file', buffer, {
                filename: 'speech.wav',
                contentType: 'audio/wav'
            });
            formData.append('model', 'whisper-large-v3-turbo');
            formData.append('language', 'hi');
            formData.append('response_format', 'verbose_json'); // ✅ FIX 3: Get no_speech_prob
            formData.append('prompt', 'Umm, hmm. Arre yaar, kya haal hai?'); // ✅ FIX 4: Better prompt

            const response = await axios.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                formData,
                {
                    headers: {
                        'Authorization': `Bearer ${groqKey}`,
                       ...formData.getHeaders()
                    },
                    timeout: 15000
                }
            );

            // ✅ FIX 5: Check no_speech_prob
            const segments = response.data.segments || [];
            if (segments.length > 0) {
                const avgNoSpeechProb = segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / segments.length;
                if (avgNoSpeechProb > 0.6) {
                    console.log(`⚠ Groq no_speech_prob high: ${avgNoSpeechProb.toFixed(2)}`);
                    return null;
                }
            }

            const transcript = response.data.text;
            if (transcript) {
                console.log(`✅ Groq Whisper: ${transcript}`);
                return transcript;
            }
        } catch (error) {
            console.error('❌ Groq Whisper failed:', error.message);
        }
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            console.log('🔄 Trying OpenAI Whisper...');
            const openai = new OpenAI({ apiKey: openaiKey });
            const transcription = await openai.audio.transcriptions.create({
                file: fileObject,
                model: 'whisper-1',
                language: 'hi',
                prompt: 'Umm, hmm. Arre yaar, kya haal hai?',
                temperature: 0.0,
                response_format: 'verbose_json'
            });

            const segments = transcription.segments || [];
            if (segments.length > 0) {
                const avgNoSpeechProb = segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / segments.length;
                if (avgNoSpeechProb > 0.6) {
                    console.log(`⚠ OpenAI no_speech_prob high: ${avgNoSpeechProb.toFixed(2)}`);
                    return null;
                }
            }

            const text = transcription.text;
            if (text) {
                console.log(`✅ OpenAI Whisper: ${text}`);
                return text;
            }
        } catch (error) {
            console.error('❌ OpenAI Whisper failed:', error.message);
        }
    }

    console.error('❌ All transcription providers failed');
    return null;
}

// ✅ SMART TTS
async function smartTTS(text) {
    console.log(`🔊 TTS Request: "${text.substring(0, 50)}..."`);

    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    if (elevenLabsKey) {
        try {
            console.log('🔄 Trying ElevenLabs TTS...');

            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
                    text: text,
                    model_id: 'eleven_multilingual_v2', // ✅ Better Hindi support
                    voice_settings: { stability: 0.6, similarity_boost: 0.8 },
                    output_format: 'pcm_16000'
                },
                {
                    headers: {
                        'xi-api-key': elevenLabsKey,
                        'Content-Type': 'application/json'
                    },
                    responseType: 'arraybuffer',
                    timeout: 15000
                }
            );

            let pcmData = Buffer.from(response.data);
            console.log(`✅ ElevenLabs PCM generated: ${pcmData.length} bytes`);
            return pcmData;

        } catch (error) {
            console.error('❌ ElevenLabs TTS failed:', error.message);
        }
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            console.log('🔄 Trying OpenAI TTS...');
            const openai = new OpenAI({ apiKey: openaiKey });
            const response = await openai.audio.speech.create({
                model: 'tts-1',
                voice: 'echo',
                input: text,
                response_format: 'pcm',
                speed: 1.00
            });
            const audio = Buffer.from(await response.arrayBuffer());
            console.log(`✅ OpenAI TTS generated: ${audio.length} bytes`);
            return audio;
        } catch (error) {
            console.error('❌ OpenAI TTS failed:', error.message);
        }
    }

    console.warn('⚠ No TTS provider available');
    return null;
}

// ✅ MongoDB Connection
async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.warn('⚠ No MongoDB URI found');
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI, { connectTimeoutMS: 5000, socketTimeoutMS: 45000 });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    conversationsCollection = db.collection(COLLECTION_NAME);
    await conversationsCollection.createIndex({ deviceId: 1, timestamp: -1 });
    console.log('✅ MongoDB connected successfully!');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
  }
}

async function getConversationHistory(deviceId, limit = 5) {
  if (!conversationsCollection ||!deviceId) return [];
  try {
    const history = await conversationsCollection
     .find({ deviceId: deviceId.trim() })
     .sort({ timestamp: -1 })
     .limit(limit)
     .toArray();
    return history.reverse().map(msg => ({ role: msg.role, content: msg.content }));
  } catch (error) {
    return [];
  }
}

async function saveConversation(deviceId, role, content) {
  if (!conversationsCollection ||!deviceId) return;
  try {
    await conversationsCollection.insertOne({ deviceId: deviceId.trim(), role, content, timestamp: new Date() });
  } catch (error) {}
}

async function getLiveGoogleSearch(query) {
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (!serpApiKey) return null;
  try {
    const response = await axios.get('https://serpapi.com/search', { params: { q: query, api_key: serpApiKey, engine: 'google', num: 3 }, timeout: 4000 });
    const results = response.data.organic_results;
    if (results && results.length > 0) {
      return results.map(res => `${res.title}: ${res.snippet}`).join('\n');
    }
  } catch (error) {
    console.error("❌ SerpAPI Failure:", error.message);
  }
  return null;
}

// ✅ FIX 6: Strong cleanTranscript
function cleanTranscript(rawText) {
  let text = rawText.trim();
  if (!text) return "";
  const lowerText = text.toLowerCase();

  // 1. Whisper leaks
  const leaks = ["आम बोलचाल", "दोस्त की बातचीत", "प्रस्तु", "परवारण", "धन्यवाद", "सब्सक्राइब"];
  if (leaks.some(leak => lowerText.includes(leak))) {
    console.log("⚠ Whisper leak filtered");
    return "";
  }

  // 2. Single word repeat 3+ times: "झाल झाल झाल"
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length >= 3 && new Set(words).size === 1) {
    console.log("⚠ Single word loop filtered:", text);
    return "";
  }

  // 3. Char repeat: "भावावावाव"
  if (/([\u0900-\u097F\w])\1{4,}/.test(text)) {
    console.log("⚠ Char repeat filtered");
    return "";
  }

  // 4. Too short after cleaning
  if (text.replace(/[।,.!?]/g, '').trim().length < 3) return "";

  return text;
}

// ✅ START SERVER
await connectMongoDB();

const server = app.listen(PORT, () => {
  console.log(`✅ Live Audio Server v6.6 on ${PORT}`);
  // ✅ FIX 7: Railway keep-alive
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/`).catch(() => {});
  }, 240000);
});

const wss = new WebSocketServer({ server });

app.get('/', (req, res) => res.send('Sahchar Live - v6.6 Ready'));

function calculateRMS(pcmBuffer) {
  let sum = 0;
  const count = pcmBuffer.length / 2;
  if (count === 0) return 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / count) / 32768.0;
}

function pcmToWav(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ============================================================
// ✅ WEBSOCKET ROUTING AND STREAMING
// ============================================================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rawDeviceId = url.searchParams.get('deviceId');
  let deviceId = (rawDeviceId && rawDeviceId!== 'default')? rawDeviceId.trim() : "default_user";
  const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client active: ${connectionId}`);

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let isAudioStreaming = false;
  let isClosing = false;
  let keepAliveInterval = null;
  let processTimer = null;

  keepAliveInterval = setInterval(() => {
    if (ws.readyState === 1 &&!isClosing) { try { ws.ping(); } catch (e) {} }
  }, 10000);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1 &&!isClosing) {
      try { ws.send(data, { binary: isBinary }); return true; } catch (e) { return false; }
    }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;
    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    if (fullAudio.length < 12000) { isProcessing = false; return; } // ✅ FIX 8: 8k -> 12k
    const rms = calculateRMS(fullAudio);
    if (rms < 0.035) { isProcessing = false; return; } // ✅ FIX 9: 0.030 -> 0.035

    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));

    try {
      const wavBuffer = pcmToWav(fullAudio);
      const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      const fileObject = await OpenAI.toFile(audioBlob, 'speech.wav');
      const userMsgRaw = await smartTranscription(fileObject);
      const userMsg = cleanTranscript(userMsgRaw || '');

      if (!userMsg || userMsg.length < 2) { isProcessing = false; return; }
      console.log(`📝 [${connectionId}] User: ${userMsg}`);

      const lowerUserMsg = userMsg.toLowerCase().replace("।", "").trim();
      const userExitKeywords = ["चैट क्लोज", "अलविदा", "बाय"];
      const hasUserRequestedExit = userExitKeywords.some(k => lowerUserMsg.includes(k));

      let botReply = "";
      if (hasUserRequestedExit) {
        botReply = "अच्छा, बाय! फिर मिलते हैं 😊🙏";
      } else {
        await safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
        await saveConversation(deviceId, 'user', userMsg);

        let liveSearchContext = "";
        if (["ट्रेंड", "न्यूज़", "चुनाव", "मैच"].some(t => lowerUserMsg.includes(t))) {
          const webSearchSnippets = await getLiveGoogleSearch(userMsg);
          if (webSearchSnippets) liveSearchContext = `\n\n[SEARCH]:\n${webSearchSnippets}`;
        }

        const previousHistory = await getConversationHistory(deviceId, 5);
        // ✅ FIX 10: Strong system prompt
        const messages = [
          {
            role: 'system',
            content: `तुम "SuperSahchar" हो। नियम: 1. जवाब सिर्फ 1 वाक्य + इमोजी। 2. "मुझे लगता है", "शायद" मत बोलो। 3. User "झाल", "प्रफ" बोले तो: "यार ये क्या बोल रहा 😂 कुछ काम की बात कर" बोलो। 4. किताबी हिंदी बैन।${liveSearchContext}`
          },
         ...previousHistory,
          { role: 'user', content: userMsg }
        ];

        const chatResult = await smartChat(messages, true);
        botReply = chatResult? chatResult.reply : "अरे यार, सब busy है अभी 😊";
      }

      console.log(`🤖 [${connectionId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      if (!hasUserRequestedExit) await saveConversation(deviceId, 'assistant', botReply);

      if (isClosing || ws.readyState!== 1) return;
      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

      const audioPcm = await smartTTS(botReply);
      if (!audioPcm) {
          safeSend(JSON.stringify({ type: 'audio_done' }));
          isBotSpeaking = false; isProcessing = false; return;
      }

      // ✅ FIX 11: Perfect 20ms chunk timing
      console.log(`📦 Sending raw PCM stream: ${audioPcm.length} bytes`);

      const CHUNK_SIZE = 640; // 320 samples = 20ms @ 16kHz
      const CHUNK_DELAY_MS = 20; // ✅ FIX: 26 -> 20 = no underflow

      isAudioStreaming = true;
      let totalSent = 0;

      for (let i = 0; i < audioPcm.length; i += CHUNK_SIZE) {
          if (isClosing || ws.readyState!== 1) break;

          const chunk = audioPcm.subarray(i, Math.min(i + CHUNK_SIZE, audioPcm.length));
          safeSend(chunk, true);
          totalSent += chunk.length;
          await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
      }

      isAudioStreaming = false;
      isBotSpeaking = false;

      console.log(`✅ Safely streamed ${totalSent} bytes of PCM to Android client.`);
      safeSend(JSON.stringify({ type: 'audio_done' }));

      if (hasUserRequestedExit) {
          await new Promise(r => setTimeout(r, 500));
          safeSend(JSON.stringify({ type: 'force_close_ui' }));
      }
      if (!hasUserRequestedExit) safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));

    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
    } finally {
      isProcessing = false;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'interrupt' &&!isAudioStreaming) {
          isBotSpeaking = false; audioBuffer = [];
          if (processTimer) clearTimeout(processTimer);
        }
      } catch (e) {}
      return;
    }
    audioBuffer.push(Buffer.from(data));
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 &&!isProcessing &&!isClosing) processAudio();
    }, 550);
  });

  ws.on('close', () => {
    isClosing = true; isBotSpeaking = false;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });

  ws.on('error', () => { isClosing = true; });
  safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
});

process.on('SIGTERM', async () => {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
