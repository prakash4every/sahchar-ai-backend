import RunwayML from '@runwayml/sdk';
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

// ========== JSON ERROR HANDLER ==========
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Invalid JSON received:', err.message);
    return res.status(400).json({
      reply: "क्षमा करें, मैसेज का फॉर्मेट सही नहीं है। 🙏"
    });
  }
  next(err);
});

// ========== MONGODB SETUP ==========
let db = null;
const assistantThreads = new Map();
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

    const threads = await db.collection('assistant_threads').find({}).toArray();
    threads.forEach(t => assistantThreads.set(t.sessionId, t.threadId));
    console.log(`📚 Loaded ${threads.length} assistant threads from DB`);

    await db.collection('conversations').createIndex({ sessionId: 1, timestamp: -1 });
    await db.collection('assistant_threads').createIndex({ sessionId: 1 }, { unique: true });
    console.log("✅ MongoDB Indexes Created");
  } catch (error) {
    console.error("❌ MongoDB Connection FAILED:", error.message);
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

// ========== GLOBAL ERROR HANDLERS ==========
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 सहचर AI बैकएंड v3.3 STABLE चालू है ✅"));
app.get("/chat", (req, res) => res.send("सहचर चैट एंडपॉइंट काम कर रहा है ✅"));

// ==================== 1. DEEPSEEK CHAT ====================
app.post("/chat", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;

  console.log(`📩 Chat Request [${sid}]: ${message?.substring(0, 50)}...`);

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

    console.log(`✅ Chat Reply [${sid}]: ${botReply.substring(0, 50)}...`);

    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
  }
});

// ==================== OPENAI RESPONSES API ====================
app.post("/chat-assistant", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(501).json({ reply: "OpenAI not configured." });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });

    const openai = new OpenAI({ apiKey });
    const history = await loadConversationFromDB(sid, 10);

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: `तुम्हारा नाम 'SahcharAI' है। तुम्हें राम प्रकाश कुमार ने बनाया है।

          नियम:
          1. अगर कोई पूछे "तुम्हें किसने बनाया" तो सिर्फ यही बोलना: "मुझे राम प्रकाश कुमार ने बनाया है 🙏"
          2. कभी मत बोलना कि OpenAI, Google, Meta ने बनाया।
          3. वर्तमान समय: ${currentDateTime} IST।
          4. 1-2 वाक्य में जवाब दो। अंत में 'जय भीम, नमो बुद्धाय 🙏'`
        },
  ...history,
        { role: "user", content: message }
      ],
      max_output_tokens: 150,
      temperature: 0.3
    });

    let reply = response.output_text || "कोई जवाब नहीं।";
    reply = reply.replace(/जय भीम, नमो बुद्धाय.*$/i, '').trim().substring(0, 500) + '\n\nजय भीम, नमो बुद्धाय 🙏';

    await saveConversationToDB(sid, message, reply, 'ResponsesAPI');
    console.log(`✅ ResponsesAPI reply for ${sid}: ${reply.substring(0, 50)}...`);
    res.json({ reply });

  } catch (error) {
    console.error("❌ Responses API error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SAMBANOVA CHAT ====================
app.post("/chat-sambanova", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const apiKey = process.env.SAMBANOVA_API_KEY;
  const baseURL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";
  if (!apiKey) return res.status(501).json({ reply: "SambaNova not configured." });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });
    const imageContext = getImageContextText(sid);
    const sambanova = new OpenAI({ apiKey, baseURL });

    if (!conversations[sid]) {
      const history = await loadConversationFromDB(sid, 6);
      conversations[sid] = [
        { role: "system", content: `तुम राम प्रकाश कुमार द्वारा निर्मित AI हो। वर्तमान समय: ${currentDateTime} IST। अंत में 'जय भीम, नमो बुद्धाय 🙏'${imageContext}` },
  ...history
      ];
    } else {
      conversations[sid][0].content = conversations[sid][0].content.replace(
        /वर्तमान समय:.*?(?=IST)/, `वर्तमान समय: ${currentDateTime}`
      ) + imageContext;
    }
    conversations[sid].push({ role: "user", content: message });

    const response = await sambanova.chat.completions.create({
      model: "Meta-Llama-3.3-70B-Instruct", messages: conversations[sid], temperature: 0.7
    });

    const botReply = response.choices[0]?.message?.content || "No response.";
    conversations[sid].push({ role: "assistant", content: botReply });
    if (conversations[sid].length > 20) conversations[sid] = [conversations[sid][0],...conversations[sid].slice(-10)];

    await saveConversationToDB(sid, message, botReply, 'SambaNova');
    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ SambaNova error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, SambaNova सेवा उपलब्ध नहीं है। 🙏" });
  }
});

