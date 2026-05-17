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

// ========== ENV VALIDATION ==========
if (!process.env.MONGODB_URI) {
  console.error("❌ FATAL: MONGODB_URI environment variable is not set.");
  process.exit(1);
}

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
  try {
    console.log("🔄 Connecting to MongoDB...");
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db();
    console.log(`📊 Database Name: ${db.databaseName}`);
    await db.collection('conversations').createIndex({ sessionId: 1, timestamp: -1 });
    console.log("✅ MongoDB Ready");
  } catch (error) {
    console.error("❌ MongoDB Connection FAILED:", error.message);
    process.exit(1);
  }
}
initMongoDB();

async function loadConversationFromDB(sid, limit = 4) {
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
  } catch (err) {
    return [];
  }
}

async function saveConversationToDB(sid, userMessage, botReply, chatbot = 'SahcharAI') {
  if (!db) return;
  try {
    await db.collection('conversations').insertOne({
      sessionId: sid,
      userMessage,
      botReply,
      chatbot,
      timestamp: new Date()
    });
  } catch (err) {}
}

function getSessionId(req) {
  return req.body.sessionId || req.query.sessionId || req.headers['x-session-id'] || "default";
}

function getImageContextText(sid) {
  if (imageContexts[sid]?.lastAnalysis) {
    return `\n\n📷 पिछली इमेज: "${imageContexts[sid].lastAnalysis.substring(0, 200)}"\n\n`;
  }
  return "";
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 सहचर AI बैकएंड v4.0 FAST चालू है ✅"));

// ==================== OPTIMIZED CHAT ====================
app.post("/chat", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;

  if (!message) return res.status(400).json({ reply: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });

    const imageContext = getImageContextText(sid);

    // Get history (only last 3 exchanges for speed)
    let history = [];
    if (!conversations[sid]) {
      history = await loadConversationFromDB(sid, 4);
      conversations[sid] = [
        {
          role: "system",
          content: `तुम 'SahcharAI' हो – राम प्रकाश कुमार द्वारा निर्मित AI सहायक। जैसी भाषा user बोले वैसी में जवाब दो। बहुत छोटा जवाब दो (1-2 sentence)। इमोजी 🙏🌿🪷। वर्तमान समय: ${currentDateTime} IST${imageContext}`
        },
        ...history
      ];
    }

    conversations[sid].push({ role: "user", content: message });

    // Limit history to 10 messages (5 exchanges)
    if (conversations[sid].length > 12) {
      conversations[sid] = [conversations[sid][0], ...conversations[sid].slice(-10)];
    }

    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({ 
        model: "deepseek-chat", 
        messages: conversations[sid],
        max_tokens: 200,  // Limit response length
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "DeepSeek API error");
    
    const botReply = data.choices?.[0]?.message?.content;
    if (!botReply) throw new Error("Empty AI response");

    conversations[sid].push({ role: "assistant", content: botReply });
    
    // Save to DB asynchronously (don't wait)
    saveConversationToDB(sid, message, botReply, 'DeepSeek');

    res.json({ reply: botReply });

  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
  }
});

// ==================== SAHCHAR ASSISTANT ====================
app.post("/chat-assistant", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });

    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `तुम 'SahcharAssistant' हो – राम प्रकाश कुमार द्वारा निर्मित। 1-2 वाक्य में जवाब दो। इमोजी 🙏। वर्तमान समय: ${currentDateTime} IST`
          },
          { role: "user", content: message }
        ],
        max_tokens: 150,
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message);
    
    let reply = data.choices[0]?.message?.content || "कोई जवाब नहीं।";
    reply = reply.replace(/\*\*/g, '').trim();
    
    saveConversationToDB(sid, message, reply, 'SahcharAssistant');
    res.json({ reply: reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== SUPER SAHCHAR (NVIDIA) ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const apiKey = process.env.NGC_API_KEY;
  if (!apiKey) return res.status(501).json({ reply: "Service not configured." });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });

    const nvidiaClient = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });

    const completion = await nvidiaClient.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [
        { role: "system", content: `तुम 'SuperSahchar' हो। छोटे वाक्य, सवाल पूछो, इमोजी 😊🙏। वर्तमान समय: ${currentDateTime} IST` },
        { role: "user", content: message }
      ],
      max_tokens: 200,
      temperature: 0.7
    });

    const botReply = completion.choices[0]?.message?.content || "No response.";
    saveConversationToDB(sid, message, botReply, 'SuperSahchar');
    res.json({ reply: botReply });

  } catch (error) {
    console.error("❌ NVIDIA error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, थोड़ी देर में बात करते हैं? 😅" });
  }
});

// ==================== IMAGE GENERATION ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image Request: ${prompt}`);
  
  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });
  }
  
  const encodedPrompt = encodeURIComponent(prompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
  
  res.json({ imageUrl: imageUrl });
});

// ==================== IMAGE ANALYZE ====================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "कोई इमेज अपलोड नहीं की गई है। 🙏" });
  const { message } = req.body;
  const sid = getSessionId(req);
  if (!message) return res.status(400).json({ error: "कृपया इमेज के बारे में कुछ पूछें। 🙏" });

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    fs.unlinkSync(req.file.path);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "API key not configured" });

    if (!imageContexts[sid]) imageContexts[sid] = { lastAnalysis: null };

    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are SahcharAI, analyze images with compassion. Reply in Hindi." },
        { role: "user", content: [{ type: "text", text: message }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }
      ],
      max_tokens: 200
    });

    const analysis = response.choices[0].message.content;
    imageContexts[sid].lastAnalysis = analysis;
    res.json({ analysis });

  } catch (error) {
    console.error("❌ Image Analysis Error:", error.message);
    res.status(500).json({ error: "इमेज का विश्लेषण करने में त्रुटि हुई। 🙏" });
  }
});

// ==================== VIDEO GENERATION ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎬 Video Request: ${prompt?.substring(0,50)}...`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  
  return res.json({
    videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
    status: "demo",
    message: "Video generation coming soon 🙏"
  });
});

// ==================== WEBSOCKET LIVE AUDIO ====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId') || 'default';
  console.log(`🔌 WebSocket connected: ${deviceId}`);

  let openai;
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  ws.on('message', async (data) => {
    try {
      if (openai && data instanceof Buffer) {
        const transcription = await openai.audio.transcriptions.create({
          file: new File([data], "audio.wav", { type: "audio/wav" }),
          model: "whisper-1",
          language: "hi"
        });
        const userText = transcription.text;
        console.log(`👤 User: ${userText}`);
        ws.send(JSON.stringify({ type: 'user_transcript', text: userText }));

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are SahcharAI. Reply in Hindi, 1-2 sentences." },
            { role: "user", content: userText }
          ],
          max_tokens: 150
        });
        const botReply = completion.choices[0].message.content;
        console.log(`🤖 Bot: ${botReply}`);
        ws.send(JSON.stringify({ type: 'bot_transcript', text: botReply }));
      }
    } catch (err) {
      console.error("WS error:", err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => console.log(`🔌 WebSocket disconnected: ${deviceId}`));
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server v4.0 FAST running on port ${PORT}`);
});
