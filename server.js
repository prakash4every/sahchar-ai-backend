import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
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

// 📦 इन-मेमोरी कन्वर्सेशन स्टोरेज
const conversations = {};

// ✅ GET route – सर्वर चेक
app.get("/", (req, res) => {
  res.send("🌿 सहचर AI बैकएंड चालू है ✅ (मेमोरी अपडेट)");
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
      // system message (index 0) के बाद का पहला सबसे पुराना संदेश हटाएँ
      conversations[sid].splice(1, 1);
    }

    // 📤 लॉग: कितने संदेश और टोकन भेज रहे हैं
    console.log(`📤 Session ${sid}: Sending ${conversations[sid].length} messages, ~${Math.round(estimateTokens(conversations[sid]))} tokens`);

    // DeepSeek API कॉल से पहले लॉग
    console.log("📤 Calling DeepSeek API...");

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

    // API कॉल के बाद स्टेटस लॉग
    console.log(`📥 DeepSeek API response status: ${response.status}`);

    const data = await response.json();

    // 🔥 अगर API एरर लौटाता है, तो उसे भी हैंडल करें
    if (!response.ok) {
      console.error("❌ DeepSeek API error:", JSON.stringify(data, null, 2));
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

    // 🔥 हिस्ट्री को बहुत लंबा होने से रोकें (30 से अधिक न हो)
    if (conversations[sid].length > 30) {
      conversations[sid] = [
        conversations[sid][0],
        ...conversations[sid].slice(-20)
      ];
    }

    res.json({ reply: botReply });

  } catch (error) {
    // 🔥 एरर को विस्तार से लॉग करें
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
  console.log(`🚀 Server running on port ${PORT} with memory`);
});