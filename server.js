import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from 'mongodb';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import http from 'http';
import translate from '@vitalets/google-translate-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

// ========== ENV VALIDATION ==========
if (!process.env.MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI not set – chat history will be in-memory only.");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY not set – image/audio/chat may fail.");
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ========== MONGODB SETUP (optional) ==========
let db = null;
const conversations = {};
const imageContexts = {};

async function initMongoDB() {
  if (!process.env.MONGODB_URI) return;
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log(`✅ MongoDB Connected`);
    await db.collection('conversations').createIndex({ sessionId: 1, timestamp: -1 });
  } catch (error) {
    console.error("❌ MongoDB Error:", error.message);
  }
}
initMongoDB();

async function loadConversationFromDB(sid, limit = 6) {
  if (!db) return [];
  try {
    const messages = await db.collection('conversations')
      .find({ sessionId: sid })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    const history = [];
    messages.reverse().forEach(msg => {
      history.push({ role: "user", content: msg.userMessage });
      history.push({ role: "assistant", content: msg.botReply });
    });
    return history;
  } catch (err) { return []; }
}

async function saveConversationToDB(sid, userMessage, botReply, chatbot = 'SahcharAI') {
  if (!db) return;
  try {
    await db.collection('conversations').insertOne({
      sessionId: sid, userMessage, botReply, chatbot, timestamp: new Date()
    });
  } catch (err) {}
}

function getSessionId(req) {
  return req.body.sessionId || req.query.sessionId || req.headers['x-session-id'] || "default";
}

function getImageContextText(sid) {
  if (imageContexts[sid]?.lastAnalysis) {
    return `\n\n📷 पिछली इमेज: "${imageContexts[sid].lastAnalysis.substring(0, 400)}"\n\n`;
  }
  return "";
}

// ========== SMART API PROVIDERS (text chat) ==========
const providers = {
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', key: process.env.DEEPSEEK_API_KEY },
  kimi: { name: 'Kimi', url: 'https://api.moonshot.cn/v1/chat/completions', key: process.env.KIMI_API_KEY },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY },
  gemini: { name: 'Gemini', key: process.env.GEMINI_API_KEY, isGemini: true },
  sambanova: { name: 'SambaNova', url: process.env.SAMBANOVA_BASE_URL || 'https://api.sambanova.ai/v1', key: process.env.SAMBANOVA_API_KEY }
};

