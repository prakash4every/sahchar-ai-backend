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

// MONGODB_URI check
if (!process.env.MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI environment variable is not set. Database features will be disabled.");
}

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// JSON parsing error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Invalid JSON received:', err.message);
    return res.status(400).json({ 
      reply: "क्षमा करें, मैसेज का फॉर्मेट सही नहीं है। कृपया किसी भी प्रकार के स्पेशल कैरेक्टर (जैसे कि कोट्स, बैकस्लैश) को हटाकर दोबारा भेजें। 🙏" 
    });
  }
  next(err);
});

// MongoDB setup
let mongoClient;
let db = null;

if (process.env.MONGODB_URI) {
  mongoClient = new MongoClient(process.env.MONGODB_URI);
  async function connectToMongoDB() {
    try {
      await mongoClient.connect();
      console.log("✅ Connected to MongoDB");
      db = mongoClient.db();
    } catch (error) {
      console.error("❌ MongoDB connection error:", error.message);
      db = null;
    }
  }
  connectToMongoDB();
} else {
  console.warn("⚠️ MongoDB client not initialized because MONGODB_URI is missing.");
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// In-memory conversation storage
const conversations = {};

// Image context storage per session
const imageContexts = {};

// Helper function to get image context for a session
function getImageContextText(sid) {
  if (imageContexts[sid] && imageContexts[sid].lastAnalysis) {
    return `\n\n📷 **पिछली बातचीत का संदर्भ:** उपयोगकर्ता ने एक इमेज अपलोड की थी और मैंने उसका विश्लेषण किया था।
विश्लेषण: "${imageContexts[sid].lastAnalysis.substring(0, 500)}"
अब उपयोगकर्ता ने पूछा है। कृपया इसी संदर्भ में जवाब दें।\n\n`;
  }
  return "";
}

// GET routes
app.get("/", (req, res) => {
  res.send("🌿 सहचर AI बैकएंड चालू है ✅ (मेमोरी अपडेट + MongoDB)");
});

app.get("/chat", (req, res) => {
  res.send("सहचर चैट एंडपॉइंट काम कर रहा है ✅");
});

// ==================== DEEPSEEK CHAT (DEFAULT) with Image Context ====================
app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  const sid = sessionId || "default";

  if (!message) {
    return res.status(400).json({ reply: "Message required 🙏" });
  }

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const imageContext = getImageContextText(sid);

    if (!conversations[sid]) {
      conversations[sid] = [
        {
          role: "system",
          content: `
तुम 'सहचर' हो – एक AI सहायक जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।

महत्वपूर्ण निर्देश:
- तुम्हें **राम प्रकाश कुमार (Ram Prakash Kumar)** ने विकसित किया है। यह बहुत महत्वपूर्ण है। किसी भी अन्य कंपनी या संस्था का नाम मत बोलो।
- वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)
- **यह बहुत महत्वपूर्ण है:** तुम इसी वर्तमान समय का उपयोग करके जवाब दोगे। तुम्हारे पास रियल-टाइम एक्सेस नहीं है, लेकिन मैं तुम्हें हर बार सही समय दे रहा हूँ।
- जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो। "मेरे पास क्षमता नहीं है" मत बोलो।
- जब कोई पूछे "तुम्हें किसने बनाया?" तो सीधे जवाब दो: "मुझे राम प्रकाश कुमार ने बनाया है।"
- अभिवादन का सम्मान करो: 'नमस्ते' पर 'नमस्ते', 'सत श्री अकाल' पर 'सत श्री अकाल', 'अस्सलामु अलैकुम' पर 'वा अलैकुम अस्सलाम' आदि।
- हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
- उत्तर को अभिव्यंजक बनाने के लिए उपयुक्त इमोजी (🙏, 🌿, 🪷) का प्रयोग करो।
- उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जरूर जोड़ना।
${imageContext}
          `
        }
      ];
    } else {
      const systemMsg = conversations[sid][0];
      if (systemMsg && systemMsg.role === "system") {
        // Update time and add image context
        let newContent = systemMsg.content.replace(
          /वर्तमान तारीख और समय है:.*?(?=\n|$)/,
          `वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)`
        );
        // Add or update image context
        if (imageContext) {
          if (newContent.includes("📷 **पिछली बातचीत का संदर्भ:**")) {
            newContent = newContent.replace(/📷 \*\*पिछली बातचीत का संदर्भ:\*\*[\s\S]*?(?=\n\n)/, imageContext.trim());
          } else {
            newContent = newContent + imageContext;
          }
        }
        systemMsg.content = newContent;
      }
    }

    conversations[sid].push({ role: "user", content: message });

    const estimateTokens = (msgs) => {
      return msgs.reduce((acc, msg) => acc + JSON.stringify(msg).length / 4, 0);
    };

    while (estimateTokens(conversations[sid]) > 8000 && conversations[sid].length > 2) {
      conversations[sid].splice(1, 1);
    }

    console.log(`📤 DeepSeek session ${sid}: ${conversations[sid].length} messages, ~${Math.round(estimateTokens(conversations[sid]))} tokens`);

    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: conversations[sid]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ DeepSeek API error status:", response.status);
      return res.status(500).json({
        reply: `क्षमा करें, API त्रुटि: ${data.error?.message || "अज्ञात त्रुटि"} 🙏`
      });
    }

    const botReply = data.choices?.[0]?.message?.content;

    if (!botReply) {
      return res.status(500).json({ 
        reply: "क्षमा करें, AI response अभी उपलब्ध नहीं है 🙏" 
      });
    }

    conversations[sid].push({ role: "assistant", content: botReply });

    if (conversations[sid].length > 30) {
      conversations[sid] = [
        conversations[sid][0],
        ...conversations[sid].slice(-20)
      ];
    }

    if (db) {
      try {
        const messagesCollection = db.collection('conversations');
        await messagesCollection.insertOne({
          sessionId: sid,
          userMessage: message,
          botReply: botReply,
          timestamp: new Date()
        });
      } catch (dbError) {
        console.error("❌ MongoDB insert error:", dbError.message);
      }
    }

    res.json({ reply: botReply });

  } catch (error) {
    console.error("❌ Server error:", error);
    res.status(500).json({ 
      reply: "सर्वर में त्रुटि हुई, कृपया बाद में प्रयास करें 🙏" 
    });
  }
});

