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
  console.error("❌ FATAL: MONGODB_URI not set");
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

// ========== SMART API PROVIDERS ==========
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
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v5.0 Smart ✅"));

// ==================== 1. SAHCHARAI ====================
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
    
    const reply = await smartChat(messages, 'kimi', ['deepseek', 'groq', 'openai']);
    
    if (!reply) throw new Error("All providers failed");
    
    await saveConversationToDB(sid, message, reply, 'SahcharAssistant');
    res.json({ reply: reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR (FIXED - No Echo) ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  
  console.log(`📩 SuperSahchar Request [${sid}]: ${message?.substring(0, 50)}...`);
  
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  const nvidiaKey = process.env.NGC_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  
  // Try NVIDIA NIM first
  if (nvidiaKey) {
    try {
      console.log(`🖼️ Trying NVIDIA NIM...`);
      const nvidiaClient = new OpenAI({ 
        apiKey: nvidiaKey, 
        baseURL: 'https://integrate.api.nvidia.com/v1' 
      });
      
      const completion = await nvidiaClient.chat.completions.create({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { 
            role: "system", 
            content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI सहायक। 
            नियम:
            1. हिंदी या हिंग्लिश में छोटे जवाब दो (1-2 वाक्य)
            2. कभी भी user का message दोहराओ मत
            3. अपना नाम "SuperSahchar" बताओ
            4. निर्माता: राम प्रकाश कुमार
            5. इमोजी का इस्तेमाल करो 😊🙏`
          },
          { role: "user", content: message }
        ],
        max_tokens: 200,
        temperature: 0.8
      });
      
      const reply = completion.choices[0]?.message?.content;
      if (reply && !reply.includes(message)) {
        console.log(`✅ NVIDIA NIM reply: ${reply.substring(0, 50)}...`);
        await saveConversationToDB(sid, message, reply, 'SuperSahchar');
        return res.json({ reply: reply, provider: "nvidia-nim" });
      } else {
        console.log(`⚠️ NVIDIA returned echo or empty, trying fallback...`);
      }
    } catch (error) {
      console.log(`⚠️ NVIDIA NIM failed: ${error.message}`);
    }
  }
  
  // Fallback to DeepSeek (Primary Fallback)
  if (deepseekKey) {
    try {
      console.log(`🔄 Fallback to DeepSeek for SuperSahchar...`);
      const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          "Authorization": `Bearer ${deepseekKey}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { 
              role: "system", 
              content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। 
              बहुत जरूरी: user का message दोहराना मत, सिर्फ अपने शब्दों में जवाब दो।
              जवाब 1-2 छोटे वाक्यों में दो। इमोजी 😊🙏।`
            },
            { role: "user", content: message }
          ],
          max_tokens: 200,
          temperature: 0.8
        })
      });
      
      const data = await response.json();
      if (response.ok && data.choices && data.choices[0]) {
        let reply = data.choices[0].message.content;
        // Remove any echo of user message
        if (reply.includes(message)) {
          reply = reply.replace(message, '').trim();
        }
        if (reply.length === 0) {
          reply = "मैं SuperSahchar हूँ! आपकी कैसे मदद कर सकता हूँ? 😊";
        }
        console.log(`✅ DeepSeek reply: ${reply.substring(0, 50)}...`);
        await saveConversationToDB(sid, message, reply, 'SuperSahchar');
        return res.json({ reply: reply, provider: "deepseek-fallback" });
      }
    } catch (error) {
      console.log(`⚠️ DeepSeek fallback failed: ${error.message}`);
    }
  }
  
  // Final fallback - Static response
  console.log(`⚠️ Using static fallback for SuperSahchar`);
  const fallbackReply = "नमस्ते! मैं SuperSahchar हूँ। थोड़ी देर में सही से बात कर पाऊंगा। कृपया कुछ और पूछें। 😊🙏";
  await saveConversationToDB(sid, message, fallbackReply, 'SuperSahchar');
  res.json({ reply: fallbackReply, provider: "static-fallback" });
});
// ==================== 4. SMART IMAGE GENERATION (Priority: OpenAI DALL-E → Replicate → Pollinations) ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image Request: ${prompt}`);
  
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });
  
  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  const openaiKey = process.env.OPENAI_API_KEY;
  const replicateToken = process.env.REPLICATE_API_KEY_ZEROSCOPE;
  const encodedPrompt = encodeURIComponent(cleanPrompt);
  const timestamp = Date.now();
  
  // Priority Order: OpenAI DALL-E → Replicate SDXL → Pollinations → Placeholder
  
  // PROVIDER 1: OpenAI DALL-E (Best Quality)
  if (openaiKey) {
    try {
      console.log(`🎨 Trying OpenAI DALL-E 3...`);
      const openai = new OpenAI({ apiKey: openaiKey });
      const response = await openai.images.generate({
        model: "dall-e-3",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024",
        quality: "standard"
      });
      if (response.data && response.data[0] && response.data[0].url) {
        console.log(`✅ Image by DALL-E 3`);
        return res.json({ imageUrl: response.data[0].url, provider: "dall-e-3" });
      }
    } catch (e) {
      console.log(`⚠️ DALL-E 3 failed: ${e.message}`);
      try {
        const openai = new OpenAI({ apiKey: openaiKey });
        const response = await openai.images.generate({
          model: "dall-e-2",
          prompt: cleanPrompt,
          n: 1,
          size: "1024x1024"
        });
        if (response.data && response.data[0] && response.data[0].url) {
          console.log(`✅ Image by DALL-E 2`);
          return res.json({ imageUrl: response.data[0].url, provider: "dall-e-2" });
        }
      } catch (e2) {
        console.log(`⚠️ DALL-E 2 failed: ${e2.message}`);
      }
    }
  }
  
  // PROVIDER 2: Replicate SDXL
  if (replicateToken) {
    try {
      console.log(`🎨 Trying Replicate SDXL...`);
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Authorization": `Token ${replicateToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
          input: { prompt: cleanPrompt, width: 1024, height: 1024, num_outputs: 1 }
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
    } catch (e) {
      console.log(`⚠️ Replicate failed: ${e.message}`);
    }
  }
  
  // PROVIDER 3: Pollinations.ai (Free Fallback)
  console.log(`🎨 Using Pollinations.ai fallback...`);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${timestamp}&model=flux&nologo=true`;
  
  // Check if URL is accessible
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const checkRes = await fetch(pollinationsUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    if (checkRes.ok) {
      console.log(`✅ Image by Pollinations.ai`);
      return res.json({ imageUrl: pollinationsUrl, provider: "pollinations" });
    }
  } catch (e) {
    console.log(`⚠️ Pollinations check failed`);
  }
  
  // PROVIDER 4: Ultimate Fallback (Placeholder with text)
  console.log(`🎨 Using placeholder fallback...`);
  const placeholderUrl = `https://placehold.co/1024x1024/4CAF50/white?text=${encodedPrompt.substring(0, 30)}`;
  res.json({ imageUrl: placeholderUrl, provider: "placeholder", note: "Image generation temporarily unavailable" });
});

// ==================== 5. IMAGE ANALYZE ====================
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

// ==================== 6. SMART VIDEO GENERATION (Priority: Replicate Video → OpenAI Video → Pollinations → Demo) ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎬 Video Request: ${prompt?.substring(0,50)}...`);

  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });

  let cleanPrompt = prompt.replace(/^(वीडियो|video)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;

  const encodedPrompt = encodeURIComponent(cleanPrompt);
  const timestamp = Date.now();
  const replicateToken = process.env.REPLICATE_API_KEY_ZEROSCOPE;
  const openaiKey = process.env.OPENAI_API_KEY;

  // PRIORITY 1: Replicate Video (ZeroScope)
  if (replicateToken) {
    try {
      console.log(`🎬 Trying Replicate ZeroScope Video...`);
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Authorization": `Token ${replicateToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "zeroscope/zeroscope-xl:7198ce1e3b3d9d4f0e4d8c6f9e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b",
          input: { prompt: cleanPrompt, width: 1024, height: 576, num_frames: 24, fps: 8 }
        })
      });
      if (response.ok) {
        const data = await response.json();
        const predictionId = data.id;
        let videoUrl = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
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
    } catch (e) {
      console.log(`⚠️ Replicate video failed: ${e.message}`);
    }
  }

  // PRIORITY 2: OpenAI Video (if available in future)
  if (openaiKey && false) { // Disabled until OpenAI releases video API
    try {
      console.log(`🎬 Trying OpenAI Video...`);
      // OpenAI video generation not yet available
    } catch (e) {
      console.log(`⚠️ OpenAI video failed: ${e.message}`);
    }
  }

  // PRIORITY 3: Pollinations Image Sequence (Image-based video)
  console.log(`🎬 Trying Pollinations Image Sequence...`);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=576&model=flux&nologo=true&seed=${timestamp}`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const checkRes = await fetch(pollinationsUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    if (checkRes.ok) {
      console.log(`✅ Image sequence by Pollinations`);
      return res.json({ 
        videoUrl: pollinationsUrl, 
        provider: "pollinations-image", 
        status: "generated",
        message: "AI generated image - Click to view"
      });
    }
  } catch (e) {
    console.log(`⚠️ Pollinations failed: ${e.message}`);
  }

  // PRIORITY 4: Demo Video (Final Fallback)
  console.log(`🎬 Using demo video fallback...`);
  res.json({
    videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
    provider: "demo-fallback",
    status: "demo",
    message: "Demo video - Full video generation coming soon 🙏"
  });
});

// ==================== WEBSOCKET LIVE AUDIO ====================
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
          messages: [
            { role: "system", content: "You are SahcharAI. Reply in Hindi, 1-2 sentences." },
            { role: "user", content: userText }
          ],
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
server.listen(PORT, () => console.log(`🚀 Smart Server v5.0 on ${PORT}`));