async function callAI(messages, providerName, model = null) {
  const provider = providers[providerName];
  if (!provider || !provider.key) return null;
  try {
    if (provider.isGemini) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${provider.key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: messages[messages.length-1]?.content || '' }] }] })
      });
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` },
      body: JSON.stringify({
        model: model || (providerName === 'deepseek' ? 'deepseek-chat' : providerName === 'kimi' ? 'moonshot-v1-8k' : 'gpt-4o-mini'),
        messages: messages,
        max_tokens: 200,
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.log(`⚠️ ${provider.name} failed:`, error.message);
    return null;
  }
}

async function smartChat(messages, preferredProvider, fallbackProviders) {
  let reply = await callAI(messages, preferredProvider);
  if (reply) return reply;
  for (const provider of fallbackProviders) {
    console.log(`🔄 Falling back to ${provider}...`);
    reply = await callAI(messages, provider);
    if (reply) return reply;
  }
  return null;
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v6.0 - GPT-Image-1 + Audio ✅"));

// ==================== CHAT ENDPOINTS ====================
app.post("/chat", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ reply: "Message required 🙏" });
  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const imageContext = getImageContextText(sid);
    if (!conversations[sid]) {
      const history = await loadConversationFromDB(sid, 6);
      conversations[sid] = [
        { role: "system", content: `तुम 'SahcharAI' हो – एक दोस्ताना AI सहायक। हिंदी/अंग्रेजी/हिंग्लिश में बात करो। निर्माता: राम प्रकाश कुमार (सिर्फ पूछने पर बताना)। 2 छोटे वाक्यों में जवाब दो। इमोजी 🙏🌿। वर्तमान समय: ${currentDateTime} IST${imageContext}` },
        ...history
      ];
    }
    conversations[sid].push({ role: "user", content: message });
    const reply = await smartChat(conversations[sid], 'deepseek', ['kimi', 'groq', 'openai']);
    if (!reply) throw new Error("All providers failed");
    conversations[sid].push({ role: "assistant", content: reply });
    if (conversations[sid].length > 20) conversations[sid] = [conversations[sid][0], ...conversations[sid].slice(-18)];
    await saveConversationToDB(sid, message, reply, 'SahcharAI');
    res.json({ reply: reply });
  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। कृपया पुनः प्रयास करें। 🙏" });
  }
});

app.post("/chat-assistant", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });
  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const messages = [
      { role: "system", content: `तुम 'SahcharAssistant' हो – राम प्रकाश कुमार द्वारा निर्मित। 1-2 वाक्य में जवाब दो। इमोजी 🙏। वर्तमान समय: ${currentDateTime} IST` },
      { role: "user", content: message }
    ];
    const reply = await smartChat(messages, 'kimi', ['deepseek', 'groq', 'openai']);
    if (!reply) throw new Error("All providers failed");
    await saveConversationToDB(sid, message, reply, 'SahcharAssistant');
    res.json({ reply: reply });
  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const groqKey = process.env.GROQ_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const nvidiaKey = process.env.NGC_API_KEY;
  
  if (groqKey) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: "mixtral-8x7b-32768",
          messages: [{ role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। हिंदी/हिंग्लिश। इमोजी 😊🙏।` }, { role: "user", content: message }],
          max_tokens: 150, temperature: 0.8
        })
      });
      const data = await response.json();
      if (response.ok && data.choices && data.choices[0]) {
        let reply = data.choices[0].message.content;
        if (reply && !reply.includes(message)) {
          await saveConversationToDB(sid, message, reply, 'SuperSahchar');
          return res.json({ reply: reply, provider: "groq" });
        }
      }
    } catch (error) { console.log(`⚠️ Groq failed: ${error.message}`); }
  }
  if (deepseekKey) {
    try {
      const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "system", content: `तुम 'SuperSahchar' हो। user का message दोहराना मत। छोटे जवाब। इमोजी 😊🙏।` }, { role: "user", content: message }],
          max_tokens: 150, temperature: 0.8
        })
      });
      const data = await response.json();
      if (response.ok && data.choices && data.choices[0]) {
        let reply = data.choices[0].message.content;
        if (reply && !reply.includes(message)) {
          await saveConversationToDB(sid, message, reply, 'SuperSahchar');
          return res.json({ reply: reply, provider: "deepseek" });
        }
      }
    } catch (error) { console.log(`⚠️ DeepSeek failed: ${error.message}`); }
  }
  if (nvidiaKey) {
    try {
      const nvidiaClient = new OpenAI({ apiKey: nvidiaKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await nvidiaClient.chat.completions.create({
        model: "meta/llama-3.1-70b-instruct",
        messages: [{ role: "system", content: `तुम 'SuperSahchar' हो। user का message दोहराना मत। 1-2 वाक्य। इमोजी 😊🙏।` }, { role: "user", content: message }],
        max_tokens: 150, temperature: 0.8
      });
      const reply = completion.choices[0]?.message?.content;
      if (reply && !reply.includes(message)) {
        await saveConversationToDB(sid, message, reply, 'SuperSahchar');
        return res.json({ reply: reply, provider: "nvidia" });
      }
    } catch (error) { console.log(`⚠️ NVIDIA failed: ${error.message}`); }
  }
  const fallbackReply = "नमस्ते! मैं SuperSahchar हूँ। आपकी कैसे मदद कर सकता हूँ? 😊🙏";
  await saveConversationToDB(sid, message, fallbackReply, 'SuperSahchar');
  res.json({ reply: fallbackReply, provider: "static" });
});

// ==================== TRANSLATION FUNCTION (Free Google Translate API) ====================
async function translateToEnglish(text) {
  try {
    // Google Translate unofficial API (no key required)
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=hi&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data && data[0] && data[0][0] && data[0][0][0]) {
      return data[0][0][0];
    }
    throw new Error("No translation");
  } catch (e) {
    console.log("Translation failed, using original prompt");
    return text;
  }
}

