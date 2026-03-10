import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" })); // 🔥 लंबे संदेशों के लिए लिमिट बढ़ाई

// 📦 इन-मेमोरी कन्वर्सेशन स्टोरेज
const conversations = {};

// ✅ GET route
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

    // 🔥 टोकन लिमिट के अनुमान के लिए एक सरल गिनती (वैकल्पिक)
    const estimateTokens = (msgs) => {
      return msgs.reduce((acc, msg) => acc + JSON.stringify(msg).length / 4, 0);
    };

    // 🔥 अगर अनुमानित टोकन 4000 से अधिक हों, तो पुराने संदेश हटाएँ (system message छोड़कर)
    while (estimateTokens(conversations[sid]) > 4000 && conversations[sid].length > 2) {
      // system message (index 0) के बाद का पहला सबसे पुराना संदेश हटाएँ
      conversations[sid].splice(1, 1);
    }

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

    // 🔥 अगर API एरर लौटाता है, तो उसे भी हैंडल करें
    if (!response.ok) {
      console.error("DeepSeek API error:", data);
      return res.status(500).json({
        reply: `क्षमा करें, API त्रुटि: ${data.error?.message || "अज्ञात त्रुटि"} 🙏`
      });
    }

    const botReply = data.choices?.[0]?.message?.content;

    if (!botReply) {
      console.error("DeepSeek API response invalid:", data);
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
    console.error("Server error:", error);
    res.status(500).json({ 
      reply: "सर्वर में त्रुटि हुई, कृपया बाद में प्रयास करें 🙏" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory`);
});