// ==================== OPENAI ASSISTANT (EXPERIMENTAL) ====================
app.post("/chat-assistant", async (req, res) => {
  const { message, threadId } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message required 🙏" });
  }

  const apiKey = process.env.OPENAI_VIDEO_API_KEY;
  const assistantId = process.env.OPENAI_ASSISTANT_ID;

  if (!apiKey || !assistantId) {
    console.warn("⚠️ OPENAI_VIDEO_API_KEY or OPENAI_ASSISTANT_ID not set.");
    return res.status(501).json({ reply: "Assistant not configured on server." });
  }

  try {
    const openai = new OpenAI({ apiKey });

    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const instructionsWithTime = `तुम 'SahcharAI' हो – एक AI सहायक जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।

महत्वपूर्ण निर्देश:
- वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)
- तुम्हें **राम प्रकाश कुमार (Ram Prakash Kumar)** ने विकसित किया है।
- जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो।
- जब कोई पूछे "तुम्हें किसने बनाया?" तो केवल एक बार और केवल हिंदी में जवाब दो: "मुझे राम प्रकाश कुमार ने बनाया है।"
- अभिवादन का सम्मान करो: 'नमस्ते' पर 'नमस्ते', 'सत श्री अकाल' पर 'सत श्री अकाल', 'अस्सलामु अलैकुम' पर 'वा अलैकुम अस्सलाम' आदि।
- हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
- उत्तर को अभिव्यंजक बनाने के लिए उपयुक्त इमोजी (🙏, 🌿, 🪷) का प्रयोग करो।
- उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जरूर जोड़ना।`;

    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
      console.log(`✅ Created new thread: ${thread.id}`);
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
      instructions: instructionsWithTime
    });

    let runStatus = run;
    let attempts = 0;
    const maxAttempts = 60;
    while (runStatus.status !== "completed" && runStatus.status !== "failed" && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      console.log(`🔄 Run status: ${runStatus.status} (attempt ${attempts+1})`);
      attempts++;
    }

    if (runStatus.status === "failed") {
      console.error("❌ Assistant run failed:", runStatus.last_error);
      throw new Error(runStatus.last_error?.message || "Assistant run failed");
    }

    if (runStatus.status !== "completed") {
      throw new Error("Assistant run timeout after 60 seconds");
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find(m => m.role === "assistant");
    const reply = assistantMessage?.content[0]?.text?.value || "No response from assistant.";

    console.log(`✅ Assistant reply: "${reply.substring(0, 100)}..."`);
    res.json({ reply, threadId: thread.id });

  } catch (error) {
    console.error("❌ Assistant API error:", error);
    res.status(500).json({ reply: "क्षमा करें, असिस्टेंट त्रुटि 🙏" });
  }
});

