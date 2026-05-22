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
import { getJson } from 'serpapi';
import twilio from 'twilio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ========== TWILIO WHATSAPP SETUP ==========
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID || 'AC28fc9f63c2e4263ef722b80cd326ed08',
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

// ========== MONGODB SETUP ==========
let db = null;
const conversations = new Map();
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
function getSessionId(req) {
  let sid = req.body?.sessionId || req.headers['x-session-id'] || req.query?.sessionId;
  if (!sid || sid === "default" || sid === "null" || sid.length < 10) {
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

// ========== WEB SEARCH TOOL ==========
async function searchWeb(query) {
  if (!process.env.SERPAPI_API_KEY) {
    console.log("⚠️ SERPAPI_API_KEY not set, web search disabled");
    return null;
  }
  try {
    const response = await getJson({
      engine: "google",
      api_key: process.env.SERPAPI_API_KEY,
      q: query,
      num: 5
    });
    const results = response.organic_results || [];
    return results.map(r => ({ title: r.title, link: r.link, snippet: r.snippet }));
  } catch (error) {
    console.error("Search error:", error);
    return null;
  }
}

// ========== AGENT CHAT (with web search) ==========
async function agentChat(messages, sessionId) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const tools = [{
    type: "function",
    function: {
      name: "searchWeb",
      description: "Search the internet for current information when you don't know the answer or need up-to-date facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query (preferably in English for best results)" }
        },
        required: ["query"]
      }
    }
  }];

  try {
    let response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      tools: tools,
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 500
    });

    const responseMessage = response.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      const toolCall = toolCalls[0];
      const functionArgs = JSON.parse(toolCall.function.arguments);
      console.log(`🔍 AI requested web search: "${functionArgs.query}"`);
      
      const searchResults = await searchWeb(functionArgs.query);
      
      const updatedMessages = [...messages, responseMessage, {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(searchResults || { error: "No results found" })
      }];
      
      const secondResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: updatedMessages,
        temperature: 0.7,
        max_tokens: 300
      });
      return secondResponse.choices[0].message.content;
    } else {
      return responseMessage.content;
    }
  } catch (error) {
    console.error("Agent chat error:", error);
    const fallback = await fastChat(messages, ['OpenAI', 'Groq', 'DeepSeek']);
    return fallback ? fallback.reply : "क्षमा करें, अभी सेवा व्यस्त है। 🙏";
  }
}

// ========== UPLOAD BASE64 IMAGE TO IMGBB (Using API Key from env) ==========
async function uploadBase64ToImgBB(base64Data) {
  const imgbbKey = process.env.IMGBB_API_KEY;
  if (!imgbbKey) {
    console.log("⚠️ IMGBB_API_KEY not set, cannot upload base64");
    return null;
  }
  
  try {
    const formData = new FormData();
    formData.append('image', base64Data);
    
    const response = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
      method: 'POST',
      body: formData
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.data?.url) {
        console.log(`✅ Uploaded to ImgBB: ${data.data.url}`);
        return data.data.url;
      }
    }
    return null;
  } catch (error) {
    console.log(`ImgBB upload failed: ${error.message}`);
    return null;
  }
}

// ========== GENERATE IMAGE FOR WHATSAPP (Pollinations First - Always HTTPS URL) ==========
async function generateImageForWhatsApp(prompt) {
  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  // PROVIDER 1: Pollinations.ai - Always gives HTTPS URL, WhatsApp compatible
  console.log(`🎨 Trying Pollinations (best for WhatsApp)...`);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
  
  // Verify URL is accessible
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const checkRes = await fetch(pollinationsUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    if (checkRes.ok) {
      console.log(`✅ Pollinations URL ready for WhatsApp`);
      return pollinationsUrl;
    }
  } catch (e) {
    console.log(`⚠️ Pollinations check failed: ${e.message}`);
  }
  
  // PROVIDER 2: OpenAI GPT-Image-1 (for better quality, then upload to ImgBB)
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log(`🎨 Trying GPT-Image-1...`);
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024",
        quality: "auto"
      });
      
      if (response.data && response.data[0]) {
        // If URL is returned directly
        if (response.data[0].url) {
          console.log(`✅ GPT-Image-1 returned URL`);
          return response.data[0].url;
        }
        // If base64 is returned, upload to ImgBB
        if (response.data[0].b64_json) {
          console.log(`📦 GPT-Image-1 returned base64, uploading to ImgBB...`);
          const uploadedUrl = await uploadBase64ToImgBB(response.data[0].b64_json);
          if (uploadedUrl) {
            console.log(`✅ Base64 uploaded, URL obtained for WhatsApp`);
            return uploadedUrl;
          }
        }
      }
    } catch (e) { console.log(`⚠️ GPT-Image-1 failed: ${e.message}`); }
  }
  
  // PROVIDER 3: Final Pollinations fallback
  console.log(`🎨 Using Pollinations final fallback...`);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
}

