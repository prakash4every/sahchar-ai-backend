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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ========== MONGODB SETUP ==========
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

// ========== FAST API PROVIDERS (Speed Priority) ==========
// Speed order: Groq (~1-2s) > DeepSeek (~2-3s) > OpenAI (~3-4s) > Kimi (~4-5s) > Gemini (~5-6s)

const fastProviders = [
  { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'mixtral-8x7b-32768', speed: '⚡ 1-2s' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', key: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat', speed: '⚡ 2-3s' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini', speed: '⚡ 3-4s' },
  { name: 'Kimi', url: 'https://api.moonshot.cn/v1/chat/completions', key: process.env.KIMI_API_KEY, model: 'moonshot-v1-8k', speed: '⏱️ 4-5s' },
  { name: 'Gemini', key: process.env.GEMINI_API_KEY, isGemini: true, speed: '⏱️ 5-6s' }
];

async function callFastAPI(messages, provider) {
  if (!provider.key) return null;
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
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` },
      body: JSON.stringify({ model: provider.model, messages: messages, max_tokens: 200, temperature: 0.7 })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.log(`⚠️ ${provider.name} failed: ${error.message}`);
    return null;
  }
}

async function fastChat(messages, providerNames) {
  for (const providerName of providerNames) {
    const provider = fastProviders.find(p => p.name === providerName);
    if (provider) {
      console.log(`🔄 Trying ${provider.name} (${provider.speed})...`);
      const reply = await callFastAPI(messages, provider);
      if (reply) return { reply, provider: provider.name };
    }
  }
  return null;
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v8.0 FAST ✅"));

// ==================== 1. SAHCHARAI (Fastest: Groq → DeepSeek → OpenAI) ====================
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
    
    // ✅ FAST: Groq → DeepSeek → OpenAI (NVIDIA removed)
    const result = await fastChat(conversations[sid], ['Groq', 'DeepSeek', 'OpenAI']);
    
    if (!result) throw new Error("All providers failed");
    
    conversations[sid].push({ role: "assistant", content: result.reply });
    if (conversations[sid].length > 20) conversations[sid] = [conversations[sid][0], ...conversations[sid].slice(-18)];
    await saveConversationToDB(sid, message, result.reply, `SahcharAI (${result.provider})`);
    res.json({ reply: result.reply, provider: result.provider });

  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। कृपया पुनः प्रयास करें। 🙏" });
  }
});

// ==================== 2. SAHCHARASSISTANT (Fast: Groq → DeepSeek → OpenAI) ====================
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
    
    const result = await fastChat(messages, ['Groq', 'DeepSeek', 'OpenAI']);
    if (!result) throw new Error("All providers failed");
    
    await saveConversationToDB(sid, message, result.reply, `SahcharAssistant (${result.provider})`);
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR (Fast: Groq → DeepSeek → OpenAI, NVIDIA LAST) ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const messages = [
    { role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। हिंदी/हिंग्लिश। इमोजी 😊🙏।` },
    { role: "user", content: message }
  ];
  
  // ✅ Fast providers first (Groq, DeepSeek, OpenAI)
  const result = await fastChat(messages, ['Groq', 'DeepSeek', 'OpenAI']);
  
  if (result) {
    await saveConversationToDB(sid, message, result.reply, `SuperSahchar (${result.provider})`);
    return res.json({ reply: result.reply, provider: result.provider });
  }
  
  // ⚠️ NVIDIA as LAST RESORT (slow, but better than nothing)
  if (process.env.NGC_API_KEY) {
    try {
      console.log(`🐢 Trying NVIDIA (slow fallback)...`);
      const nvidiaClient = new OpenAI({ apiKey: process.env.NGC_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const completion = await nvidiaClient.chat.completions.create({
        model: "meta/llama-3.1-70b-instruct",
        messages: messages,
        max_tokens: 150
      });
      const reply = completion.choices[0]?.message?.content;
      if (reply && !reply.includes(message)) {
        await saveConversationToDB(sid, message, reply, 'SuperSahchar (NVIDIA)');
        return res.json({ reply: reply, provider: "nvidia-slow" });
      }
    } catch (error) { console.log(`⚠️ NVIDIA failed: ${error.message}`); }
  }
  
  // Ultimate fallback
  res.json({ reply: "नमस्ते! मैं SuperSahchar हूँ। आपकी कैसे मदद कर सकता हूँ? 😊🙏" });
});

// ==================== 4. SMART IMAGE GENERATION ====================
async function translateToEnglish(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=hi&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    const data = await response.json();
    return data[0][0][0] || text;
  } catch (e) { return text; }
}