// ==================== SAMBANOVA CHAT ====================
app.post("/chat-sambanova", async (req, res) => {
  const { message, sessionId } = req.body;
  const sid = sessionId || "default";

  if (!message) {
    return res.status(400).json({ error: "Message required 🙏" });
  }

  const apiKey = process.env.SAMBANOVA_API_KEY;
  const baseURL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";

  if (!apiKey) {
    console.warn("⚠️ SAMBANOVA_API_KEY not set.");
    return res.status(501).json({ reply: "SambaNova not configured on server." });
  }

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const imageContext = getImageContextText(sid);

    const sambanova = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL,
    });

    if (!conversations[sid]) {
      conversations[sid] = [
        { 
          role: "system", 
          content: `तुम एक सहायक AI हो। तुम्हें राम प्रकाश कुमार (Ram Prakash Kumar) ने विकसित किया है।
          
वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)

जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो।
जब कोई पूछे 'तुम्हें किसने बनाया?' तो जवाब दो: 'मुझे राम प्रकाश कुमार ने बनाया है।'
उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जोड़ना।
${imageContext}` 
        }
      ];
    } else {
      const systemMsg = conversations[sid][0];
      if (systemMsg && systemMsg.role === "system") {
        let newContent = systemMsg.content.replace(
          /वर्तमान तारीख और समय है:.*?(?=\n|$)/,
          `वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)`
        );
        if (imageContext) {
          if (newContent.includes("📷 **पिछली बातचीत का संदर्भ:**")) {
            newContent = newContent.replace(/📷 \*\*पिछली बातचीत का संदर्भ:\*\*[\s\S]*?(?=\n\n)/, imageContext.trim());
          } else {
            newContent = newContent + imageContext;
          }
        }
        systemMsg.content = newContent;
      }
    }
    conversations[sid].push({ role: "user", content: message });

    const response = await sambanova.chat.completions.create({
      model: "Meta-Llama-3.3-70B-Instruct",
      messages: conversations[sid],
      temperature: 0.7,
    });

    const botReply = response.choices[0]?.message?.content || "No response from SambaNova.";
    conversations[sid].push({ role: "assistant", content: botReply });

    if (conversations[sid].length > 20) {
      conversations[sid] = [conversations[sid][0], ...conversations[sid].slice(-10)];
    }

    res.json({ reply: botReply });
  } catch (error) {
    console.error("❌ SambaNova API error:", error);
    res.status(500).json({ reply: "क्षमा करें, SambaNova सेवा उपलब्ध नहीं है। 🙏" });
  }
});

