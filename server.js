import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from 'mongodb';

dotenv.config();

// MONGODB_URI की उपस्थिति की जाँच करें और चेतावनी दें
if (!process.env.MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI environment variable is not set. Database features will be disabled.");
}

const app = express();

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
    // सत्र के लिए हिस्ट्री प्राप्त करें या नई बनाएँ
    if (!conversations[sid]) {
      conversations[sid] = [
       {
  role: "system",
  content: `
  तुम 'सहचर' हो – एक AI जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।
  तुम्हें राम प्रकाश कुमार (Ram Prakash Kumar) ने विकसित किया है। यह ऐप **DeepSeek API** का उपयोग करता है।
  हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
  अंत में 'जय भीम, नमो बुद्धाय 🙏' जोड़ो।
  `
}
      ];
    }

    // यूजर का संदेश हिस्ट्री में जोड़ें
    conversations[sid].push({ role: "user", content: message });

    // 🔥 टोकन अनुमान फंक्शन (मोटा अनुमान)
    const estimateTokens = (msgs) => {
      return msgs.reduce((acc, msg) => acc + JSON.stringify(msg).length / 4, 0);
    };

    // 🔥 टोकन लिमिट बढ़ाकर 8000 करें (DeepSeek की संभावित लिमिट ज्यादा है)
    while (estimateTokens(conversations[sid]) > 8000 && conversations[sid].length > 2) {
      conversations[sid].splice(1, 1);
    }

    // 📤 लॉग: कितने संदेश और टोकन भेज रहे हैं
    console.log(`📤 Session ${sid}: Sending ${conversations[sid].length} messages, ~${Math.round(estimateTokens(conversations[sid]))} tokens`);

    // DeepSeek API कॉल
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
      console.error("❌ DeepSeek API error body:", JSON.stringify(data, null, 2));
      return res.status(500).json({
        reply: `क्षमा करें, API त्रुटि: ${data.error?.message || "अज्ञात त्रुटि"} 🙏`
      });
    }

    const botReply = data.choices?.[0]?.message?.content;

    if (!botReply) {
      console.error("❌ DeepSeek API response invalid:", JSON.stringify(data, null, 2));
      return res.status(500).json({ 
        reply: "क्षमा करें, AI response अभी उपलब्ध नहीं है 🙏" 
      });
    }

    // बॉट का जवाब हिस्ट्री में जोड़ें
    conversations[sid].push({ role: "assistant", content: botReply });

    // 🔥 हिस्ट्री को बहुत लंबा होने से रोकें
    if (conversations[sid].length > 30) {
      conversations[sid] = [
        conversations[sid][0],
        ...conversations[sid].slice(-20)
      ];
    }

    // 💾 बातचीत को MongoDB में सेव करें (यदि कनेक्शन हो)
    if (db) {
      try {
        const messagesCollection = db.collection('conversations');
        await messagesCollection.insertOne({
          sessionId: sid,
          userMessage: message,
          botReply: botReply,
          timestamp: new Date()
        });
        console.log(`✅ Conversation saved to MongoDB for session ${sid}`);
      } catch (dbError) {
        console.error("❌ MongoDB insert error:", dbError.message);
      }
    } else {
      console.log("⚠️ MongoDB not connected, conversation not saved.");
    }

    res.json({ reply: botReply });

  } catch (error) {
    console.error("❌ Server error:", {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ 
      reply: "सर्वर में त्रुटि हुई, कृपया बाद में प्रयास करें 🙏" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory and MongoDB`);
});
