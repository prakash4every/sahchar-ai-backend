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

// ========== MONGODB SETUP ==========
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

let db = null;
const assistantThreads = new Map(); // RAM cache
const conversations = {}; // RAM cache for speed
const imageContexts = {};

async function initMongoDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db();
    console.log("✅ Connected to MongoDB");

    // Load threads on start
    const threads = await db.collection('assistant_threads').find({}).toArray();
    threads.forEach(t => assistantThreads.set(t.sessionId, t.threadId));
    console.log(`📚 Loaded ${threads.length} assistant threads from DB`);

    // Index for speed
    await db.collection('conversations').createIndex({ sessionId: 1, timestamp: -1 });
    await db.collection('assistant_threads').createIndex({ sessionId: 1 }, { unique: true });
  } catch (error) {
    console.error("❌ MongoDB error:", error.message);
    process.exit(1);
  }
}
initMongoDB();

async function saveThreadToDB(sessionId, threadId) {
  if (!db) return;
  try {
    await db.collection('assistant_threads').updateOne(
      { sessionId },
      { $set: { sessionId, threadId, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error("Thread save error:", err.message);
  }
}

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
    if (messages.length > 0) console.log(`📚 Loaded ${messages.length} exchanges from DB for ${sid}`);
    return history;
  } catch (err) {
    console.error("DB load error:", err.message);
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
  } catch (err) {
    console.error("DB insert error:", err.message);
  }
}

function getSessionId(req) {
  return req.body.sessionId || req.query.sessionId || req.headers['x-session-id'] || "default";
}

function getImageContextText(sid) {
  if (imageContexts[sid]?.lastAnalysis) {
    return `\n\n📷 **पिछली इमेज:** "${imageContexts[sid].lastAnalysis.substring(0, 400)}"\n\n`;
  }
  return "";
}

// ========== HTTP ROUTES ==========
app.get("/", (req, res) => res.send("🌿 सहचर AI बैकएंड v3.0 चालू है ✅"));

// ==================== DEEPSEEK CHAT ====================
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

    if (!conversations[sid]) {
      const history = await loadConversationFromDB(sid, 6);
      conversations[sid] = [
        {
          role: "system",
          content: `तुम 'SahcharAI' हो – राम प्रकाश कुमार द्वारा निर्मित AI सहायक। वर्तमान समय: ${currentDateTime} IST। छोटे वाक्य, इमोजी 🙏🌿🪷। अंत में 'जय भीम, नमो बुद्धाय 🙏'।${imageContext}`
        },
     ...history
      ];
    } else {
      conversations[sid][0].content = conversations[sid][0].content.replace(
        /वर्तमान समय:.*?(?=IST)/,
        `वर्तमान समय: ${currentDateTime}`
      ) + imageContext;
    }

    conversations[sid].push({ role: "user", content: message });

    const estimateTokens = (msgs) => msgs.reduce((acc, m) => acc + JSON.stringify(m).length / 4, 0);
    while (estimateTokens(conversations[sid]) > 8000 && conversations[sid].length > 2) {
      conversations[sid].splice(1, 1);
    }

    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: conversations[sid] })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "DeepSeek API error");
    const botReply = data.choices?.[0]?.message?.content;
    if (!botReply) throw new Error("Empty AI response");

    conversations[sid].push({ role: "assistant", content: botReply });
    if (conversations[sid].length > 30) {
      conversations[sid] = [conversations[sid][0],...conversations[sid].slice(-20)];
    }

    await saveConversationToDB(sid, message, botReply, 'DeepSeek');
    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
  }
});

// ==================== OPENAI ASSISTANT - PERSISTENT ====================
app.post("/chat-assistant", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const apiKey = process.env.OPENAI_VIDEO_API_KEY;
  const assistantId = process.env.OPENAI_ASSISTANT_ID;
  if (!apiKey ||!assistantId) return res.status(501).json({ reply: "Assistant not configured." });

  try {
    const openai = new OpenAI({ apiKey });
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });

    let threadId = assistantThreads.get(sid);
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      assistantThreads.set(sid, threadId);
      await saveThreadToDB(sid, threadId);
      console.log(`✅ New thread ${threadId} for ${sid}`);

      const history = await loadConversationFromDB(sid, 1);
      for (const msg of history) {
        await openai.beta.threads.messages.create(threadId, { role: msg.role, content: msg.content });
      }
    }

    await openai.beta.threads.messages.create(threadId, { role: "user", content: message });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      instructions: `वर्तमान समय: ${currentDateTime} IST। 1-2 वाक्य में जवाब दो। अंत में 'जय भीम, नमो बुद्धाय 🙏'`,
      max_completion_tokens: 150
    });

    let runStatus = run;
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
        throw new Error(`Assistant ${runStatus.status}: ${runStatus.last_error?.message || ''}`);
      }
      attempts++;
    }

    if (runStatus.status!== "completed") throw new Error(`Timeout after 30s`);

    const messages = await openai.beta.threads.messages.list(threadId, { limit: 1 });
    let reply = messages.data[0]?.content[0]?.text?.value || "कोई जवाब नहीं।";
    reply = reply.replace(/जय भीम, नमो बुद्धाय.*$/i, '').trim().substring(0, 500) + '\n\nजय भीम, नमो बुद्धाय 🙏';

    await saveConversationToDB(sid, message, reply, 'Assistant');
    res.json({ reply, threadId });

  } catch (error) {
    console.error("❌ Assistant API error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, सेवा उपलब्ध नहीं है। 🙏" });
  }
});

// ==================== WEBSOCKET LIVE AUDIO - WITH MEMORY ====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId') || 'default';
  const sessionId = deviceId; // FIX: LiveAudio ka sessionId = deviceId
  console.log(`🔌 WebSocket connected: ${sessionId}`);

  let openai; // OpenAI client for transcription + reply
  if (process.env.OPENAI_VIDEO_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_VIDEO_API_KEY });
  }

  ws.on('message', async (data) => {
    try {
      // Yaha tumhara audio processing code hoga
      // Example: Audio ko text me convert karo, fir LLM ko bhejo
      if (openai && data instanceof Buffer) {
        // 1. Speech to Text - Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: new File([data], "audio.wav", { type: "audio/wav" }),
          model: "whisper-1",
          language: "hi"
        });
        const userText = transcription.text;
        console.log(`👤 User: ${userText}`);
        ws.send(JSON.stringify({ type: 'user_transcript', text: userText }));

        // 2. Load history from DB
        const history = await loadConversationFromDB(sessionId, 6);
        const messages = [
          { role: "system", content: `You are SahcharAI. Reply in Hindi, 1-2 sentences.` },
        ...history,
          { role: "user", content: userText }
        ];

        // 3. Get LLM reply
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_completion_tokens: 150
        });
        const botReply = completion.choices[0].message.content;
        console.log(`🤖 Bot: ${botReply}`);

        // 4. FIX: Save to DB
        await saveConversationToDB(sessionId, userText, botReply, 'LiveAudio');

        // 5. Send to client
        ws.send(JSON.stringify({ type: 'bot_transcript', text: botReply }));
        // Yaha TTS karke audio bhi bhej sakte ho
      }
    } catch (err) {
      console.error("WS message error:", err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => console.log(`🔌 WebSocket disconnected: ${sessionId}`));
});

//... Baaki image, video endpoints same rakh sakte ho

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server v3.0 running on port ${PORT} with MongoDB + LiveAudio Memory`);
});