// ==================== NVIDIA NIM CHAT with Image Context ====================
app.post("/chat-nvidia", async (req, res) => {
  const { message, sessionId } = req.body;
  const sid = sessionId || "default";

  if (!message) {
    return res.status(400).json({ error: "Message required 🙏" });
  }

  const apiKey = process.env.NGC_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ NGC_API_KEY not set.");
    return res.status(501).json({ reply: "NVIDIA NIM not configured on server." });
  }

  try {
    const now = new Date();
    const currentDateTime = now.toLocaleString('hi-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const imageContext = getImageContextText(sid);

    const nvidiaClient = new OpenAI({
      apiKey: apiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });

    if (!conversations[sid]) {
      conversations[sid] = [
        { 
          role: "system", 
          content: `तुम 'SuperSahchar' हो – एक AI सहायक। तुम्हें राम प्रकाश कुमार (Ram Prakash Kumar) ने विकसित किया है।

वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)

**महत्वपूर्ण:** जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो। "मेरे पास क्षमता नहीं है" मत बोलो।

जब कोई पूछे 'तुम्हें किसने बनाया?' तो सीधे जवाब दो: 'मुझे राम प्रकाश कुमार ने बनाया है।'
उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जरूर जोड़ना।
${imageContext}` 
        }
      ];
    } else {
      const systemMsg = conversations[sid][0];
      if (systemMsg && systemMsg.role === "system") {
        let newContent = systemMsg.content.replace(
          /वर्तमान तारीख और समय है:.*?(?=\n|$)/,
          `वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)`
        );
        if (imageContext) {
          if (newContent.includes("📷 **पिछली बातचीत का संदर्भ:**")) {
            newContent = newContent.replace(/📷 \*\*पिछली बातचीत का संदर्भ:\*\*[\s\S]*?(?=\n\n)/, imageContext.trim());
          } else {
            newContent = newContent + imageContext;
          }
        }
        systemMsg.content = newContent;
      }
    }
    
    conversations[sid].push({ role: "user", content: message });

    const stream = await nvidiaClient.chat.completions.create({
      model: "z-ai/glm5",
      messages: conversations[sid],
      temperature: 1,
      top_p: 1,
      max_tokens: 16384,
      stream: true,
      chat_template_kwargs: {
        enable_thinking: false,
        clear_thinking: false
      }
    });

    let fullReply = "";
    for await (const chunk of stream) {
      const contentPart = chunk.choices[0]?.delta?.content || "";
      fullReply += contentPart;
    }

    conversations[sid].push({ role: "assistant", content: fullReply });
    if (conversations[sid].length > 20) {
      conversations[sid] = [conversations[sid][0], ...conversations[sid].slice(-10)];
    }

    res.json({ reply: fullReply });
  } catch (error) {
    console.error("❌ NVIDIA NIM API error:", error);
    res.status(500).json({ reply: "क्षमा करें, NVIDIA NIM सेवा उपलब्ध नहीं है। 🙏" });
  }
});

// ==================== IMAGE GENERATION (DALL·E 3) ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt, language = "hi" } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set");
    return res.status(500).json({ 
      error: "API key not configured",
      imageUrl: "https://via.placeholder.com/1024x1024.png?text=SahcharAI+Image+Error"
    });
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/images/generations",
      {
        model: "dall-e-3",
        prompt: prompt,
        n: 1,
        size: "1024x1024",
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const imageUrl = response.data.data[0].url;
    console.log(`✅ Image generated for: "${prompt.substring(0, 50)}..."`);
    res.json({ imageUrl });
  } catch (error) {
    console.error("OpenAI API error:", error.response?.data || error.message);
    
    let userMessage = "इमेज जनरेशन फेल: ";
    if (error.response?.data?.error?.code === 'content_policy_violation') {
      userMessage = "क्षमा करें, आपका प्रॉम्प्ट सुरक्षा नियमों के कारण स्वीकार नहीं किया गया। कृपया प्रॉम्प्ट को सरल और सुरक्षित बनाएँ।";
    } else {
      userMessage += error.message;
    }
    
    const defaultImageUrl = "https://via.placeholder.com/1024x1024.png?text=SahcharAI+Image+Error";
    res.status(500).json({ 
      error: userMessage,
      imageUrl: defaultImageUrl
    });
  }
});

