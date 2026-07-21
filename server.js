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
const upload = multer({ dest: '/tmp/uploads' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ========== TWILIO WHATSAPP SETUP ==========
let twilioClient;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } else {
    console.log("⚠️ Twilio credentials not set – WhatsApp disabled");
  }
} catch (error) {
  console.error("❌ Twilio Initialization Error:", error.message);
}
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
    console.log("✅ MongoDB Connected");
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
    return `\n\n📷 Previous image analysis: "${ctx.lastAnalysis.substring(0, 400)}"\n\n`;
  }
  return "";
}

// ========== FAST API PROVIDERS ==========
const fastProviders = [
  { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'mixtral-8x7b-32768' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', key: process.env.DEEPSEEK_API_KEY, model: 'deepseek-v4-flash' },
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

// ========== AGENT CHAT ==========
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

// ========== ANALYZE IMAGE FROM URL (WhatsApp) - FIXED with Twilio Auth ==========
async function analyzeImageFromUrl(imageUrl, userQuestion) {
  if (!process.env.OPENAI_API_KEY) return "Image analysis not configured.";
  
  try {
    // Fetch image with Twilio Basic Authentication
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(imageUrl, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      console.error(`Invalid content type: ${contentType}`);
      return "Sorry, I couldn't retrieve a valid image. Please try again.";
    }
    
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are SahcharAI, a WhatsApp assistant. Analyze images and reply in Hindi/English. Keep it concise." },
        { role: "user", content: [
          { type: "text", text: userQuestion || "What's in this image? Describe briefly." },
          { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }
        ]}
      ],
      max_tokens: 300
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Image analysis error:", error);
    return "Sorry, I couldn't analyze the image. Please try again.";
  }
}

// ========== WHATSAPP WEBHOOK (FIXED MEDIA HANDLING) ==========
app.post('/whatsapp-webhook', async (req, res) => {
  if (!twilioClient) {
    console.error('❌ WhatsApp Webhook: Twilio client not initialized');
    return res.status(503).send('WhatsApp Service Unavailable');
  }
  try {
    const senderId = req.body.From;
    const messageText = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0');
    
    console.log(`📩 WhatsApp [${senderId}]: ${messageText.substring(0, 100)}${numMedia > 0 ? ` + ${numMedia} media` : ''}`);
    
    const sessionId = senderId;
    let conversation = conversations.get(sessionId);
    if (!conversation) {
      const history = await loadConversationFromDB(sessionId, 10);
      conversation = [
        { role: "system", content: `You are SahcharAI, a friendly AI assistant. Created by Ram Prakash Kumar. Reply in Hindi or Hinglish. Keep responses short (2-3 sentences). Use emojis. WhatsApp conversation.` },
        ...history
      ];
      conversations.set(sessionId, conversation);
    }
    
    // 1. If there are media (images/documents)
    if (numMedia > 0) {
      let analysisResults = [];
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const contentType = req.body[`MediaContentType${i}`];
        console.log(`Media ${i}: URL=${mediaUrl}, Type=${contentType}`);
        
        if (mediaUrl && contentType && contentType.startsWith('image/')) {
          const analysis = await analyzeImageFromUrl(mediaUrl, messageText || "Describe this image");
          analysisResults.push(analysis);
        } else {
          analysisResults.push(`📎 Received a file (${contentType || 'unknown type'}). I can only analyze images at the moment.`);
        }
      }
      
      const finalReply = analysisResults.join('\n\n');
      conversation.push({ role: "user", content: messageText || "[Image]" });
      conversation.push({ role: "assistant", content: finalReply });
      if (conversation.length > 22) conversation.splice(1, conversation.length - 21);
      saveConversationToDB(sessionId, messageText || "[Image]", finalReply, 'WhatsApp');
      
      await twilioClient.messages.create({
        body: finalReply,
        from: TWILIO_WHATSAPP_NUMBER,
        to: senderId
      });
      return res.status(200).send('OK');
    }
    
    // 2. Check if user wants to generate an image
    const isImageGenRequest = /(तस्वीर|इमेज|फोटो|पिक्चर|image|img)\s+(बना|जनरेट|बनाओ|दिखाओ)/i.test(messageText);
    if (isImageGenRequest) {
      console.log(`🎨 Generating image for WhatsApp user...`);
      let prompt = messageText.replace(/(तस्वीर|इमेज|फोटो|image|img)\s+(बना|जनरेट|बनाओ|दिखाओ)/gi, '').trim();
      if (!prompt) prompt = messageText;
      
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
      
      await twilioClient.messages.create({
        body: "🎨 Here's your generated image:",
        from: TWILIO_WHATSAPP_NUMBER,
        to: senderId
      });
      try {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_NUMBER,
          to: senderId,
          mediaUrl: [imageUrl]
        });
        console.log(`✅ Image sent to WhatsApp`);
      } catch (mediaError) {
        await twilioClient.messages.create({
          body: "Sorry, I couldn't generate the image. Please try again.",
          from: TWILIO_WHATSAPP_NUMBER,
          to: senderId
        });
      }
      return res.status(200).send('OK');
    }
    
    // 3. Normal text conversation
    conversation.push({ role: "user", content: messageText });
    const botReply = await agentChat(conversation, sessionId);
    conversation.push({ role: "assistant", content: botReply });
    if (conversation.length > 22) conversation.splice(1, conversation.length - 21);
    saveConversationToDB(sessionId, messageText, botReply, 'WhatsApp');
    
    await twilioClient.messages.create({
      body: botReply,
      from: TWILIO_WHATSAPP_NUMBER,
      to: senderId
    });
    
    console.log(`✅ WhatsApp reply sent`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    try {
      await twilioClient.messages.create({
        body: "⚠️ Sorry, I encountered an error. Please try again later.",
        from: TWILIO_WHATSAPP_NUMBER,
        to: req.body.From
      });
    } catch(e) {}
    res.status(500).send('Error');
  }
});