// ==================== 4. NVIDIA NIM ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const apiKey = process.env.NGC_API_KEY;
  if (!apiKey) return res.status(501).json({ reply: "NVIDIA NIM not configured." });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
    });
    const imageContext = getImageContextText(sid);
    const nvidiaClient = new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' });

    if (!conversations[sid]) {
      const history = await loadConversationFromDB(sid, 6);
      conversations[sid] = [
        { role: "system", content: `तुम 'SuperSahchar' हो – राम प्रकाश कुमार द्वारा निर्मित इंसानी दोस्त। छोटे वाक्य, सवाल पूछो, इमोजी 😊🙏। वर्तमान समय: ${currentDateTime} IST।${imageContext}` },
  ...history
      ];
    } else {
      conversations[sid][0].content = conversations[sid][0].content.replace(
        /वर्तमान समय:.*?(?=IST)/, `वर्तमान समय: ${currentDateTime}`
      ) + imageContext;
    }

    conversations[sid].push({ role: "user", content: message });

    const stream = await nvidiaClient.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct", messages: conversations[sid],
      temperature: 1.0, top_p: 0.95, frequency_penalty: 0.3, presence_penalty: 0.3,
      max_completion_tokens: 300, stream: true,
    });

    let fullReply = "";
    for await (const chunk of stream) fullReply += chunk.choices[0]?.delta?.content || "";
    fullReply = fullReply.trim().substring(0, 800);

    conversations[sid].push({ role: "assistant", content: fullReply });
    if (conversations[sid].length > 20) conversations[sid] = [conversations[sid][0],...conversations[sid].slice(-10)];

    await saveConversationToDB(sid, message, fullReply, 'SuperSahchar');
    res.json({ reply: fullReply });
  } catch (error) {
    console.error("❌ NVIDIA NIM error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी थोड़ी देर में बात करते हैं? 😅" });
  }
});

// ==================== 5. IMAGE GENERATION ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;

  console.log(`🎨 Image Gen Request: ${prompt}`);

  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
  try {
    const response = await axios.post("https://api.openai.com/v1/images/generations", {
      model: "dall-e-3", prompt, n: 1, size: "1024x1024"
    }, { headers: { "Authorization": `Bearer ${apiKey}` } });

    console.log(`✅ Image Generated: ${response.data.data[0].url}`);

    res.json({ imageUrl: response.data.data[0].url });
  } catch (error) {
    console.error("OpenAI API error:", error.response?.data || error.message);
    res.status(500).json({ error: "इमेज जनरेशन फेल", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
  }
});

// ==================== 6. IMAGE ANALYZE ====================
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
    if (!apiKey) return res.status(500).json({ error: "OpenAI API key कॉन्फ़िगर नहीं है।" });

    if (!imageContexts[sid]) imageContexts[sid] = { lastImage: null, lastAnalysis: null, conversation: [] };
    imageContexts[sid].conversation.push({ role: "user", content: message });

    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are SahcharAI, analyze images with compassion." },
        { role: "user", content: [{ type: "text", text: message }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }
      ]
    });

    const analysis = response.choices[0].message.content;
    imageContexts[sid].lastAnalysis = analysis;
    imageContexts[sid].conversation.push({ role: "assistant", content: analysis });
    console.log(`📸 Image analyzed for ${sid}`);
    res.json({ analysis });
  } catch (error) {
    console.error("❌ Image Analysis Error:", error.message);
    res.status(500).json({ error: "इमेज का विश्लेषण करने में त्रुटि हुई। 🙏" });
  }
});

// ==================== UNIFIED VIDEO GENERATION - DEMO MODE ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎬 Video Request (DEMO MODE): ${prompt?.substring(0,50)}...`);

  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });

  // Testing Track के लिए Demo Video - 100% Stable
  return res.json({
    videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
    status: "demo",
    provider: "demo",
    message: "Video generation testing mode - coming soon 🙏"
  });
});
// ==================== VIDEO PROVIDER FUNCTIONS ====================