app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image: ${prompt}`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  const englishPrompt = await translateToEnglish(cleanPrompt);
  
  // Try OpenAI DALL-E
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.images.generate({ model: "dall-e-3", prompt: englishPrompt, n: 1, size: "1024x1024" });
      if (response.data?.[0]?.url) return res.json({ imageUrl: response.data[0].url, provider: "dall-e-3" });
    } catch (e) { console.log(`⚠️ DALL-E failed: ${e.message}`); }
  }
  
  // Try Replicate SDXL
  if (process.env.REPLICATE_API_KEY_ZEROSCOPE) {
    try {
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST", headers: { "Authorization": `Token ${process.env.REPLICATE_API_KEY_ZEROSCOPE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b", input: { prompt: englishPrompt, width: 1024, height: 1024 } })
      });
      if (response.ok) {
        const data = await response.json();
        let imageUrl = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1500));
          const status = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, { headers: { "Authorization": `Token ${process.env.REPLICATE_API_KEY_ZEROSCOPE}` } });
          const statusData = await status.json();
          if (statusData.status === "succeeded") { imageUrl = statusData.output[0]; break; }
          if (statusData.status === "failed") break;
        }
        if (imageUrl) return res.json({ imageUrl: imageUrl, provider: "replicate" });
      }
    } catch (e) { console.log(`⚠️ Replicate failed: ${e.message}`); }
  }
  
  // Final fallback: Pollinations
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
  res.json({ imageUrl: pollinationsUrl, provider: "pollinations" });
});

// ==================== 5. IMAGE ANALYSIS ====================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "कोई इमेज नहीं" });
  const { message } = req.body;
  const sid = getSessionId(req);
  
  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    fs.unlinkSync(req.file.path);
    
    if (!imageContexts[sid]) imageContexts[sid] = {};
    
    if (process.env.OPENAI_API_KEY) {
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are SahcharAI, analyze images. Reply in Hindi." },
            { role: "user", content: [{ type: "text", text: message || "Describe this image" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }
          ]
        });
        const analysis = response.choices[0].message.content;
        imageContexts[sid].lastAnalysis = analysis;
        return res.json({ analysis: analysis, provider: "gpt-4o-mini" });
      } catch (e) { console.log(`⚠️ GPT analysis failed: ${e.message}`); }
    }
    
    if (process.env.GEMINI_API_KEY) {
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: message || "Describe this image" }, { inline_data: { mime_type: "image/jpeg", data: base64Image } }] }] })
      });
      const geminiData = await geminiRes.json();
      const analysis = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "✅ विश्लेषण पूरा हुआ!";
      imageContexts[sid].lastAnalysis = analysis;
      return res.json({ analysis: analysis, provider: "gemini" });
    }
    
    res.json({ analysis: "✅ विश्लेषण पूरा हुआ!" });
  } catch (error) {
    console.error("❌ Analysis error:", error.message);
    res.status(500).json({ error: "विश्लेषण में त्रुटि" });
  }
});

// ==================== 6. VIDEO GENERATION ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎬 Video: ${prompt?.substring(0,50)}...`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  
  let cleanPrompt = prompt.replace(/^(वीडियो|video)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  if (process.env.REPLICATE_API_KEY_ZEROSCOPE) {
    try {
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST", headers: { "Authorization": `Token ${process.env.REPLICATE_API_KEY_ZEROSCOPE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: "f66b331a0cc10ea6179942ae66b538cdc34ff43b5a4e700dddffdb7f1a46cf6a", input: { prompt: cleanPrompt, width: 1024, height: 576 } })
      });
      if (response.ok) {
        const data = await response.json();
        let videoUrl = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const status = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, { headers: { "Authorization": `Token ${process.env.REPLICATE_API_KEY_ZEROSCOPE}` } });
          const statusData = await status.json();
          if (statusData.status === "succeeded") { videoUrl = statusData.output; break; }
        }
        if (videoUrl) return res.json({ videoUrl: videoUrl, provider: "replicate" });
      }
    } catch (e) { console.log(`⚠️ Video generation failed: ${e.message}`); }
  }
  
  res.json({ videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", status: "demo", provider: "demo" });
});

// ==================== WEBSOCKET LIVE AUDIO ====================
function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
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
  console.log(`🔌 WebSocket: ${deviceId}`);

  let openai;
  if (process.env.OPENAI_API_KEY) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  ws.on('message', async (data) => {
    try {
      if (openai && data instanceof Buffer) {
        const transcription = await openai.audio.transcriptions.create({
          file: new File([data], "audio.wav", { type: "audio/wav" }),
          model: "whisper-1", language: "hi"
        });
        const userText = transcription.text;
        ws.send(JSON.stringify({ type: 'user_transcript', text: userText }));
        
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: "You are SahcharAI. Reply in Hindi, 1-2 sentences." }, { role: "user", content: userText }],
          max_tokens: 150
        });
        const botReply = completion.choices[0].message.content;
        ws.send(JSON.stringify({ type: 'bot_transcript', text: botReply }));
      }
    } catch (err) { ws.send(JSON.stringify({ type: 'error', message: err.message })); }
  });
  ws.on('close', () => console.log(`🔌 WebSocket disconnected: ${deviceId}`));
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Fast Server v8.0 on ${PORT}`));
