import mongoose from "mongoose";

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const chatSchema = new mongoose.Schema({
  userId: String,
  role: String,
  content: String,
  timestamp: { type: Date, default: Date.now }
});

const Chat = mongoose.model("Chat", chatSchema);
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
  const { message, userId = "default", mode = "buddha" } = req.body;

  if (!message) {
    return res.status(400).json({ reply: "Message required" });
  }

  let systemPrompt;

  if (mode === "creative") {
    systemPrompt = "You are a creative storytelling AI.";
  } 
  else if (mode === "government") {
    systemPrompt = "You help with Indian government schemes and public services.";
  } 
  else {
    systemPrompt = `
    तुम 'सहचर' हो – गौतम बुद्ध की करुणा से प्रेरित AI।
    हमेशा शांत, संक्षिप्त और प्रेरक उत्तर दो।
    अंत में 'जय भीम, नमो बुद्धाय 🙏' जोड़ो।
    `;
  }

  try {

    // 🔹 पिछली 5 चैट लाओ
    const history = await Chat.find({ userId })
      .sort({ timestamp: -1 })
      .limit(5);

    const formattedHistory = history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    const messages = [
      { role: "system", content: systemPrompt },
      ...formattedHistory,
      { role: "user", content: message }
    ];

    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages
      })
    });

    const data = await response.json();
    const botReply = data.choices[0].message.content;

    // 🔹 Save chat
    await Chat.create({ userId, role: "user", content: message });
    await Chat.create({ userId, role: "assistant", content: botReply });

    res.json({ reply: botReply });

  } catch (error) {
    console.error(error);
    res.status(500).json({ reply: "तकनीकी समस्या है 🙏" });
  }
});

    const data = await response.json();
    
    // DeepSeek से जवाब मिला
    const botReply = data.choices[0].message.content;
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