// ==================== IMAGE GENERATION (fixed GPT-Image-1) ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image Request: ${prompt}`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  // Clean prompt – remove Hindi verbs like "तस्वीर बना"
  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;

  // Translate to English
  let englishPrompt = await translateToEnglish(cleanPrompt);
  console.log(`Translated prompt: "${englishPrompt}"`);

  const openaiKey = process.env.OPENAI_API_KEY;
  const replicateToken = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_KEY_ZEROSCOPE;

  // PRIORITY 1: OpenAI GPT-Image-1 (correct quality value)
  if (openaiKey) {
    try {
      console.log(`🎨 Trying OpenAI GPT-Image-1...`);
      const openai = new OpenAI({ apiKey: openaiKey });
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: englishPrompt,
        n: 1,
        size: "1024x1024",
        quality: "auto"        // ✅ Fixed: 'auto' instead of 'standard'
      });
      if (response.data && response.data[0] && response.data[0].url) {
        console.log(`✅ Image by GPT-Image-1`);
        return res.json({ imageUrl: response.data[0].url, provider: "gpt-image-1" });
      }
    } catch (e) {
      console.log(`⚠️ GPT-Image-1 failed: ${e.message}`);
      // Optionally try a fallback model (dall-e-3) – but may not exist
    }
  }

  // PRIORITY 2: Replicate SDXL (if token exists)
  if (replicateToken) {
    try {
      console.log(`🎨 Trying Replicate SDXL...`);
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Authorization": `Token ${replicateToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
          input: { prompt: englishPrompt, width: 1024, height: 1024, num_outputs: 1 }
        })
      });
      if (response.ok) {
        const data = await response.json();
        const predictionId = data.id;
        let imageUrl = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
            headers: { "Authorization": `Token ${replicateToken}` }
          });
          const statusData = await statusRes.json();
          if (statusData.status === "succeeded") {
            imageUrl = statusData.output[0];
            break;
          } else if (statusData.status === "failed") break;
        }
        if (imageUrl) {
          console.log(`✅ Image by Replicate SDXL`);
          return res.json({ imageUrl: imageUrl, provider: "replicate-sdxl" });
        }
      }
    } catch (e) { console.log(`⚠️ Replicate failed: ${e.message}`); }
  }

  // PRIORITY 3: Pollinations.ai (English prompt, longer timeout)
  console.log(`🎨 Using Pollinations.ai...`);
  const encodedEn = encodeURIComponent(englishPrompt);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedEn}?width=1024&height=1024&seed=${Date.now()}&model=flux&nologo=true`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 sec timeout
    const checkRes = await fetch(pollinationsUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    if (checkRes.ok) {
      console.log(`✅ Image by Pollinations.ai`);
      return res.json({ imageUrl: pollinationsUrl, provider: "pollinations", note: "AI generated image" });
    }
  } catch (e) { console.log(`⚠️ Pollinations failed: ${e.message}`); }

  // All providers failed
  console.error(`❌ All image providers failed for: ${englishPrompt}`);
  res.status(503).json({ error: "इमेज जनरेशन अभी संभव नहीं है। कृपया बाद में प्रयास करें। 🙏" });
});
// ==================== IMAGE ANALYZE ====================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "कोई इमेज नहीं" });
  const { message } = req.body;
  const sid = getSessionId(req);
  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    fs.unlinkSync(req.file.path);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "API key missing" });
    if (!imageContexts[sid]) imageContexts[sid] = {};
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are SahcharAI, analyze images. Reply in Hindi." },
        { role: "user", content: [{ type: "text", text: message || "Describe this image" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }
      ]
    });
    const analysis = response.choices[0].message.content;
    imageContexts[sid].lastAnalysis = analysis;
    res.json({ analysis });
  } catch (error) {
    console.error("❌ Analysis error:", error.message);
    res.status(500).json({ error: "विश्लेषण में त्रुटि" });
  }
});

// ==================== VIDEO GENERATION ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎬 Video Request: ${prompt?.substring(0,50)}...`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });

  let cleanPrompt = prompt.replace(/^(वीडियो|video)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;

  const replicateToken = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_KEY_ZEROSCOPE;

  if (replicateToken) {
    try {
      console.log(`🎬 Trying Replicate ZeroScope V2...`);
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Authorization": `Token ${replicateToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "f66b331a0cc10ea6179942ae66b538cdc34ff43b5a4e700dddffdb7f1a46cf6a",
          input: { prompt: cleanPrompt, width: 1024, height: 576, num_frames: 24, fps: 8 }
        })
      });
      if (response.ok) {
        const data = await response.json();
        const predictionId = data.id;
        let videoUrl = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 2500));
          const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
            headers: { "Authorization": `Token ${replicateToken}` }
          });
          const statusData = await statusRes.json();
          if (statusData.status === "succeeded") {
            videoUrl = statusData.output;
            break;
          } else if (statusData.status === "failed") break;
        }
        if (videoUrl) {
          console.log(`✅ Video by Replicate ZeroScope`);
          return res.json({ videoUrl: videoUrl, provider: "replicate-zeroscope", status: "generated" });
        }
      }
    } catch (e) { console.log(`⚠️ Replicate video failed: ${e.message}`); }
  }

  // Fallback: demo video
  console.log(`🎬 Using demo video fallback...`);
  res.json({
    videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
    provider: "demo-fallback",
    status: "demo",
    message: "Demo video - Full video generation coming soon 🙏"
  });
});