// GET endpoint for webhook verification
app.get('/whatsapp-webhook', (req, res) => {
  res.status(200).send('OK');
});

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send(`🌿 SahcharAI Backend v20.1 - Developer: Ram Prakash Kumar - WhatsApp Image Analysis Fixed ✅`));
app.post("/", (req, res) => res.json({ message: `Hello ${req.body.name || 'User'}! SahcharAI is live.`, developer: "Ram Prakash Kumar", status: "active" }));
app.all("/api", (req, res) => {
  const name = req.body?.name || req.query?.name || "User";
  res.json({ message: `Hello ${name}! Migration test successful.`, developer: "Ram Prakash Kumar", status: "active" });
});
app.all("/health", (req, res) => res.json({ status: "ok", version: "20.1", developer: "Ram Prakash Kumar" }));

// ==================== 1. SAHCHARAI ====================
app.post("/chat", async (req, res) => {
  const sid = getSessionId(req);
  const { message } = req.body;
  if (!message) return res.status(400).json({ reply: "Message required 🙏" });

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' });
    const imageContext = getImageContextText(sid);

    let conversation = conversations.get(sid);
    if (!conversation) {
      const history = await loadConversationFromDB(sid, 10);
      // STRICT DEVELOPER NAME RULE & SYSTEM INSTRUCTION
      conversation = [
        { role: "system", content: `You are SahcharAI, a helpful assistant. You must NEVER mention the developer's name (e.g., Prakash) or introduce yourself unless the user explicitly asks: 'Who developed you?' or 'What is the developer's name?'. Keep your identity subtle. Respond in Hindi/English/Hinglish. 2-3 short sentences. Emoji 🙏🌿. Current time: ${currentDateTime} IST. Use web search for new topics. ${imageContext}

📌 महत्वपूर्ण: अगर उपयोगकर्ता तस्वीर या वीडियो बनाने को कहे, तो उसे 'इमेज बनाएं' या 'वीडियो बनाएं' बटन का उपयोग करने का निर्देश दें।` },
        ...history
      ];
      conversations.set(sid, conversation);
    }
    
    // IMMEDIATE IN-MEMORY UPDATE: Push user message to history
    conversation.push({ role: "user", content: message });
    
    // RESTORE MULTI-TURN CONTEXT & ISOLATE TIMESTAMPS
    // Ensure we only pass clean role/content to the agent
    const agentMessages = conversation.map(m => ({
      role: m.role,
      content: m.content
    }));

    const reply = await agentChat(agentMessages, sid);
    
    // IMMEDIATE IN-MEMORY UPDATE: Push assistant reply to history
    conversation.push({ role: "assistant", content: reply });
    
    if (conversation.length > 22) {
      conversation = [conversation[0], ...conversation.slice(-20)];
      conversations.set(sid, conversation);
    }
    
    // DB PERSISTENCE
    saveConversationToDB(sid, message, reply, 'SahcharAI');
    res.json({ reply });

  } catch (error) {
    console.error("Chat error:", error.message);
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
    const imageContext = getImageContextText(sid);

    let conversation = conversations.get(sid + "_assistant");
    if (!conversation) {
      const history = await loadConversationFromDB(sid, 10);
      conversation = [
        { role: "system", content: `तुम 'SahcharAssistant' हो – राम प्रकाश कुमार द्वारा निर्मित। 1-2 वाक्य में जवाब दो। इमोजी 🙏। वर्तमान समय: ${currentDateTime} IST${imageContext}

📌 महत्वपूर्ण: अगर कोई तस्वीर या वीडियो बनाने को कहे, तो उसे ऐप के 'इमेज बनाएं' या 'वीडियो बनाएं' बटन का उपयोग करने का सुझाव दो।` },
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
    console.error("Assistant error:", error.message);
    res.json({ reply: "क्षमा करें, सेवा व्यस्त है। 🙏" });
  }
});

// ==================== 3. SUPERSAHCHAR ====================
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
        { role: "system", content: `तुम 'SuperSahchar' हो – एक दोस्ताना AI। user का message दोहराना मत। 1-2 छोटे वाक्य। इमोजी 😊🙏। वर्तमान समय: ${currentDateTime} IST${imageContext}

📌 अगर user तस्वीर/वीडियो बनाने को कहे, तो कहो: "आप ऐप में 'इमेज बनाएं' बटन दबाकर अपनी तस्वीर बना सकते हैं। मैं सिर्फ बातचीत कर सकता हूँ।"` },
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
    console.error("SuperSahchar error:", error.message);
    res.json({ reply: "नमस्ते! मैं SuperSahchar हूँ। आपकी कैसे मदद कर सकता हूँ? 😊🙏" });
  }
});

