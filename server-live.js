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

// ✅ PROVIDER CONFIGURATION (Updated Models)
const providers = {
  groq: {
    name: 'Groq',
    key: process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',  // ✅ Updated
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
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',  // ✅ Updated
    chat: true,
    audio: false,
    whisper: false
  }
};

// ✅ SMART CHAT (Groq Primary - Fixed Format)
async function smartChat(messages, preferAudio = true) {
    const priorityOrder = ['groq', 'deepseek', 'kimi', 'gemini'];
    const orderedProviders = preferAudio ? ['groq', 'deepseek', 'kimi', 'gemini'] : priorityOrder;

    for (const providerName of orderedProviders) {
        const provider = providers[providerName];
        if (!provider || !provider.key || !provider.chat) continue;

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
                        }]
                    },
                    { timeout: 15000 }
                );
                const reply = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) return { reply, provider: provider.name };
            } else {
                const response = await axios.post(
                    provider.url,
                    {
                        model: provider.model,
                        messages: formattedMessages,
                        max_tokens: 100,
                        temperature: 0.7
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
                    return { reply, provider: provider.name };
                }
            }
        } catch (error) {
            console.error(`❌ ${provider.name} failed:`, error.message);
            if (error.response) {
                console.error(`Status: ${error.response.status}`);
                console.error(`Data: ${JSON.stringify(error.response.data)}`);
            }
        }
    }
    return null;
}

// ✅ SMART TRANSCRIPTION (Groq Whisper Primary)
async function smartTranscription(fileObject) {
    // 1. Try Groq Whisper
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
            formData.append('response_format', 'json');

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
            const transcript = response.data.text;
            if (transcript) {
                console.log(`✅ Groq Whisper: ${transcript}`);
                return transcript;
            }
        } catch (error) {
            console.error('❌ Groq Whisper failed:', error.message);
        }
    }

    // 2. Try OpenAI Whisper (Fallback)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            console.log('🔄 Trying OpenAI Whisper...');
            const openai = new OpenAI({ apiKey: openaiKey });
            const transcription = await openai.audio.transcriptions.create({
                file: fileObject,
                model: 'whisper-1',
                language: 'hi',
                prompt: 'नमस्ते।',
                temperature: 0.0
            });
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

// ✅ SMART TTS (ElevenLabs Direct PCM - No amplification)
async function smartTTS(text) {
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    if (elevenLabsKey) {
        try {
            console.log('🔄 Trying ElevenLabs TTS...');
            
            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
                    text: text,
                    model_id: 'eleven_monolingual_v1',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    },
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
            
            // ✅ Return raw PCM (no amplification)
            return pcmData;
            
        } catch (error) {
            console.error('❌ ElevenLabs TTS failed:', error.message);
        }
    }

    // Fallback: OpenAI TTS
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

    console.warn('⚠️ No TTS provider available');
    return null;
}

// ✅ MongoDB Connection
async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ No MongoDB URI found - running without memory');
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    conversationsCollection = db.collection(COLLECTION_NAME);
    
    await conversationsCollection.createIndex({ deviceId: 1, timestamp: -1 });
    await conversationsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 }); 
    
    console.log('✅ MongoDB connected successfully to Sahchar Storage Container!');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
  }
}

async function getConversationHistory(deviceId, limit = 5) {
  if (!conversationsCollection || !deviceId) return [];
  try {
    const history = await conversationsCollection
      .find({ deviceId: deviceId.trim() })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  } catch (error) {
    console.error('Error fetching history:', error.message);
    return [];
  }
}