// ==================== WEBSOCKET LIVE AUDIO (WITH TTS PCM) ====================
function pcmToWav(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function resample24kTo16k(pcm24k) {
  const targetLen = Math.floor(pcm24k.length * 2 / 3);
  const out = Buffer.alloc(targetLen);
  for (let i = 0; i < targetLen / 2; i++) {
    const srcIdx = Math.floor(i * 1.5) * 2;
    if (srcIdx + 1 < pcm24k.length) {
      out.writeInt16LE(pcm24k.readInt16LE(srcIdx), i * 2);
    }
  }
  return out;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId') || 'default';
  console.log(`🔌 LiveAudio WebSocket connected: ${deviceId}`);

  let openaiClient = null;
  if (process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let silenceTimer = null;
  let lastBotEndTime = 0;

  const history = [{
    role: 'system',
    content: 'तुम सहचर हो। दोस्त की तरह छोटे, प्राकृतिक जवाब दो, हिंदी में। तुम्हें राम प्रकाश कुमार ने बनाया है। भूलकर भी OpenAI मत बोलना। जवाब 10-15 शब्दों में रखना।'
  }];

  const safeSend = (data) => {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch(e) {}
    }
  };

  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (!isBotSpeaking && audioBuffer.length > 0) {
      silenceTimer = setTimeout(() => {
        if (!isBotSpeaking && !isProcessing && audioBuffer.length > 0 && Date.now() > lastBotEndTime + 300) {
          processAudio();
        }
      }, 500);
    }
  };

  async function processAudio() {
    if (isProcessing || isBotSpeaking || audioBuffer.length === 0 || !openaiClient) return;
    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    let sum = 0;
    for (let i = 0; i < fullAudio.length; i += 2) {
      sum += fullAudio.readInt16LE(i) ** 2;
    }
    const rms = Math.sqrt(sum / (fullAudio.length / 2)) / 32768;
    if (rms < 0.008 || fullAudio.length < 2000) {
      console.log(`🔇 Ignored: RMS=${rms}, len=${fullAudio.length}`);
      isProcessing = false;
      return;
    }

    const wavBuffer = pcmToWav(fullAudio, 16000);
    const tempPath = path.join('/tmp', `${Date.now()}.wav`);
    fs.writeFileSync(tempPath, wavBuffer);

    try {
      const transcription = await openaiClient.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: 'hi'
      });
      const userText = transcription.text.trim();
      if (!userText) throw new Error("Empty transcription");
      console.log(`👤 User: ${userText}`);
      safeSend(JSON.stringify({ type: 'user_text', text: userText }));

      history.push({ role: 'user', content: userText });
      if (history.length > 11) history.splice(1, 2);

      const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 80,
        temperature: 0.85
      });
      const botReply = completion.choices[0].message.content;
      console.log(`🤖 Bot: ${botReply}`);
      history.push({ role: 'assistant', content: botReply });
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));

      isBotSpeaking = true;
      safeSend(JSON.stringify({ type: 'status', text: 'bot_speaking' }));

      const ttsResponse = await openaiClient.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: botReply,
        response_format: 'pcm',
        speed: 1.0
      });
      let pcm24k = Buffer.from(await ttsResponse.arrayBuffer());
      let pcm16k = resample24kTo16k(pcm24k);

      const chunkSize = 640;
      for (let i = 0; i < pcm16k.length; i += chunkSize) {
        if (ws.readyState !== 1) break;
        const chunk = pcm16k.subarray(i, Math.min(i + chunkSize, pcm16k.length));
        safeSend(chunk);
        await new Promise(r => setTimeout(r, 18));
      }

      isBotSpeaking = false;
      lastBotEndTime = Date.now();
      safeSend(JSON.stringify({ type: 'status', text: 'listening' }));
      console.log("✅ Bot finished speaking");
    } catch (err) {
      console.error("❌ Audio processing error:", err.message);
      safeSend(JSON.stringify({ type: 'error', text: err.message }));
      isBotSpeaking = false;
      safeSend(JSON.stringify({ type: 'status', text: 'listening' }));
    } finally {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      isProcessing = false;
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (isBotSpeaking) return;
    audioBuffer.push(Buffer.from(data));
    resetSilenceTimer();
  });

  ws.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    console.log(`🔌 WebSocket disconnected: ${deviceId}`);
  });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Smart Server v6.0 running on port ${PORT}`));
