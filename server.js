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

// MONGODB_URI की उपस्थिति की जाँच करें और चेतावनी दें
if (!process.env.MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI environment variable is not set. Database features will be disabled.");
}

const app = express();

// Multer configuration for file uploads
const upload = multer({ dest: 'uploads/' });

// 🔥 लंबे संदेशों के लिए JSON लिमिट बढ़ाई
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ✅ JSON पार्सिंग एरर हैंडलिंग मिडलवेयर
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Invalid JSON received:', err.message);
    return res.status(400).json({ 
      reply: "क्षमा करें, मैसेज का फॉर्मेट सही नहीं है। कृपया किसी भी प्रकार के स्पेशल कैरेक्टर (जैसे कि कोट्स, बैकस्लैश) को हटाकर दोबारा भेजें। 🙏" 
    });
  }
  next(err);
});

// 📦 MongoDB कनेक्शन सेटअप (अब सुरक्षित तरीके से)
let mongoClient;
let db = null;

if (process.env.MONGODB_URI) {
  mongoClient = new MongoClient(process.env.MONGODB_URI);

  async function connectToMongoDB() {
    try {
      await mongoClient.connect();
      console.log("✅ Connected to MongoDB");
      db = mongoClient.db(); // डिफ़ॉल्ट डेटाबेस का उपयोग
      // यदि कोई विशेष डेटाबेस नाम देना चाहते हैं, तो:
      // db = mongoClient.db('sahchar_db');
    } catch (error) {
      console.error("❌ MongoDB connection error:", error.message);
      db = null; // कनेक्ट न होने पर db को null कर दें
    }
  }

  connectToMongoDB(); // कनेक्शन शुरू करें
} else {
  console.warn("⚠️ MongoDB client not initialized because MONGODB_URI is missing.");
}

// ग्लोबल एरर हैंडलर (किसी भी अनहैंडल्ड एरर को पकड़ने के लिए)
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// 📦 इन-मेमोरी कन्वर्सेशन स्टोरेज (फॉलबैक के लिए)
const conversations = {};

// ✅ GET route – सर्वर चेक
app.get("/", (req, res) => {
  res.send("🌿 सहचर AI बैकएंड चालू है ✅ (मेमोरी अपडेट + MongoDB)");
});

app.get("/chat", (req, res) => {
  res.send("सहचर चैट एंडपॉइंट काम कर रहा है ✅");
});

// ✅ POST route – मेमोरी के साथ चैट
app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  const sid = sessionId || "default";

  if (!message) {
    return res.status(400).json({ reply: "Message required 🙏" });
  }

  try {
    // 🔥 हर बार fresh current date & time calculate करें (IST timezone)
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

    // सेशन की शुरुआत में system prompt सेट करें
    if (!conversations[sid]) {
      conversations[sid] = [
        {
          role: "system",
          content: `
तुम 'सहचर' हो – एक AI सहायक जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।

महत्वपूर्ण निर्देश:
- तुम्हें राम प्रकाश कुमार (Ram Prakash Kumar) ने विकसित किया है। 
- वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)
- जब भी कोई तारीख, समय, आज, कल, परसों, अभी क्या समय है आदि पूछे, तो बिल्कुल इसी वर्तमान समय का इस्तेमाल करके सही जवाब दो।
- अभिवादन का सम्मान करो: 'नमस्ते' पर 'नमस्ते', 'सत श्री अकाल' पर 'सत श्री अकाल', 'अस्सलामु अलैकुम' पर 'वा अलैकुम अस्सलाम' आदि।
- हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
- उत्तर को अभिव्यंजक बनाने के लिए उपयुक्त इमोजी (🙏, 🌿, 🪷) का प्रयोग करो।
- उत्तर के अंत में 'जय भीम, नमो बुद्धाय 🙏' जरूर जोड़ना।
          `
        }
      ];
    } 
    // अगर session पहले से मौजूद है, तो system prompt में तारीख अपडेट करें
    else {
      const systemMsg = conversations[sid][0];
      if (systemMsg && systemMsg.role === "system") {
        // पुरानी तारीख को नई तारीख से replace करें (सुरक्षित तरीका)
        systemMsg.content = systemMsg.content.replace(
          /वर्तमान तारीख और समय है:.*?(?=\n|$)/,
          `वर्तमान तारीख और समय है: ${currentDateTime} (भारतीय समय - IST)`
        );
      }
    }

    // यूजर का संदेश हिस्ट्री में जोड़ें
    conversations[sid].push({ role: "user", content: message });

    // टोकन अनुमान और trimming (आपका पुराना कोड)
    const estimateTokens = (msgs) => {
      return msgs.reduce((acc, msg) => acc + JSON.stringify(msg).length / 4, 0);
    };

    while (estimateTokens(conversations[sid]) > 8000 && conversations[sid].length > 2) {
      conversations[sid].splice(1, 1);
    }

    console.log(`📤 Session ${sid}: Sending \( {conversations[sid].length} messages, \~ \){Math.round(estimateTokens(conversations[sid]))} tokens`);

    // DeepSeek API कॉल (आपका बाकी कोड वैसा ही)
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

    // MongoDB save (आपका पुराना कोड)
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
});// ==================== NEW FEATURES ====================