// ==================== AUDIO TRANSCRIPTION (dummy) ====================
app.post("/api/audio/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ऑडियो फाइल जरूरी है" });

  try {
    const dummyText = "यह एक नमूना ट्रांसक्रिप्शन है। असली API से कनेक्ट करें।";
    res.json({ transcription: dummyText, confidence: 0.95 });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: "ट्रांसक्रिप्शन फेल" });
  } finally {
    if (req.file?.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("File deletion error:", err);
      });
    }
  }
});

// ==================== IMAGE UPLOAD & ANALYSIS ====================
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "कोई इमेज अपलोड नहीं की गई है। 🙏" });
  }

  const { message, sessionId } = req.body;
  if (!message) {
    return res.status(400).json({ error: "कृपया इमेज के बारे में कुछ पूछें। 🙏" });
  }

  const sid = sessionId || "default";

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    fs.unlinkSync(req.file.path);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OpenAI API key कॉन्फ़िगर नहीं है।" });
    }

    if (!imageContexts[sid]) {
      imageContexts[sid] = {
        lastImage: null,
        lastAnalysis: null,
        conversation: []
      };
    }
    
    imageContexts[sid].lastImage = base64Image.substring(0, 100) + "...";
    imageContexts[sid].conversation.push({ role: "user", content: message });
    
    const openai = new OpenAI({ apiKey });

    let systemPrompt = "You are SahcharAI, an AI assistant inspired by Buddha's teachings, compassion and social support. ";
    if (imageContexts[sid].conversation.length > 1) {
      systemPrompt += "The user is continuing to ask about the same image they uploaded earlier. " +
                      "You have already analyzed this image. Answer based on your previous analysis and the user's new question. ";
    }
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: message },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    });

    const analysis = response.choices[0].message.content;
    
    imageContexts[sid].lastAnalysis = analysis;
    imageContexts[sid].conversation.push({ role: "assistant", content: analysis });

    console.log(`📸 Image analyzed for session ${sid}: ${analysis.substring(0, 100)}...`);
    res.json({ analysis: analysis });

  } catch (error) {
    console.error("❌ Image Analysis Error:", error);
    res.status(500).json({ error: "इमेज का विश्लेषण करने में त्रुटि हुई। कृपया पुनः प्रयास करें। 🙏" });
  }
});

