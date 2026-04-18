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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

// ========== ENV VALIDATION ==========
if (!process.env.MONGODB_URI) {
  console.error("❌ FATAL: MONGODB_URI missing. Server cannot start with memory.");
  process.exit(1);
}

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ========== SMART ERROR HANDLER ==========
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({
      reply: "क्षमा करें, मैसेज का फॉर्मेट सही नहीं है। 🙏"
    });
  }
  next(err);
});

// ========== MONGODB + THREAD CACHE ==========
let db = null;
const assistantThreads = new Map();

async function initMongoDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db();
    console.log("✅ Connected to MongoDB");

    const threads = await db.collection('assistant_threads').find({}).toArray();
    threads.forEach(t => assistantThreads.set(t.sessionId, t.threadId));
    console.log(`📚 Loaded ${threads.length} assistant threads from DB`);

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

// ========== GLOBAL ERROR HANDLERS ==========
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// ========== SMART CONVERSATION MEMORY ==========
const conversations = {};
const imageContexts = {};

function getImageContextText(sid) {
  if (imageContexts[sid]?.lastAnalysis) {
    return `\n\n📷 **पिछली इमेज:** "${imageContexts[sid].lastAnalysis.substring(0, 400)}"\n\n`;
  }
  return "";
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

function getSessionId(req) {
  return req.body.sessionId || req.query.sessionId || req.headers['x-session-id'] || "default";
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 सहचर AI बैकएंड v2.1 चालू है ✅"));

// ==================== 1. DEEPSEEK CHAT ====================
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

    if (db) await db.collection('conversations').insertOne({
      sessionId: sid, userMessage: message, botReply, chatbot: 'DeepSeek', timestamp: new Date()
    }).catch(e => console.error("DB insert error:", e.message));

    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 2. OPENAI ASSISTANT - PERSISTENT ====================
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
      if (history.length > 0) console.log(`📚 Loaded ${history.length} msgs to thread`);
    }

    await openai.beta.threads.messages.create(threadId, { role: "user", content: message });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      instructions: `वर्तमान समय: ${currentDateTime} IST। 1-2 वाक्य में जवाब दो। अंत में 'जय भीम, नमो बुद्धाय 🙏'`,
      max_completion_tokens: 150
    });

    let runStatus = run;
    let attempts = 0;
    const maxAttempts = 30;
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
        throw new Error(`Assistant ${runStatus.status}: ${runStatus.last_error?.message || ''}`);
      }
      attempts++;
    }

    if (runStatus.status!== "completed") throw new Error(`Timeout after ${maxAttempts}s`);

    const messages = await openai.beta.threads.messages.list(threadId, { limit: 1 });
    let reply = messages.data[0]?.content[0]?.text?.value || "कोई जवाब नहीं।";
    reply = reply.replace(/जय भीम, नमो बुद्धाय.*$/i, '').trim().substring(0, 500) + '\n\nजय भीम, नमो बुद्धाय 🙏';

    if (db) await db.collection('conversations').insertOne({
      sessionId: sid, userMessage: message, botReply: reply, chatbot: 'Assistant', timestamp: new Date()
    });

    console.log(`✅ Assistant reply for ${sid}: "${reply.substring(0, 50)}..."`);
    res.json({ reply, threadId });

  } catch (error) {
    console.error("❌ Assistant API error:", error.message);
    try {
      console.log("🔄 Falling back to NVIDIA...");
      const history = await loadConversationFromDB(sid, 3);
      const messages = [
        { role: "system", content: "You are Sahchar Assistant. Reply in Hindi, 1-2 sentences." },
      ...history,
        { role: "user", content: message }
      ];
      const nvidiaClient = new OpenAI({ apiKey: process.env.NGC_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1' });
      const resp = await nvidiaClient.chat.completions.create({
        model: "meta/llama-3.1-70b-instruct", messages, max_completion_tokens: 150
      });
      const fallbackReply = resp.choices[0]?.message?.content || "क्षमा करें।";
      if (db) await db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply: fallbackReply, chatbot: 'NVIDIA-Fallback', timestamp: new Date() });
      res.json({ reply: fallbackReply, threadId: null });
    } catch (fallbackErr) {
      res.status(500).json({ reply: "क्षमा करें, सेवा उपलब्ध नहीं है। 🙏" });
    }
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

    if (db) await db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply, chatbot: 'SambaNova', timestamp: new Date() });
    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ SambaNova error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, SambaNova सेवा उपलब्ध नहीं है। 🙏" });
  }
});

// ==================== 4. NVIDIA NIM - REAL PERSON ====================
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

    if (db) await db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply: fullReply, chatbot: 'SuperSahchar', timestamp: new Date() });
    res.json({ reply: fullReply });
  } catch (error) {
    console.error("❌ NVIDIA NIM error:", error.message);
    res.status(500).json({ reply: "क्षमा करें, अभी थोड़ी देर में बात करते हैं? 😅" });
  }
});