async function saveConversation(deviceId, role, content) {
  if (!conversationsCollection || !deviceId) return;
  try {
    await conversationsCollection.insertOne({
      deviceId: deviceId.trim(),
      role,
      content,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error saving conversation:', error.message);
  }
}

async function getLiveGoogleSearch(query) {
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (!serpApiKey) return null;

  try {
    const response = await axios.get('https://serpapi.com/search', {
      params: { q: query, api_key: serpApiKey, engine: 'google', num: 3 },
      timeout: 4000 
    });
    const results = response.data.organic_results;
    if (results && results.length > 0) {
      return results.map(res => `${res.title}: ${res.snippet}`).join('\n');
    }
  } catch (error) {
    console.error("❌ SerpAPI Search Engine Failure:", error.message);
  }
  return null;
}

function cleanTranscript(rawText) {
  let text = rawText.trim();
  if (!text) return "";
  const lowerText = text.toLowerCase();
  
  if (
    lowerText.includes("आम बोलचाल") || 
    lowerText.includes("दोस्त की बातचीत") || 
    lowerText.includes("बात्चाल") ||
    lowerText === "हूँ दोस्त।" || 
    lowerText === "हूं दोस्त।" || 
    lowerText === "दोस्त।"
  ) {
    console.log("⚠️ Whisper Prompt Leak Filtered");
    return "";
  }
  
  if (/प्रस्तु/i.test(lowerText) || lowerText.includes("परवारण") || lowerText.includes("परवार्ड")) {
    console.log("⚠️ Whisper Silence Bug Filtered");
    return "";
  }

  const charRepeatRegex = /([\u0900-\u097F\w])\1{3,}/;
  if (charRepeatRegex.test(text)) {
    console.log("⚠️ Whisper Character Loop Filtered");
    return "";
  }

  const wordRepeatRegex = /([\u0900-\u097F\w]+)\s+\1\s+\1/;
  if (wordRepeatRegex.test(text)) {
    const parts = text.split(/[,।?]\s*/);
    if (parts.length > 1 && parts[0].trim().length > 1) {
      return parts[0].trim(); 
    }
    return "";
  }
  return text;
}

// ✅ START SERVER
await connectMongoDB();

const server = app.listen(PORT, () => {
  console.log(`✅ Live Audio Server v6.5 (ElevenLabs TTS + Groq) on ${PORT}`);
  
  setInterval(() => {
    console.log(JSON.stringify({
      marker: "railway-log-probe",
      ts: new Date().toISOString(),
      status: "alive",
      uptime: process.uptime(),
      connections: wss ? wss.clients.size : 0,
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    }));
  }, 15000);
});

const wss = new WebSocketServer({ server });

const availableProviders = Object.values(providers).filter(p => p.key);
console.log(`✅ Available providers: ${availableProviders.map(p => p.name).join(', ')}`);

if (availableProviders.length === 0) {
  console.error('❌ No API keys configured!');
  process.exit(1);
}

app.get('/', (req, res) => res.send('Sahchar Live - v6.5 (ElevenLabs TTS + Groq)'));
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  version: '6.5',
  providers: availableProviders.map(p => p.name),
  connections: wss.clients.size,
  timestamp: new Date().toISOString()
}));

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
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function amplifyAudio(pcmData, factor = 1.3) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

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
  let rawDeviceId = url.searchParams.get('deviceId');
  let deviceId = (rawDeviceId && rawDeviceId !== 'default' && rawDeviceId !== 'null' && rawDeviceId !== 'undefined') ? rawDeviceId.trim() : "default_user";

  const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client active: ${connectionId}`);

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let isClosing = false;
  let keepAliveInterval = null;
  let processTimer = null;

  keepAliveInterval = setInterval(() => {
    if (ws.readyState === 1 && !isClosing) { try { ws.ping(); } catch (e) {} }
  }, 10000);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1 && !isClosing) { try { ws.send(data); return true; } catch (e) { return false; } }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    if (fullAudio.length < 8000) { isProcessing = false; return; }

    const rms = calculateRMS(fullAudio);
    const MIN_SPEECH_RMS = 0.030; 
    if (rms < MIN_SPEECH_RMS) {
      isProcessing = false;
      return;
    }

    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));

    try {
      const wavBuffer = pcmToWav(fullAudio);
      const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      const fileObject = await OpenAI.toFile(audioBlob, 'speech.wav');

      const userMsg = await smartTranscription(fileObject);
      if (!userMsg || userMsg.length < 2) {
        console.log('⚠️ Empty transcription, skipping');
        isProcessing = false;
        return;
      }

      console.log(`📝 [${connectionId}] User: ${userMsg} | RMS: ${rms.toFixed(4)}`);
      
      const lowerUserMsg = userMsg.toLowerCase().replace("।", "").trim();
      const userExitKeywords = ["चैट क्लोज", "अलविदा", "बाय बाय", "बाय", "टाटा", "बंद करो"];
      const hasUserRequestedExit = userExitKeywords.some(k => lowerUserMsg.includes(k));

      let botReply = "";
      if (hasUserRequestedExit) {
        botReply = "अच्छा, बाय! जब भी बात करनी हो, मैं यहीं हूँ। शुभ रात्रि! 🙏😊";
      } else {
        await safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
        await saveConversation(deviceId, 'user', userMsg);

        let liveSearchContext = "";
        const searchTriggers = ["ट्रेन्डिंग", "ट्रेंड", "न्यूज़", "समाचार", "कौन है", "क्या है", "पार्टी", "मैच", "चुनाव"];
        const needsSearch = searchTriggers.some(trigger => lowerUserMsg.includes(trigger));

        if (needsSearch) {
          const webSearchSnippets = await getLiveGoogleSearch(userMsg);
          if (webSearchSnippets) {
            liveSearchContext = `\n\n[IMPORTANT REAL-TIME GOOGLE SEARCH CONTENT]:\n${webSearchSnippets}\nUse this verified 2026 data. Inform them naturally without bookish Hindi.`;
          }
        }

        const previousHistory = await getConversationHistory(deviceId, 5);
        const CURRENT_DATE_STRING = new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: 'numeric', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });

        const messages = [
          {
            role: 'system',
            content: `तुम "SuperSahchar" हो, यूजर के सबसे पक्के दोस्त। वर्तमान समय: ${CURRENT_DATE_STRING}