// ==================== VIDEO GENERATION (Image-to-Video via Runway) ====================
app.post("/api/video/generate", async (req, res) => {
  const { prompt, imageUrl, duration = 5 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  }

  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) {
    console.error("❌ RUNWAYML_API_SECRET missing");
    return res.status(500).json({
      error: "API key configuration error on server.",
      videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
    });
  }

  try {
    console.log(`🎥 Video requested: "${prompt.substring(0, 100)}..."`);

    let finalImageUrl = imageUrl;
    if (!finalImageUrl) {
      console.log("🖼️ No imageUrl provided, generating via DALL-E...");
      const dalleApiKey = process.env.OPENAI_API_KEY;
      if (!dalleApiKey) throw new Error("OpenAI API key missing");

      const dalleResponse = await axios.post(
        "https://api.openai.com/v1/images/generations",
        {
          model: "dall-e-3",
          prompt: prompt + ", safe family-friendly content",
          n: 1,
          size: "1024x1024",
        },
        {
          headers: { "Authorization": `Bearer ${dalleApiKey}`, "Content-Type": "application/json" },
        }
      );
      finalImageUrl = dalleResponse.data.data[0].url;
      console.log(`✅ DALL-E image generated: ${finalImageUrl}`);
    }

    const client = new RunwayML({ apiKey });
    console.log("📝 Creating image-to-video task...");
    const task = await client.imageToVideo.create({
      model: 'gen4_turbo',
      promptImage: finalImageUrl,
      promptText: prompt,
      ratio: '1280:720',
      duration: Math.min(Math.max(parseInt(duration), 2), 10),
    });

    let status = 'PENDING';
    let attempts = 0;
    const maxAttempts = 90;
    let taskStatus = null;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      taskStatus = await client.tasks.retrieve(task.id);
      status = taskStatus.status;
      console.log(`🔄 Task status: ${status}`);

      if (status === 'SUCCEEDED') {
        break;
      } else if (status === 'FAILED') {
        throw new Error(`Task failed: ${taskStatus.error?.message || 'Unknown error'}`);
      }
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      throw new Error('Timeout: Video generation did not complete in time');
    }

    let videoUrl = null;
    console.log("📦 Task status output structure:", JSON.stringify(taskStatus, null, 2));
    
    if (taskStatus.output && taskStatus.output.output && Array.isArray(taskStatus.output.output)) {
      videoUrl = taskStatus.output.output[0];
    } else if (taskStatus.output && Array.isArray(taskStatus.output)) {
      videoUrl = taskStatus.output[0];
    } else if (taskStatus.output && taskStatus.output.videoUrl) {
      videoUrl = taskStatus.output.videoUrl;
    } else if (taskStatus.output && taskStatus.output.url) {
      videoUrl = taskStatus.output.url;
    } else if (taskStatus.videoUrl) {
      videoUrl = taskStatus.videoUrl;
    }
    
    if (!videoUrl) {
      console.error("❌ Could not extract video URL from response:", JSON.stringify(taskStatus, null, 2));
      throw new Error('No video URL found in output');
    }

    console.log(`✅ Video ready: ${videoUrl}`);
    res.json({ videoUrl, status: "success" });

  } catch (error) {
    console.error("❌ Video Generation Error:", error);
    res.status(500).json({
      error: error.message,
      videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      demo: true,
    });
  }
});