// ==================== IMAGE GENERATION ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
  try {
    const response = await axios.post("https://api.openai.com/v1/images/generations", {
      model: "dall-e-3", prompt, n: 1, size: "1024x1024"
    }, { headers: { "Authorization": `Bearer ${apiKey}` } });
    res.json({ imageUrl: response.data.data[0].url });
  } catch (error) {
    console.error("OpenAI API error:", error.response?.data || error.message);
    res.status(500).json({ error: "इमेज जनरेशन फेल", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
  }
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

// ==================== VIDEO GENERATION - RUNWAY ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt, imageUrl, duration = 5 } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) return res.status(500).json({ error: "API key error", videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" });

  try {
    let finalImageUrl = imageUrl;
    if (!finalImageUrl) {
      const dalleApiKey = process.env.OPENAI_API_KEY;
      if (!dalleApiKey) throw new Error("OpenAI API key missing");
      const dalleResponse = await axios.post("https://api.openai.com/v1/images/generations", {
        model: "dall-e-3", prompt: prompt + ", safe family-friendly", n: 1, size: "1024x1024"
      }, { headers: { "Authorization": `Bearer ${dalleApiKey}` } });
      finalImageUrl = dalleResponse.data.data[0].url;
    }

    const client = new RunwayML({ apiKey });
    const task = await client.imageToVideo.create({
      model: 'gen4_turbo', promptImage: finalImageUrl, promptText: prompt,
      ratio: '1280:720', duration: Math.min(Math.max(parseInt(duration), 2), 10)
    });

    let status = 'PENDING', attempts = 0, taskStatus = null;
    while (attempts < 90) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      taskStatus = await client.tasks.retrieve(task.id);
      status = taskStatus.status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED') throw new Error(`Task failed: ${taskStatus.error?.message || 'Unknown'}`);
      attempts++;
    }
    if (status!== 'SUCCEEDED') throw new Error('Timeout');

    let videoUrl = taskStatus.output?.output?.[0] || taskStatus.output?.[0] || taskStatus.output?.videoUrl || taskStatus.videoUrl;
    if (!videoUrl) throw new Error('No video URL found');
    res.json({ videoUrl, status: "success" });
  } catch (error) {
    console.error("❌ Video Generation Error:", error.message);
    res.status(500).json({ error: error.message, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
  }
});

// ==================== TEXT-TO-VIDEO FALLBACK ====================
app.post("/api/video/generate-text", async (req, res) => {
  const { prompt, duration = 5 } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  const demoVideoUrl = "https://www.w3schools.com/html/mov_bbb.mp4";

  const runwayKey = process.env.RUNWAYML_API_SECRET;
  if (runwayKey) {
    try {
      const client = new RunwayML({ apiKey: runwayKey });
      const task = await client.textToVideo.create({
        model: 'gen4.5', promptText: prompt, ratio: '1280:720',
        duration: Math.min(Math.max(parseInt(duration), 2), 10)
      });
      let status = 'PENDING', attempts = 0, taskStatus = null;
      while (attempts < 90) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        taskStatus = await client.tasks.retrieve(task.id);
        status = taskStatus.status;
        if (status === 'SUCCEEDED') break;
        if (status === 'FAILED') throw new Error(`Runway failed`);
        attempts++;
      }
      if (status!== 'SUCCEEDED') throw new Error('Runway timeout');
      let videoUrl = taskStatus.output?.output?.[0] || taskStatus.output?.[0] || taskStatus.output?.videoUrl;
      if (!videoUrl) throw new Error('No video URL from Runway');
      return res.json({ videoUrl, status: "success", provider: "runway" });
    } catch (e) {
      console.warn(`⚠️ RunwayML failed: ${e.message}`);
    }
  }
  return res.json({ videoUrl: demoVideoUrl, status: "demo", provider: "demo" });
});

// ==================== ZEROSCOPE ====================
app.post("/api/video/generate-zeroscope", async (req, res) => {
  const { prompt, fps = 24, width = 1024, height = 576, guidance_scale = 17.5, negative_prompt = "very blue, dust, noisy, ugly, distorted" } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  const apiKey = process.env.REPLICATE_API_KEY_ZEROSCOPE;
  if (!apiKey) return res.status(500).json({ error: "Zeroscope API key not configured", demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" });

  try {
    const Replicate = (await import('replicate')).default;
    const replicate = new Replicate({ auth: apiKey });
    const output = await replicate.run("anotherjesse/zeroscope-v2-xl:9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351", {
      input: { fps: parseInt(fps), width: parseInt(width), height: parseInt(height), prompt, guidance_scale: parseFloat(guidance_scale), negative_prompt }
    });
    let videoUrl = Array.isArray(output)? output[0]?.url?.() || output[0] : output?.url || output;
    if (!videoUrl) throw new Error("No video URL found");
    res.json({ videoUrl, status: "success", provider: "zeroscope" });
  } catch (error) {
    console.error("❌ Zeroscope Error:", error.message);
    res.status(500).json({ error: error.message, demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
  }
});

// ==================== SORA ====================
app.post("/api/video/generate-sora", async (req, res) => {
  const { prompt, model = "sora-2-pro", seconds = 8, size = "1280x720" } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  const apiKey = process.env.OPENAI_VIDEO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Sora API key not configured", videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });

  try {
    const openai = new OpenAI({ apiKey });
    if (!openai.videos?.create) throw new Error('Sora API not available');
    const video = await openai.videos.create({ model, prompt, seconds: parseInt(seconds), size });
    let videoStatus = video, attempts = 0;
    while (videoStatus.status!== "completed" && videoStatus.status!== "failed" && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      videoStatus = await openai.videos.retrieve(video.id);
      attempts++;
    }
    if (videoStatus.status!== "completed") throw new Error("Sora timeout or failed");
    res.json({ videoUrl: videoStatus.url, status: "success", provider: "sora", videoId: video.id });
  } catch (error) {
    console.error("❌ Sora API error:", error.message);
    res.status(500).json({ error: error.message, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
  }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server v2.1 running on port ${PORT} with persistent memory`);
});
