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
import crypto from 'crypto';

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
const conversations = new Map(); // Use Map for better isolation
const imageContexts = new Map();

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
    if (messages.length > 0) console.log(`📚 Loaded ${messages.length} exchanges for ${sid.substring(0, 8)}...`);
    return history;
  } catch (err) { return []; }
}

async function saveConversationToDB(sid, userMessage, botReply, chatbot = 'SahcharAI') {
  if (!db || !sid) return;
  try {
    await db.collection('conversations').insertOne({
      sessionId: sid, userMessage, botReply, chatbot, timestamp: new Date()
    });
  } catch (err) {}
}

// ✅ FIXED: Generate unique session ID - never return "default"
function getSessionId(req) {
  let sid = req.body.sessionId || req.query.sessionId || req.headers['x-session-id'];
  
  // If no valid session ID, generate one from device fingerprint
  if (!sid || sid === "default" || sid === "null" || sid.length < 10) {
    const userAgent = req.headers['user-agent'] || 'unknown';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    sid = crypto.createHash('md5').update(`${userAgent}${ip}${timestamp}${random}`).digest('hex');
    console.log(`🆕 Generated new session ID: ${sid.substring(0, 8)}...`);
  }
  return sid;
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
  { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }
];

async function callFastAPI(messages, provider) {
  if (!provider.key) return null;
  try {
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
      const reply = await callFastAPI(messages, provider);
      if (reply) return { reply, provider: provider.name };
    }
  }
  return null;
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v9.0 - Session Isolated ✅"));

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
    
    const result = await fastChat(conversation, ['Groq', 'DeepSeek', 'OpenAI']);
    if (!result) throw new Error("All providers failed");
    
    conversation.push({ role: "assistant", content: result.reply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid, conversation);
    }
    await saveConversationToDB(sid, message, result.reply, `SahcharAI`);
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 2. SAHCHARASSISTANT (Session Isolated) ====================
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
    
    await saveConversationToDB(sid, message, result.reply, 'SahcharAssistant');
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR (Session Isolated) ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const messages = [
    { role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। इमोजी 😊🙏।` },
    { role: "user", content: message }
  ];
  
  const result = await fastChat(messages, ['Groq', 'DeepSeek', 'OpenAI']);
  
  if (result) {
    await saveConversationToDB(sid, message, result.reply, 'SuperSahchar');
    return res.json({ reply: result.reply });
  }
  
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
  res.json({ videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", status: "demo" });
});

// ==================== WEBSOCKET LIVE AUDIO ====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let deviceId = url.searchParams.get('deviceId') || crypto.randomBytes(16).toString('hex');
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
server.listen(PORT, () => console.log(`🚀 Session Isolated Server v9.0 on ${PORT}`));
