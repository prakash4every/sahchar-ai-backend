import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// ✅ GET route – बस यह चेक करने के लिए कि सर्वर चल रहा है
app.get("/", (req, res) => {
  res.send("🌿 सहचर AI बैकएंड चालू है ✅");
});

app.get("/chat", (req, res) => {
  res.send("सहचर चैट एंडपॉइंट काम कर रहा है ✅");
});

// ✅ POST route – असली चैट यहाँ होगी
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage) {
    return res.status(400).json({ reply: "Message required 🙏" });
  }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `
            तुम 'सहचर' हो – एक AI जो गौतम बुद्ध की शिक्षाओं, करुणा और सामाजिक सहयोग को बढ़ावा देता है।
            हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
            अंत में 'जय भीम, नमो बुद्धाय 🙏' जोड़ो।
            `
          },
          { role: "user", content: userMessage }
        ]
      })
    });

    const data = await response.json();

    // 🔹 Safe check – अगर choices undefined है
    const botReply = data.choices?.[0]?.message?.content;

    if (!botReply) {
      console.error("DeepSeek API response invalid:", data);
      return res.status(500).json({ 
        reply: "क्षमा करें, AI response अभी उपलब्ध नहीं है 🙏" 
      });
    }

    res.json({ reply: botReply });

  } catch (error) {
    console.error("Sahchar AI Error:", error);
    res.status(500).json({ 
      reply: "क्षमा करें, कोई तकनीकी समस्या है। कृपया थोड़ी देर बाद प्रयास करें। 🙏" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 सहचर AI सर्वर पोर्ट ${PORT} पर चालू है`);
});