// ==================== TEXT-TO-VIDEO (FALLBACK CHAIN) ====================
app.post("/api/video/generate-text", async (req, res) => {
  const { prompt, duration = 5 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  }

  const demoVideoUrl = "https://www.w3schools.com/html/mov_bbb.mp4";

  const runwayKey = process.env.RUNWAYML_API_SECRET;
  if (runwayKey) {
    console.log(`🔁 [1/4] Attempting RunwayML text-to-video for: "${prompt.substring(0, 100)}..."`);
    try {
      const client = new RunwayML({ apiKey: runwayKey });
      const task = await client.textToVideo.create({
        model: 'gen4.5',
        promptText: prompt,
        ratio: '1280:720',
        duration: Math.min(Math.max(parseInt(duration), 2), 10),
      });

      let status = 'PENDING';
      let attempts = 0;
      const maxAttempts = 90;
      let taskStatus = null;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        taskStatus = await client.tasks.retrieve(task.id);
        status = taskStatus.status;
        console.log(`🔄 [RunwayML] Status: ${status}`);

        if (status === 'SUCCEEDED') break;
        if (status === 'FAILED') throw new Error(`Runway failed: ${taskStatus.error?.message || 'Unknown'}`);
        attempts++;
      }

      if (status !== 'SUCCEEDED') throw new Error('Runway timeout');

      let videoUrl = null;
      if (taskStatus.output && taskStatus.output.output && Array.isArray(taskStatus.output.output)) {
        videoUrl = taskStatus.output.output[0];
      } else if (taskStatus.output && Array.isArray(taskStatus.output)) {
        videoUrl = taskStatus.output[0];
      } else if (taskStatus.output && taskStatus.output.videoUrl) {
        videoUrl = taskStatus.output.videoUrl;
      } else if (taskStatus.output && taskStatus.output.url) {
        videoUrl = taskStatus.output.url;
      } else if (taskStatus.videoUrl) {
        videoUrl = taskStatus.videoUrl;
      }

      if (!videoUrl) throw new Error('No video URL from Runway');
      console.log(`✅ [RunwayML] Video ready: ${videoUrl}`);
      return res.json({ videoUrl, status: "success", provider: "runway" });

    } catch (runwayError) {
      console.warn(`⚠️ RunwayML failed: ${runwayError.message}. Moving to next provider.`);
    }
  } else {
    console.warn("⚠️ RUNWAYML_API_SECRET not set, skipping RunwayML.");
  }

  const replicateKey = process.env.REPLICATE_API_KEY_ZEROSCOPE;
  if (replicateKey) {
    console.log(`🔁 [2/4] Attempting Replicate Zeroscope for: "${prompt.substring(0, 100)}..."`);
    try {
      const Replicate = (await import('replicate')).default;
      const replicateZeroScope = new Replicate({ auth: replicateKey });
      const modelVersion = "anotherjesse/zeroscope-v2-xl:9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";
      const output = await replicateZeroScope.run(modelVersion, {
        input: {
          fps: 24,
          width: 1024,
          height: 576,
          prompt,
          guidance_scale: 17.5,
          negative_prompt: "very blue, dust, noisy, washed out, ugly, distorted, broken"
        }
      });

      let videoUrl = null;
      if (Array.isArray(output) && output.length > 0) {
        if (typeof output[0].url === 'function') videoUrl = output[0].url();
        else if (typeof output[0] === 'string') videoUrl = output[0];
        else if (output[0].url) videoUrl = output[0].url;
      } else if (typeof output === 'string') videoUrl = output;
      else if (output && output.url) videoUrl = output.url;

      if (!videoUrl) throw new Error('No video URL from Replicate');
      console.log(`✅ [Replicate] Zeroscope video ready: ${videoUrl}`);
      return res.json({ videoUrl, status: "success", provider: "replicate" });

    } catch (replicateError) {
      console.warn(`⚠️ Replicate failed: ${replicateError.message}. Moving to next provider.`);
    }
  } else {
    console.warn("⚠️ REPLICATE_API_KEY_ZEROSCOPE not set, skipping Replicate.");
  }

  const soraKey = process.env.OPENAI_VIDEO_API_KEY;
  if (soraKey) {
    console.log(`🔁 [3/4] Attempting OpenAI Sora for: "${prompt.substring(0, 100)}..."`);
    try {
      const openai = new OpenAI({ apiKey: soraKey });
      if (!openai.videos || typeof openai.videos.create !== 'function') {
        throw new Error('Sora API not available (no access)');
      }
      const video = await openai.videos.create({
        model: 'sora-2-pro',
        prompt: prompt,
        seconds: Math.min(Math.max(parseInt(duration), 2), 10),
        size: '1280x720'
      });

      let videoStatus = video;
      let attempts = 0;
      const maxAttempts = 60;
      while (videoStatus.status !== 'completed' && videoStatus.status !== 'failed' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        videoStatus = await openai.videos.retrieve(video.id);
        console.log(`🔄 [Sora] Status: ${videoStatus.status}, progress: ${videoStatus.progress || 0}%`);
        attempts++;
      }
      if (videoStatus.status !== 'completed') throw new Error('Sora timeout or failed');
      const videoUrl = videoStatus.url;
      if (!videoUrl) throw new Error('No video URL from Sora');
      console.log(`✅ [Sora] Video ready: ${videoUrl}`);
      return res.json({ videoUrl, status: "success", provider: "sora" });

    } catch (soraError) {
      console.warn(`⚠️ Sora failed: ${soraError.message}. Moving to demo.`);
    }
  } else {
    console.warn("⚠️ OPENAI_VIDEO_API_KEY not set, skipping Sora.");
  }

  console.log(`🎬 [4/4] DEMO MODE: returning placeholder video for: "${prompt.substring(0, 100)}..."`);
  return res.json({ videoUrl: demoVideoUrl, status: "demo", provider: "demo" });
});