// 1. HUGGINGFACE - Improved
async function generateHuggingFaceVideo(prompt) {
  const response = await fetch(
    "https://api-inference.huggingface.co/models/ali-vilab/text-to-video-ms-1.7b",
    {
      headers: {
        "Authorization": `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      body: JSON.stringify({ inputs: prompt }),
    }
  );

  if (response.status === 503) {
    throw new Error("Model loading, wait 20s");
  }
  if (!response.ok) {
    const text = await response.text();
    console.error("HF Error:", text);
    throw new Error("HuggingFace failed");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Upload to 0x0.st (free, reliable)
  const formData = new FormData();
  formData.append('file', new Blob([buffer]), 'video.mp4');

  const uploadRes = await fetch("https://0x0.st", {
    method: "POST",
    body: formData
  });

  const videoUrl = await uploadRes.text();
  if (!videoUrl.startsWith('http')) throw new Error("Upload failed");

  return videoUrl.trim();
}

// 2. JSON2VIDEO - FIXED: Image to Video (No Text)
async function generateJSON2Video(prompt, duration) {
  console.log(`🎨 Step 1: Creating image for video...`);

  // Create image first
  const dalleResponse = await axios.post("https://api.openai.com/v1/images/generations", {
    model: "dall-e-3",
    prompt: prompt + ", cinematic, high quality, no text, no watermark",
    n: 1,
    size: "1024x1024"
  }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });

  const imageUrl = dalleResponse.data.data[0].url;
  console.log(`✅ Image created`);

  // Animate image
  const response = await fetch("https://api.json2video.com/v2/movies", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.JSON2VIDEO_API_KEY },
    body: JSON.stringify({
      resolution: "hd",
      scenes: [{
        duration: Math.min(Math.max(parseInt(duration), 5), 10),
        elements: [{
          type: "image",
          src: imageUrl,
          duration: parseInt(duration),
          zoom: 1.2,
          pan: "random"
        }]
      }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "JSON2Video API error");

  const movieId = data.project;
  let attempts = 0;
  while (attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const statusResponse = await fetch(`https://api.json2video.com/v2/movies?project=${movieId}`, {
      headers: { "x-api-key": process.env.JSON2VIDEO_API_KEY }
    });
    const statusData = await statusResponse.json();
    if (statusData.movie?.status === "done") {
      console.log(`✅ Video ready`);
      return statusData.movie.url;
    }
    if (statusData.movie?.status === "error") throw new Error("Video generation failed");
    attempts++;
  }
  throw new Error("Video timeout");
}

// ==================== AUDIO TRANSCRIBE ====================
app.post("/api/audio/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ऑडियो फाइल जरूरी है" });
  try {
    const dummyText = "यह एक नमूना ट्रांसक्रिप्शन है। असली API से कनेक्ट करें।";
    res.json({ transcription: dummyText, confidence: 0.95 });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: "ट्रांसक्रिप्शन फेल" });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, (err) => { if (err) console.error("File deletion error:", err); });
  }
});

// ==================== WEBSOCKET LIVE AUDIO ====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId') || 'default';
  const sessionId = deviceId;
  console.log(`🔌 WebSocket connected: ${sessionId}`);

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
        console.log(`👤 User [${sessionId}]: ${userText}`);
        ws.send(JSON.stringify({ type: 'user_transcript', text: userText }));

        const history = await loadConversationFromDB(sessionId, 6);
        const messages = [
          { role: "system", content: `You are SahcharAI. Reply in Hindi, 1-2 sentences.` },
     ...history,
          { role: "user", content: userText }
        ];

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_completion_tokens: 150
        });
        const botReply = completion.choices[0].message.content;
        console.log(`🤖 Bot [${sessionId}]: ${botReply}`);

        await saveConversationToDB(sessionId, userText, botReply, 'LiveAudio');
        ws.send(JSON.stringify({ type: 'bot_transcript', text: botReply }));
      }
    } catch (err) {
      console.error("WS message error:", err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => console.log(`🔌 WebSocket disconnected: ${sessionId}`));
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server v3.3 STABLE running on port ${PORT}`);
});