// ==================== 4. IMAGE GENERATION (for app) ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  console.log(`🎨 Image: ${prompt}`);
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  let cleanPrompt = prompt.replace(/^(तस्वीर|इमेज|फोटो|Image|img)\s+(बना|जनरेट करो|दिखाओ|बनाओ)\s*/gi, '');
  cleanPrompt = cleanPrompt.trim();
  if (cleanPrompt.length === 0) cleanPrompt = prompt;
  
  // GPT-Image-1
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024",
        quality: "auto"
      });
      if (response.data && response.data[0]) {
        if (response.data[0].url) {
          return res.json({ imageUrl: response.data[0].url, provider: "gpt-image-1" });
        }
        if (response.data[0].b64_json) {
          return res.json({ imageUrl: `data:image/png;base64,${response.data[0].b64_json}`, provider: "gpt-image-1" });
        }
      }
    } catch (e) { console.log(`⚠️ GPT-Image-1 failed: ${e.message}`); }
  }
  
  // Replicate fallback
  const replicateToken = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_KEY_ZEROSCOPE;
  if (replicateToken) {
    try {
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
          await new Promise(r => setTimeout(r, 1500));
          const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
            headers: { "Authorization": `Token ${replicateToken}` }
          });
          const statusData = await statusRes.json();
          if (statusData.status === "succeeded") {
            imageUrl = statusData.output[0];
            break;
          } else if (statusData.status === "failed") break;
        }
        if (imageUrl) return res.json({ imageUrl, provider: "replicate-sdxl" });
      }
    } catch (e) { console.log(`⚠️ Replicate failed: ${e.message}`); }
  }
  
  // Pollinations
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${Date.now()}&nologo=true`;
  res.json({ imageUrl: pollinationsUrl, provider: "pollinations" });
});

// ==================== 5. IMAGE ANALYSIS (app) ====================
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
      return res.json({ analysis });
    }
    res.json({ analysis: "✅ विश्लेषण पूरा हुआ!" });
  } catch (error) {
    console.error("Analysis error:", error.message);
    res.status(500).json({ error: "विश्लेषण में त्रुटि" });
  }
});

// ==================== 6. VIDEO GENERATION (demo) ====================
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
  if (!deviceId || deviceId === "default") deviceId = `web-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Agent Server v20.1 - WhatsApp Ready on ${PORT}`));