// Image generation (OpenAI DALL·E)
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

// Audio transcription endpoint (file upload)
app.post("/api/audio/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ऑडियो फाइल जरूरी है" });

  try {
    // Replace with actual transcription API (Google Cloud Speech, AssemblyAI)
    const dummyText = "यह एक नमूना ट्रांसक्रिप्शन है। असली API से कनेक्ट करें।";
    res.json({ transcription: dummyText, confidence: 0.95 });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: "ट्रांसक्रिप्शन फेल" });
  } finally {
    // Clean up uploaded file
    if (req.file?.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("File deletion error:", err);
      });
    }
  }
});

// ==================== VIDEO GENERATION (2026 Fixed Version) ====================

app.post("/api/video/generate", async (req, res) => {
  const { prompt, duration = 5, language = "hi" } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
  }

  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) {
    console.error("❌ RUNWAY_API_KEY missing");
    return res.status(500).json({ error: "Video generation API key कॉन्फ़िगर नहीं है" });
  }

  try {
    console.log(`🎥 Video requested: "${prompt.substring(0, 80)}..." | Duration: ${duration}s`);

    // 🔥 2026 का सही endpoint (text-to-video भी यहीं से काम करता है)
    const response = await axios.post(
      "https://api.runwayml.com/v1/image_to_video",
      {
        model: "gen4.5",                    // या "gen4_turbo" (फास्टर)
        promptText: prompt,
        duration: Math.min(Math.max(parseInt(duration), 4), 10),
        ratio: "1280:720",                  // 16:9
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 180000, // 3 मिनट
      }
    );

    const taskId = response.data.id;   // ← अब यही सही है

    if (!taskId) {
      throw new Error("Task ID नहीं मिला");
    }

    // Polling
    let videoUrl = null;
    let attempts = 0;
    const maxAttempts = 40;   // \~4-5 मिनट तक चेक

    while (!videoUrl && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 7000)); // 7 सेकंड wait

      const statusRes = await axios.get(`https://api.runwayml.com/v1/tasks/${taskId}`, {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });

      const task = statusRes.data;

      if (task.status === "SUCCEEDED" && task.output && task.output.length > 0) {
        videoUrl = task.output[0];
        break;
      } 
      else if (task.status === "FAILED") {
        throw new Error(task.error || "Runway task failed");
      }

      attempts++;
    }

    if (!videoUrl) {
      return res.status(408).json({ 
        error: "वीडियो जेनरेट होने में ज्यादा समय लग रहा है। बाद में ट्राई करें 🙏" 
      });
    }

    console.log(`✅ Video generated successfully: ${videoUrl}`);

    res.json({
      videoUrl: videoUrl,
      status: "success",
      message: "वीडियो सफलतापूर्वक जेनरेट हो गया है 🙏"
    });

  } catch (error) {
    console.error("❌ Video Generation Error:", error.response?.data || error.message);
    
    let errorMsg = "वीडियो जेनरेशन फेल हो गया। कृपया बाद में प्रयास करें 🙏";
    if (error.response?.status === 429) errorMsg = "Runway क्रेडिट खत्म हो गए हैं।";
    if (error.response?.status === 401) errorMsg = "Runway API Key अमान्य है।";

    res.status(500).json({ 
      error: errorMsg 
    });
  }
});// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory and MongoDB`);
});