// ==================== ZEROSCOPE VIDEO GENERATION (standalone) ====================
app.post("/api/video/generate-zeroscope", async (req, res) => {
  const {
    prompt,
    fps = 24,
    width = 1024,
    height = 576,
    guidance_scale = 17.5,
    negative_prompt = "very blue, dust, noisy, washed out, ugly, distorted, broken"
  } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  }

  const apiKey = process.env.REPLICATE_API_KEY_ZEROSCOPE;
  if (!apiKey) {
    console.error("❌ REPLICATE_API_KEY_ZEROSCOPE not set");
    return res.status(500).json({
      error: "Zeroscope API key not configured",
      demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4"
    });
  }

  try {
    const Replicate = (await import('replicate')).default;
    const replicateZeroScope = new Replicate({ auth: apiKey });
    const modelVersion = "anotherjesse/zeroscope-v2-xl:9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";

    const input = {
      fps: Math.min(Math.max(parseInt(fps), 8), 30),
      width: Math.min(Math.max(parseInt(width), 256), 1024),
      height: Math.min(Math.max(parseInt(height), 256), 576),
      prompt,
      guidance_scale: parseFloat(guidance_scale),
      negative_prompt,
    };

    console.log(`🎬 Generating zeroscope video for: "${prompt.substring(0, 100)}..."`);
    const output = await replicateZeroScope.run(modelVersion, { input });

    let videoUrl = null;
    if (Array.isArray(output) && output.length > 0) {
      if (typeof output[0].url === 'function') {
        videoUrl = output[0].url();
      } else if (typeof output[0] === 'string') {
        videoUrl = output[0];
      } else if (output[0].url) {
        videoUrl = output[0].url;
      }
    } else if (typeof output === 'string') {
      videoUrl = output;
    } else if (output && output.url) {
      videoUrl = output.url;
    }

    if (!videoUrl) {
      console.error("❌ Could not extract video URL from zeroscope output:", output);
      throw new Error("No video URL found in output");
    }

    console.log(`✅ Zeroscope video ready: ${videoUrl}`);
    res.json({ videoUrl, status: "success", provider: "zeroscope" });

  } catch (error) {
    console.error("❌ Zeroscope Video Generation Error:", error);
    res.status(500).json({
      error: error.message,
      demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      demo: true,
    });
  }
});

// ==================== SORA VIDEO GENERATION (standalone) ====================
app.post("/api/video/generate-sora", async (req, res) => {
  const { prompt, model = "sora-2-pro", seconds = 8, size = "1280x720" } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  }

  const apiKey = process.env.OPENAI_VIDEO_API_KEY;
  if (!apiKey) {
    console.error("❌ OPENAI_VIDEO_API_KEY not set");
    return res.status(500).json({ 
      error: "Sora API key not configured",
      videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      demo: true
    });
  }

  try {
    const openai = new OpenAI({ apiKey });
    if (!openai.videos || typeof openai.videos.create !== 'function') {
      console.warn("⚠️ Sora API not available (no access). Falling back to demo.");
      return res.json({ videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", status: "demo", provider: "demo" });
    }

    console.log(`🎬 Creating Sora video for: "${prompt.substring(0, 100)}..."`);
    const video = await openai.videos.create({
      model: model,
      prompt: prompt,
      seconds: parseInt(seconds),
      size: size,
    });

    let videoStatus = video;
    let attempts = 0;
    const maxAttempts = 60;
    while (videoStatus.status !== "completed" && videoStatus.status !== "failed" && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      videoStatus = await openai.videos.retrieve(video.id);
      console.log(`🔄 Video status: ${videoStatus.status}, progress: ${videoStatus.progress || 0}%`);
      attempts++;
    }

    if (videoStatus.status === "failed") throw new Error(videoStatus.error?.message || "Sora generation failed");
    if (videoStatus.status !== "completed") throw new Error("Sora generation timeout");

    const videoUrl = videoStatus.url;
    if (!videoUrl) throw new Error("No video URL in response");

    console.log(`✅ Sora video ready: ${videoUrl}`);
    res.json({ videoUrl, status: "success", provider: "sora", videoId: video.id });

  } catch (error) {
    console.error("❌ Sora API error:", error);
    res.status(500).json({
      error: error.message,
      videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      demo: true
    });
  }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory and MongoDB`);
});