// ========== WHATSAPP WEBHOOK ENDPOINT ==========
app.post('/whatsapp-webhook', async (req, res) => {
  try {
    const userMessage = req.body.Body;
    const senderId = req.body.From;
    
    if (!userMessage) {
      return res.status(200).send('OK');
    }
    
    console.log(`📱 WhatsApp [${senderId}]: ${userMessage}`);
    
    const sessionId = senderId;
    let conversation = conversations.get(sessionId);
    if (!conversation) {
      const history = await loadConversationFromDB(sessionId, 10);
      conversation = [
        { role: "system", content: `तुम 'SahcharAI' हो – एक दोस्ताना AI सहायक। हिंदी/अंग्रेजी/हिंग्लिश में बात करो। निर्माता: राम प्रकाश कुमार (सिर्फ पूछने पर बताना)। 2-3 छोटे वाक्यों में जवाब दो। इमोजी 🙏🌿। WhatsApp पर बात हो रही है।` },
        ...history
      ];
      conversations.set(sessionId, conversation);
    }
    
    conversation.push({ role: "user", content: userMessage });
    
    // Check if user wants to generate image
    const isImageRequest = userMessage.match(/(तस्वीर|इमेज|फोटो|पिक्चर|image|img)\s+(बना|जनरेट|बनाओ|दिखाओ)/i);
    
    if (isImageRequest) {
      console.log(`🎨 Generating image for WhatsApp user...`);
      const imageUrl = await generateImageForWhatsApp(userMessage);
      
      if (imageUrl && imageUrl.startsWith('https://')) {
        // Send text caption first
        await twilioClient.messages.create({
          body: "🎨 ये रही आपकी तस्वीर:",
          from: TWILIO_WHATSAPP_NUMBER,
          to: senderId
        });
        
        // Send image
        try {
          await twilioClient.messages.create({
            from: TWILIO_WHATSAPP_NUMBER,
            to: senderId,
            mediaUrl: [imageUrl]
          });
          console.log(`✅ Image sent to WhatsApp`);
        } catch (mediaError) {
          console.error(`Failed to send image: ${mediaError.message}`);
          await twilioClient.messages.create({
            body: "❌ तस्वीर भेजने में समस्या आई। कृपया पुनः प्रयास करें।",
            from: TWILIO_WHATSAPP_NUMBER,
            to: senderId
          });
        }
        
        conversation.push({ role: "assistant", content: "तस्वीर भेज दी गई है। 🎨" });
        saveConversationToDB(sessionId, userMessage, "Image sent", 'WhatsApp');
      } else {
        await twilioClient.messages.create({
          body: "❌ इमेज बनाने में समस्या आई। कृपया पुनः प्रयास करें। 🙏",
          from: TWILIO_WHATSAPP_NUMBER,
          to: senderId
        });
      }
      return res.status(200).send('OK');
    }
    
    // Normal chat response
    const botReply = await agentChat(conversation, sessionId);
    
    conversation.push({ role: "assistant", content: botReply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sessionId, conversation);
    }
    
    saveConversationToDB(sessionId, userMessage, botReply, 'WhatsApp');
    
    await twilioClient.messages.create({
      body: botReply,
      from: TWILIO_WHATSAPP_NUMBER,
      to: senderId
    });
    
    console.log(`✅ WhatsApp reply sent to ${senderId}`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).send('Error');
  }
});

// ========== WHATSAPP SEND MESSAGE ENDPOINT ==========
app.post('/api/whatsapp/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "To and message required" });
  }
  
  try {
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_WHATSAPP_NUMBER,
      to: formattedTo
    });
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== WHATSAPP WEBHOOK VERIFICATION ==========
app.get('/whatsapp-webhook', (req, res) => {
  res.status(200).send('OK');
});

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 SahcharAI Backend v19.0 - WhatsApp Optimized ✅"));

