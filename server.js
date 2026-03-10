import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// 📦 इन-मेमोरी कन्वर्सेशन स्टोरेज (अस्थायी, प्रोडक्शन में डेटाबेस इस्तेमाल करें)
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

  if (!message) {
    return res.status(400).json({ reply: "Message required 🙏" });
  }

  // यदि sessionId नहीं दिया तो डिफ़ॉल्ट "default" का उपयोग करें
  const sid = sessionId || "default";

  // इस सत्र के लिए हिस्ट्री प्राप्त करें (न हो तो नई बनाएँ)
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

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: conversations[sid]   // पूरी हिस्ट्री भेजें
      })
    });

    const data = await response.json();
    const botReply = data.choices?.[0]?.message?.content;

    if (!botReply) {
      console.error("DeepSeek API response invalid:", data);
      return res.status(500).json({ 
        reply: "क्षमा करें, AI response अभी उपलब्ध नहीं है 🙏" 
      });
    }

    // बॉट का जवाब हिस्ट्री में जोड़ें
    conversations[sid].push({ role: "assistant", content: botReply });

    // हिस्ट्री को बहुत लंबा होने से बचाने के लिए पुराने संदेश हटा सकते हैं (यहाँ वैकल्पिक)
    // उदाहरण: अगर 20 से अधिक संदेश हों तो पहले वाले हटाएँ (system message छोड़कर)
    if (conversations[sid].length > 30) {
      // system message (index 0) को छोड़कर बाकी में से सबसे पुराने 10 हटाएँ
      conversations[sid] = [
        conversations[sid][0],
        ...conversations[sid].slice(-20)
      ];
    }

    res.json({ reply: botReply });

  } catch (error) {
    console.error("Error calling DeepSeek API:", error);
    res.status(500).json({ 
      reply: "सर्वर में त्रुटि हुई, कृपया बाद में प्रयास करें 🙏" 
    });
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} with memory`);
});