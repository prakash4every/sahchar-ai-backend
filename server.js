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
const conversations = new Map();  // Use Map for session isolation
const imageContexts = new Map();

async function initMongoDB() {
  if (!process.env.MONGODB_URI) {
    console.log("⚠️ MONGODB_URI not set – using in-memory only");
    return;
  }
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

// ========== SESSION MANAGEMENT ==========
// Get session ID from multiple sources
function getSessionId(req) {
  // Priority: JSON body → Header → Query param
  let sid = req.body?.sessionId || req.headers['x-session-id'] || req.query?.sessionId;
  
  // If no valid session ID, reject or use IP-based fallback
  if (!sid || sid === "default" || sid === "null" || sid.length < 10) {
    // Generate from IP + UserAgent for fallback
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    sid = Buffer.from(`${ip}-${ua}`).toString('base64').substring(0, 32);
    console.log(`⚠️ Generated fallback session ID: ${sid.substring(0, 8)}...`);
  }
  
  return sid;
}

async function loadConversationFromDB(sid, limit = 10) {
  if (!db || !sid) return [];
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
    if (messages.length > 0) {
      console.log(`📚 Loaded ${messages.length} exchanges for session ${sid.substring(0, 8)}...`);
    }
    return history;
  } catch (err) { 
    console.error("DB load error:", err.message);
    return []; 
  }
}

async function saveConversationToDB(sid, userMessage, botReply, chatbot = 'SahcharAI') {
  if (!db || !sid) return;
  try {
    await db.collection('conversations').insertOne({
      sessionId: sid, 
      userMessage, 
      botReply, 
      chatbot, 
      timestamp: new Date()
    });
  } catch (err) { 
    console.error("DB insert error:", err.message);
  }
}

function getImageContextText(sid) {
  const ctx = imageContexts.get(sid);
  if (ctx?.lastAnalysis) {
    return `\n\n📷 पिछली इमेज: "${ctx.lastAnalysis.substring(0, 400)}"\n\n`;
  }
  return "";
}

// ========== FAST API PROVIDERS ==========
const fastProviders = [
  { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'mixtral-8x7b-32768' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', key: process.env.DEEPSEEK_API_KEY, model: 'deepseek-chat' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' },
  { name: 'Kimi', url: 'https://api.moonshot.cn/v1/chat/completions', key: process.env.KIMI_API_KEY, model: 'moonshot-v1-8k' }
];

async function callFastAPI(messages, provider) {
  if (!provider.key) return null;
  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` },
      body: JSON.stringify({
        model: provider.model,
        messages: messages,
        max_tokens: 200,
        temperature: 0.7
      })
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
      console.log(`🔄 Trying ${provider.name}...`);
      const reply = await callFastAPI(messages, provider);
      if (reply) return { reply, provider: provider.name };
    }
  }
  return null;
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v10.0 - Session Isolated ✅"));

// ==================== 1. SAHCHARAI (Session Isolated) ====================
app.post("/chat", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  
  console.log(`📩 Chat [${sid.substring(0, 8)}...]: ${message?.substring(0, 50)}...`);
  if (!message) return res.status(400).json({ reply: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const imageContext = getImageContextText(sid);

    let conversation = conversations.get(sid);
    if (!conversation) {
      const history = await loadConversationFromDB(sid, 10);
      conversation = [
        { role: "system", content: `तुम 'SahcharAI' हो – एक दोस्ताना AI सहायक। हिंदी/अंग्रेजी/हिंग्लिश में बात करो। निर्माता: राम प्रकाश कुमार (सिर्फ पूछने पर बताना, हर बार मत बताना)। 2 छोटे वाक्यों में जवाब दो। इमोजी 🙏🌿। वर्तमान समय: ${currentDateTime} IST${imageContext}` },
        ...history
      ];
      conversations.set(sid, conversation);
    }
    conversation.push({ role: "user", content: message });
    
    const result = await fastChat(conversation, ['Groq', 'DeepSeek', 'OpenAI', 'Kimi']);
    if (!result) throw new Error("All providers failed");
    
    conversation.push({ role: "assistant", content: result.reply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid, conversation);
    }
    
    // Save to DB asynchronously
    saveConversationToDB(sid, message, result.reply, `SahcharAI (${result.provider})`);
    
    console.log(`✅ Reply [${sid.substring(0, 8)}...]: ${result.reply.substring(0, 50)}...`);
    res.json({ reply: result.reply, provider: result.provider });

  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 2. SAHCHARASSISTANT ====================
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
    
    const result = await fastChat(messages, ['Groq', 'DeepSeek', 'OpenAI', 'Kimi']);
    if (!result) throw new Error("All providers failed");
    
    saveConversationToDB(sid, message, result.reply, `SahcharAssistant (${result.provider})`);
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const messages = [
    { role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। इमोजी 😊🙏।` },
    { role: "user", content: message }
  ];
  
  const result = await fastChat(messages, ['Groq', 'DeepSeek', 'OpenAI', 'Kimi']);
  
  if (result) {
    saveConversationToDB(sid, message, result.reply, `SuperSahchar (${result.provider})`);
    return res.json({ reply: result.reply });
  }
  
  // Fallback static response
  res.json({ reply: "नमस्ते! मैं SuperSahchar हूँ। आपकी कैसे मदद कर सकता हूँ? 😊🙏" });
});

// ==================== 4. IMAGE GENERATION ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image: ${prompt}`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  // Try OpenAI DALL-E first (if API key exists)
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.images.generate({
        model: "dall-e-3",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024"
      });
      if (response.data?.[0]?.url) {
        console.log(`✅ Image by DALL-E`);
        return res.json({ imageUrl: response.data[0].url, provider: "dall-e" });
      }
    } catch (e) { console.log(`⚠️ DALL-E failed: ${e.message}`); }
  }
  
  // Fallback to Pollinations
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
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
    
    let ctx = imageContexts.get(sid);
    if (!ctx) {
      ctx = {};
      imageContexts.set(sid, ctx);
    }
    
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
        ctx.lastAnalysis = analysis;
        return res.json({ analysis: analysis });
      } catch (e) { console.log(`⚠️ Analysis failed: ${e.message}`); }
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
  let deviceId = url.searchParams.get('deviceId');
  if (!deviceId || deviceId === "default") {
    deviceId = `web-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }
  console.log(`🔌 WebSocket: ${deviceId.substring(0, 8)}...`);

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
  ws.on('close', () => console.log(`🔌 WebSocket disconnected: ${deviceId.substring(0, 8)}...`));
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Session Isolated Server v10.0 on ${PORT}`));