// ==================== 1. SAHCHARAI (Unchanged) ====================
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
        { role: "system", content: `तुम 'SahcharAI' हो – एक दोस्ताना AI सहायक। हिंदी/अंग्रेजी/हिंग्लिश में बात करो। निर्माता: राम प्रकाश कुमार (सिर्फ पूछने पर बताना, हर बार मत बताना)। 2-3 छोटे वाक्यों में जवाब दो। इमोजी 🙏🌿। वर्तमान समय: ${currentDateTime} IST। यदि कोई नया या अज्ञात विषय पूछे तो web search का उपयोग करो।${imageContext}` },
        ...history
      ];
      conversations.set(sid, conversation);
    }
    conversation.push({ role: "user", content: message });
    
    const reply = await agentChat(conversation, sid);
    
    conversation.push({ role: "assistant", content: reply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid, conversation);
    }
    
    saveConversationToDB(sid, message, reply, 'SahcharAI (Agent)');
    
    console.log(`✅ Reply [${sid.substring(0, 8)}...]: ${reply.substring(0, 50)}...`);
    res.json({ reply: reply, provider: "agent" });

  } catch (error) {
    console.error("❌ /chat error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 2. SAHCHARASSISTANT (Unchanged) ====================
app.post("/chat-assistant", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const imageContext = getImageContextText(sid);

    let conversation = conversations.get(sid + "_assistant");
    if (!conversation) {
      const history = await loadConversationFromDB(sid, 10);
      conversation = [
        { role: "system", content: `तुम 'SahcharAssistant' हो – राम प्रकाश कुमार द्वारा निर्मित। 1-2 वाक्य में जवाब दो। इमोजी 🙏। वर्तमान समय: ${currentDateTime} IST${imageContext}` },
        ...history
      ];
      conversations.set(sid + "_assistant", conversation);
    }
    conversation.push({ role: "user", content: message });
    
    const result = await fastChat(conversation, ['Groq', 'DeepSeek', 'OpenAI', 'Kimi']);
    if (!result) throw new Error("All providers failed");
    
    conversation.push({ role: "assistant", content: result.reply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid + "_assistant", conversation);
    }
    
    saveConversationToDB(sid, message, result.reply, `SahcharAssistant (${result.provider})`);
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR (Unchanged) ====================
app.post("/chat-nvidia", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const imageContext = getImageContextText(sid);

    let conversation = conversations.get(sid + "_super");
    if (!conversation) {
      const history = await loadConversationFromDB(sid, 10);
      conversation = [
        { role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। इमोजी 😊🙏। वर्तमान समय: ${currentDateTime} IST${imageContext}` },
        ...history
      ];
      conversations.set(sid + "_super", conversation);
    }
    conversation.push({ role: "user", content: message });
    
    const result = await fastChat(conversation, ['Groq', 'DeepSeek', 'OpenAI', 'Kimi']);
    if (!result) throw new Error("All providers failed");
    
    conversation.push({ role: "assistant", content: result.reply });
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid + "_super", conversation);
    }
    
    saveConversationToDB(sid, message, result.reply, `SuperSahchar (${result.provider})`);
    res.json({ reply: result.reply });

  } catch (error) {
    console.error("❌ SuperSahchar error:", error.message);
    res.json({ reply: "नमस्ते! मैं SuperSahchar हूँ। आपकी कैसे मदद कर सकता हूँ? 😊🙏" });
  }
});

// ==================== 4. IMAGE GENERATION FOR APP (Unchanged - GPT-Image-1 First) ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image: ${prompt}`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  // PROVIDER 1: GPT-Image-1
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log(`🎨 Trying GPT-Image-1...`);
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024",
        quality: "auto"
      });
      
      if (response.data && response.data[0]) {
        if (response.data[0].url) {
          console.log(`✅ Image by GPT-Image-1 (URL)`);
          return res.json({ imageUrl: response.data[0].url, provider: "gpt-image-1" });
        }
        if (response.data[0].b64_json) {
          console.log(`✅ Image by GPT-Image-1 (base64)`);
          const imageUrl = `data:image/png;base64,${response.data[0].b64_json}`;
          return res.json({ imageUrl: imageUrl, provider: "gpt-image-1" });
        }
      }
    } catch (e) { console.log(`⚠️ GPT-Image-1 failed: ${e.message}`); }
  }
  
  // PROVIDER 2: Replicate SDXL
  const replicateToken = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_KEY_ZEROSCOPE;
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
    } catch (e) { console.log(`⚠️ Replicate failed: ${e.message}`); }
  }
  
  // PROVIDER 3: Pollinations
  console.log(`🎨 Using Pollinations fallback...`);
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
server.listen(PORT, () => console.log(`🚀 Agent Server v19.0 - WhatsApp Optimized on ${PORT}`));
```
