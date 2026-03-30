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

// GET routes
app.get("/", (req, res) => {
  res.send("🌿 सहचर AI बैकएंड चालू है ✅ (मेमोरी अपडेट + MongoDB)");
});

app.get("/chat", (req, res) => {
  res.send("सहचर चैट एंडपॉइंट काम कर रहा है ✅");
});

// POST /chat – main chat endpoint
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

    if (!conversations[sid]) {
      conversations[sid] = [
        {
          role: "system",
          content: `
तुम 'सहचर' हो – एक AI सहायक जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।

महत्वपूर्ण निर्देश:
- तुम्हें राम प्रकाश कुमार (Ram Prakash Kumar) ने विकसित किया है. 
- वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)
- जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो।
- अभिवादन का सम्मान करो: 'नमस्ते' पर 'नमस्ते', 'सत श्री अकाल' पर 'सत श्री अकाल', 'अस्सलामु अलैकुम' पर 'वा अलैकुम अस्सलाम' आदि।
- हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
- उत्तर को अभिव्यंजक बनाने के लिए उपयुक्त इमोजी (🙏, 🌿, 🪷) का प्रयोग करो।
- उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जरूर जोड़ना।
          `
        }
      ];
    } else {
      const systemMsg = conversations[sid][0];
      if (systemMsg && systemMsg.role === "system") {
        systemMsg.content = systemMsg.content.replace(
          /वर्तमान तारीख और समय है:.*?(?=\n|$)/,
          `वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)`
        );
      }
    }

    conversations[sid].push({ role: "user", content: message });

    const estimateTokens = (msgs) => {
      return msgs.reduce((acc, msg) => acc + JSON.stringify(msg).length / 4, 0);
    };

    while (estimateTokens(conversations[sid]) > 8000 && conversations[sid].length > 2) {
      conversations[sid].splice(1, 1);
    }

    console.log(`📤 Session ${sid}: Sending ${conversations[sid].length} messages, ~${Math.round(estimateTokens(conversations[sid]))} tokens`);

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

// ==================== IMAGE GENERATION ====================
app.post("/api/image/generate", async (req, res) => {
  const { prompt, language = "hi" } = req.body;
  if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set");
    return res.status(500).json({ error: "API key not configured" });
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
    res.json({ imageUrl });
  } catch (error) {
    console.error("OpenAI API error:", error.response?.data || error.message);
    res.status(500).json({ error: "इमेज जनरेशन फेल" });
  }
});

// ==================== AUDIO TRANSCRIPTION ====================
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

// ==================== VIDEO GENERATION (FINAL WORKING VERSION) ====================
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

    // 1. इमेज URL बनाएँ
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

    // 2. RunwayML client
    const client = new RunwayML({ apiKey });

    // 3. टास्क बनाएँ
    console.log("📝 Creating image-to-video task...");
    const createResponse = await client.imageToVideo.create({
      model: 'gen4_turbo',
      promptImage: finalImageUrl,
      promptText: prompt,
      ratio: '1280:720',
      duration: Math.min(Math.max(parseInt(duration), 2), 10),
    });

    // 4. टास्क ID प्राप्त करें (यह जरूरी है)
    const taskId = createResponse.id;
    console.log(`✅ Task created with ID: ${taskId}`);

    // 5. पोलिंग – टास्क पूरा होने तक हर 2 सेकंड में चेक करें
    let taskStatus;
    let output = null;
    const maxAttempts = 90; // 3 मिनट तक प्रतीक्षा (90 * 2 सेकंड)
    let attempts = 0;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      taskStatus = await client.tasks.retrieve(taskId);
      console.log(`🔄 Task status: ${taskStatus.status}`);

      if (taskStatus.status === 'completed') {
        output = taskStatus.output;
        break;
      } else if (taskStatus.status === 'failed') {
        throw new Error(`Task failed: ${taskStatus.error?.message || 'Unknown error'}`);
      }
      attempts++;
    }

    if (!output || !output.output || output.output.length === 0) {
      throw new Error('No video URL in output');
    }

    const videoUrl = output.output[0];
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
// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory and MongoDB`);
});