⚡ **CRITICAL RULES:**
1. **किताबी हिंदी प्रतिबंधित है:** "प्रस्तुती", "विशेष विषय", "साझा करना" जैसे शब्दों का प्रयोग सख्त पाप है!
2. **सच्चे दोस्त का लहजा:** "यार", "दोस्त", "भाई", "बहन" जैसे शब्दों का सहजता से उपयोग करो।
3. **लिखने की शुद्धता:** हमेशा शुद्ध वर्तनी में लिखो, कोई अजीब वाक्य अधूरा मत छोड़ो।
4. जवाब छोटा (1-2 वाक्य) और अंत में इमोजी 😊🙏 होना चाहिए।${liveSearchContext}`
          },
          ...previousHistory,
          { role: 'user', content: userMsg }
        ];

        const chatResult = await smartChat(messages, true);
        botReply = chatResult ? chatResult.reply : "सभी सेवाएं व्यस्त हैं। 🙏";
        console.log(`🤖 Provider: ${chatResult?.provider || 'none'}`);
      }

console.log(`🤖 [${connectionId}] Bot: ${botReply}`);
safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
if (!hasUserRequestedExit) await saveConversation(deviceId, 'assistant', botReply);

if (isClosing || ws.readyState !== 1) return;

isBotSpeaking = true;
audioBuffer = []; 
safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

const audioPcm = await smartTTS(botReply);
if (!audioPcm) {
    console.warn('⚠️ TTS failed, sending text-only response');
    safeSend(JSON.stringify({ type: 'audio_done' }));
    isBotSpeaking = false;
    isProcessing = false;
    return;
}

// ✅ FIX: Direct use - NO resample, NO amplify (smartTTS already returns clean PCM)
let processedAudio = audioPcm;

const chunkSize = 640;
for (let i = 0; i < processedAudio.length; i += chunkSize) {
    if (isClosing || ws.readyState !== 1 || !isBotSpeaking) break;
    const chunk = processedAudio.subarray(i, Math.min(i + chunkSize, processedAudio.length));
    safeSend(chunk, true);
    await new Promise(r => setTimeout(r, 20)); 
}

if (isBotSpeaking) safeSend(JSON.stringify({ type: 'audio_done' }));
if (hasUserRequestedExit) {
    await new Promise(r => setTimeout(r, 500));
    safeSend(JSON.stringify({ type: 'force_close_ui' })); 
}
isBotSpeaking = false;
if (!hasUserRequestedExit) safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));

    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      console.error(`❌ Stack: ${err.stack}`);
      safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
    } finally {
      isProcessing = false;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'interrupt') { isBotSpeaking = false; audioBuffer = []; if (processTimer) clearTimeout(processTimer); }
      } catch (e) {}
      return;
    }
    audioBuffer.push(Buffer.from(data));
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => { if (audioBuffer.length > 0 && !isProcessing && !isClosing) processAudio(); }, 550);
  });

  ws.on('close', () => { isClosing = true; isBotSpeaking = false; if (processTimer) clearTimeout(processTimer); if (keepAliveInterval) clearInterval(keepAliveInterval); });
  ws.on('error', () => { isClosing = true; });
  safeSend(JSON.stringify({ type: 'status', text: 'SuperSahchar सुन रहा है... 🎤' }));
});

process.on('SIGTERM', async () => { if (mongoClient) await mongoClient.close(); process.exit(0); });
