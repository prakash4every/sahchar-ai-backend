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

// ========== THREAD CACHE FOR ASSISTANT ==========
const assistantThreads = new Map();

// ========== FAST CLIENTS - NVIDIA ==========
const nvidiaApiKeys = [
    process.env.NGC_API_KEY_1,
    process.env.NGC_API_KEY_2,
    process.env.NGC_API_KEY_3,
    process.env.NGC_API_KEY
].filter(key => key && key.trim()!== "");

const nvidiaClients = [];
nvidiaApiKeys.forEach(key => {
    nvidiaClients.push(new OpenAI({
        apiKey: key,
        baseURL: 'https://integrate.api.nvidia.com/v1',
        timeout: 8000
    }));
});

// ========== DEEPSEEK CLIENT ==========
const deepseekClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    timeout: 15000
});

// ========== OPENAI CLIENTS ==========
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openaiAssistantClient = new OpenAI({ apiKey: process.env.OPENAI_VIDEO_API_KEY });

// ========== NVIDIA FALLBACK FUNCTION - FIXED ==========
async function callNvidiaWithFallback(messages) {
    if (nvidiaClients.length === 0) throw new Error("No NVIDIA keys");
    const shortMessages = [messages[0],...messages.slice(-2)];

    for (let keyIdx = 0; keyIdx < nvidiaClients.length; keyIdx++) {
        try {
            const response = await nvidiaClients[keyIdx].chat.completions.create({
                model: "meta/llama-3.1-70b-instruct",
                messages: shortMessages,
                temperature: 0.5,
                max_completion_tokens: 100, // FIX: max_tokens nahi, max_completion_tokens
                stream: false,
            });
            const fullReply = response.choices[0]?.message?.content || "";
            console.log(`✅ NVIDIA key ${keyIdx} success. Reply length: ${fullReply.length}`);
            return fullReply.trim().substring(0, 300);
        } catch (err) {
            console.error(`❌ NVIDIA key ${keyIdx} failed:`, err.message);
            if (keyIdx === nvidiaClients.length - 1) {
                // DeepSeek fallback
                try {
                    console.log("🔄 Falling back to DeepSeek...");
                    const deepseekResponse = await deepseekClient.chat.completions.create({
                        model: "deepseek-chat",
                        messages: shortMessages,
                        temperature: 0.5,
                        max_tokens: 100
                    });
                    return deepseekResponse.choices[0]?.message?.content || "क्षमा करें।";
                } catch (dsErr) {
                    throw err;
                }
            }
        }
    }
}

const app = express();
const upload = multer({ dest: 'uploads/' });

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ reply: "क्षमा करें, मैसेज का फॉर्मेट सही नहीं है। 🙏" });
    }
    next(err);
});

// ========== MONGODB SETUP ==========
let db = null;
if (process.env.MONGODB_URI) {
    MongoClient.connect(process.env.MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000
    }).then(client => {
        db = client.db();
        console.log("✅ Live Server: Connected to MongoDB");
    }).catch(err => console.error("❌ MongoDB error:", err.message));
}

// ========== GLOBAL ERROR HANDLERS ==========
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

// ========== IN-MEMORY CACHE ==========
const conversations = {};
const imageContexts = {};

function getImageContextText(sid) {
    if (imageContexts[sid]?.lastAnalysis) {
        return `\n\n📷 पिछली इमेज: "${imageContexts[sid].lastAnalysis.substring(0, 300)}"\n\n`;
    }
    return "";
}

async function loadConversationFromDB(sid, limit = 6) {
    if (!db) return [];
    try {
        const messages = await db.collection('conversations').find({ sessionId: sid })
           .sort({ timestamp: -1 }).limit(limit).toArray();
        const history = [];
        messages.reverse().forEach(msg => {
            history.push({ role: "user", content: msg.userMessage });
            history.push({ role: "assistant", content: msg.botReply });
        });
        return history;
    } catch (err) {
        console.error("DB load error:", err);
        return [];
    }
}

// ========== HEALTH CHECK ==========
app.get("/", (req, res) => res.send("🌿 सहचर AI बैकएंड चालू है ✅"));

// ==================== 1. SAHCHAR AI - FIXED MEMORY ====================
app.post("/chat", async (req, res) => {
    const { message, sessionId } = req.body;
    const sid = sessionId || "default";
    if (!message) return res.status(400).json({ reply: "Message required 🙏" });

    try {
        const now = new Date();
        const currentDateTime = now.toLocaleString('hi-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
        });

        const imageContext = getImageContextText(sid);

        // FIX: Har baar DB se load karo agar memory me nahi hai
        if (!conversations[sid]) {
            const history = await loadConversationFromDB(sid, 6);
            conversations[sid] = [{
                role: "system",
                content: `तुम 'SahcharAI' हो – दोस्ताना AI। राम प्रकाश कुमार ने बनाया है। छोटे वाक्य में बात करो। इमोजी इस्तेमाल करो 😊🙏 वर्तमान समय: ${currentDateTime} ${imageContext}`
            },...history];
            console.log(`📚 Loaded ${history.length} messages from DB for ${sid}`);
        } else {
            // System prompt update karo time ke saath
            conversations[sid][0].content = `तुम 'SahcharAI' हो – दोस्ताना AI। राम प्रकाश कुमार ने बनाया है। छोटे वाक्य में बात करो। इमोजी इस्तेमाल करो 😊🙏 वर्तमान समय: ${currentDateTime} ${imageContext}`;
        }

        conversations[sid].push({ role: "user", content: message });
        if (conversations[sid].length > 9) conversations[sid] = [conversations[sid][0],...conversations[sid].slice(-8)];

        const botReply = await callNvidiaWithFallback(conversations[sid]);
        conversations[sid].push({ role: "assistant", content: botReply });

        if (db) db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply: botReply, timestamp: new Date() }).catch(e => { });
        res.json({ reply: botReply });

    } catch (error) {
        console.error("❌ /chat error:", error.message);
        res.status(500).json({ reply: "क्षमा करें, अभी सेवा व्यस्त है। 🙏" });
    }
});

// ==================== 2. SAHCHAR ASSISTANT - TIMEOUT FIX ====================
app.post("/chat-assistant", async (req, res) => {
    const { message, sessionId } = req.body;
    const sid = sessionId || "default";
    if (!message) return res.status(400).json({ error: "Message required 🙏" });

    const apiKey = process.env.OPENAI_VIDEO_API_KEY;
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    if (!apiKey ||!assistantId) return res.status(501).json({ reply: "Assistant not configured." });

    try {
        const now = new Date();
        const currentDateTime = now.toLocaleString('hi-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata'
        });

        let threadId = assistantThreads.get(sid);

        if (!threadId) {
            const thread = await openaiAssistantClient.beta.threads.create();
            threadId = thread.id;
            assistantThreads.set(sid, threadId);
            console.log(`✅ New thread ${threadId} for ${sid}`);

            // FIX 1: DB history ko thread me load karo - Sirf 3 exchange = 6 messages
            const history = await loadConversationFromDB(sid, 3);
            for (const msg of history) {
                await openaiAssistantClient.beta.threads.messages.create(threadId, {
                    role: msg.role,
                    content: msg.content
                });
            }
            console.log(`📚 Loaded ${history.length} messages to thread`);
        }

        await openaiAssistantClient.beta.threads.messages.create(threadId, {
            role: "user",
            content: message
        });

        const run = await openaiAssistantClient.beta.threads.runs.create(threadId, {
            assistant_id: assistantId,
            instructions: `वर्तमान समय: ${currentDateTime}. छोटे जवाब दो, max 2 वाक्य।`,
            max_completion_tokens: 120
        });

        // FIX 2: 90 second timeout + better error handling
        let runStatus = run;
        let attempts = 0;
        const maxAttempts = 90; // 90 seconds

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openaiAssistantClient.beta.threads.runs.retrieve(threadId, run.id);

            if (runStatus.status === "completed") break;
            if (runStatus.status === "failed") {
                console.error(`❌ Run failed:`, runStatus.last_error);
                throw new Error(`Assistant failed: ${runStatus.last_error?.message || 'Unknown error'}`);
            }
            if (runStatus.status === "cancelled" || runStatus.status === "expired") {
                throw new Error(`Assistant ${runStatus.status}`);
            }
            attempts++;
        }

        if (runStatus.status!== "completed") {
            throw new Error(`Assistant timeout after ${maxAttempts}s. Status: ${runStatus.status}`);
        }

        const messages = await openaiAssistantClient.beta.threads.messages.list(threadId, { limit: 1 });
        let reply = messages.data[0]?.content[0]?.text?.value || "कोई जवाब नहीं।";
        reply = reply.replace(/जय भीम, नमो बुद्धाय.*$/i, '').trim().substring(0, 500);

        // DB me save karo taaki agle baar yaad rahe
        if (db) {
            await db.collection('conversations').insertOne({
                sessionId: sid,
                userMessage: message,
                botReply: reply,
                timestamp: new Date()
            }).catch(e => console.error("DB save error:", e));
        }

        console.log(`✅ Assistant reply for session ${sid}: "${reply.substring(0, 50)}..."`);
        res.json({ reply, threadId });

    } catch (error) {
        console.error("❌ Assistant API error:", error.message);

        // FIX 3: Fallback to NVIDIA if Assistant fails
        try {
            console.log("🔄 Falling back to NVIDIA for Assistant...");
            const history = await loadConversationFromDB(sid, 3);
            const messages = [
                { role: "system", content: "You are Sahchar Assistant. Reply in Hindi, short 1-2 sentences." },
               ...history,
                { role: "user", content: message }
            ];
            const fallbackReply = await callNvidiaWithFallback(messages);

            if (db) {
                await db.collection('conversations').insertOne({
                    sessionId: sid,
                    userMessage: message,
                    botReply: fallbackReply,
                    timestamp: new Date()
                });
            }

            res.json({ reply: fallbackReply + " (Fallback)", threadId: null });
        } catch (fallbackErr) {
            res.status(500).json({ reply: "क्षमा करें, असिस्टेंट सेवा उपलब्ध नहीं है। 🙏" });
        }
    }
});
// ==================== 3. SAMBANOVA - FIXED MEMORY ====================
app.post("/chat-sambanova", async (req, res) => {
    const { message, sessionId } = req.body;
    const sid = sessionId || "default";
    if (!message) return res.status(400).json({ error: "Message required 🙏" });

    const apiKey = process.env.SAMBANOVA_API_KEY;
    const baseURL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";
    if (!apiKey) return res.status(501).json({ reply: "SambaNova not configured." });

    try {
        const now = new Date();
        const currentDateTime = now.toLocaleString('hi-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata' });
        const imageContext = getImageContextText(sid);
        const sambanova = new OpenAI({ apiKey: apiKey, baseURL: baseURL });

        if (!conversations[sid]) {
            const history = await loadConversationFromDB(sid, 20);
            conversations[sid] = [{ role: "system", content: `तुम एक सहायक AI हो। तुम्हें राम प्रकाश कुमार ने बनाया है। वर्तमान तारीख और समय है: ${currentDateTime} ${imageContext}` },...history];
            console.log(`📚 SambaNova loaded ${history.length} messages`);
        } else {
            conversations[sid][0].content = `तुम एक सहायक AI हो। तुम्हें राम प्रकाश कुमार ने बनाया है। वर्तमान तारीख और समय है: ${currentDateTime} ${imageContext}`;
        }

        conversations[sid].push({ role: "user", content: message });
        const response = await sambanova.chat.completions.create({ model: "Meta-Llama-3.3-70B-Instruct", messages: conversations[sid], temperature: 0.7 });
        const botReply = response.choices[0]?.message?.content || "No response.";
        conversations[sid].push({ role: "assistant", content: botReply });

        if (db) await db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply: botReply, timestamp: new Date() }).catch(e => { });
        res.json({ reply: botReply });

    } catch (error) {
        console.error("❌ SambaNova API error:", error);
        res.status(500).json({ reply: "क्षमा करें, SambaNova सेवा उपलब्ध नहीं है। 🙏" });
    }
});

// ==================== 4. SUPER SAHCHAR - FIXED MEMORY ====================
app.post("/chat-nvidia", async (req, res) => {
    const { message, sessionId } = req.body;
    const sid = sessionId || "default";
    if (!message) return res.status(400).json({ error: "Message required 🙏" });

    try {
        const now = new Date();
        const currentDateTime = now.toLocaleString('hi-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Asia/Kolkata' });
        const imageContext = getImageContextText(sid);
        const systemContent = `तुम 'SuperSahchar' हो – रियल इंसानी दोस्त। राम प्रकाश कुमार ने बनाया है। छोटे वाक्य। "हाँ", "अच्छा", "हम्म" बोलो। सवाल पूछो। इमोजी 😊😂🙏 वर्तमान समय: ${currentDateTime} ${imageContext}`;

        if (!conversations[sid]) {
            const history = await loadConversationFromDB(sid, 6);
            conversations[sid] = [{ role: "system", content: systemContent },...history];
            console.log(`📚 SuperSahchar loaded ${history.length} messages`);
        } else {
            conversations[sid][0].content = systemContent;
        }

        conversations[sid].push({ role: "user", content: message });
        if (conversations[sid].length > 9) conversations[sid] = [conversations[sid][0],...conversations[sid].slice(-8)];

        const fullReply = await callNvidiaWithFallback(conversations[sid]);
        conversations[sid].push({ role: "assistant", content: fullReply });

        if (db) db.collection('conversations').insertOne({ sessionId: sid, userMessage: message, botReply: fullReply, timestamp: new Date() }).catch(e => { });
        res.json({ reply: fullReply });

    } catch (error) {
        console.error("❌ /chat-nvidia error:", error);
        res.status(500).json({ reply: "क्षमा करें, अभी थोड़ी देर में बात करते हैं? 😅" });
    }
});

// ==================== REST OF THE ENDPOINTS - SAME AS BEFORE ====================
app.post("/api/image/generate", async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है" });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "API key not configured", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
    try {
        const response = await axios.post("https://api.openai.com/v1/images/generations", { model: "dall-e-3", prompt: prompt, n: 1, size: "1024x1024" }, { headers: { "Authorization": `Bearer ${apiKey}` } });
        res.json({ imageUrl: response.data.data[0].url });
    } catch (error) {
        res.status(500).json({ error: "इमेज जनरेशन फेल", imageUrl: "https://via.placeholder.com/1024x1024.png?text=Error" });
    }
});

app.post("/api/audio/transcribe", upload.single("audio"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "ऑडियो फाइल जरूरी है" });
    try {
        res.json({ transcription: "यह एक नमूना ट्रांसक्रिप्शन है।", confidence: 0.95 });
    } catch (err) {
        res.status(500).json({ error: "ट्रांसक्रिप्शन फेल" });
    } finally {
        if (req.file?.path) fs.unlink(req.file.path, () => { });
    }
});

app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "कोई इमेज अपलोड नहीं की गई है। 🙏" });
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "कृपया इमेज के बारे में कुछ पूछें। 🙏" });
    const sid = sessionId || "default";
    try {
        const imageBuffer = fs.readFileSync(req.file.path);
        const base64Image = imageBuffer.toString('base64');
        fs.unlinkSync(req.file.path);
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return res.status(500).json({ error: "OpenAI API key कॉन्फ़िगर नहीं है।" });
        if (!imageContexts[sid]) imageContexts[sid] = { lastImage: null, lastAnalysis: null, conversation: [] };
        imageContexts[sid].conversation.push({ role: "user", content: message });
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "You are SahcharAI." }, { role: "user", content: [{ type: "text", text: message }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }] }],
        });
        const analysis = response.choices[0].message.content;
        imageContexts[sid].lastAnalysis = analysis;
        imageContexts[sid].conversation.push({ role: "assistant", content: analysis });
        res.json({ analysis: analysis });
    } catch (error) {
        res.status(500).json({ error: "इमेज का विश्लेषण करने में त्रुटि हुई। 🙏" });
    }
});

app.post("/api/video/generate", async (req, res) => {
    const { prompt, imageUrl, duration = 5 } = req.body;
    if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
    const apiKey = process.env.RUNWAYML_API_SECRET;
    if (!apiKey) return res.status(500).json({ error: "API key error", videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" });
    try {
        let finalImageUrl = imageUrl;
        if (!finalImageUrl) {
            const dalleApiKey = process.env.OPENAI_API_KEY;
            if (!dalleApiKey) throw new Error("OpenAI API key missing");
            const dalleResponse = await axios.post("https://api.openai.com/v1/images/generations", { model: "dall-e-3", prompt: prompt, n: 1, size: "1024x1024" }, { headers: { "Authorization": `Bearer ${dalleApiKey}` } });
            finalImageUrl = dalleResponse.data.data[0].url;
        }
        const client = new RunwayML({ apiKey });
        const task = await client.imageToVideo.create({ model: 'gen4_turbo', promptImage: finalImageUrl, promptText: prompt, ratio: '1280:720', duration: Math.min(Math.max(parseInt(duration), 2), 10) });
        let status = 'PENDING', attempts = 0, taskStatus = null;
        while (attempts < 90) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            taskStatus = await client.tasks.retrieve(task.id);
            status = taskStatus.status;
            if (status === 'SUCCEEDED') break;
            if (status === 'FAILED') throw new Error(`Task failed`);
            attempts++;
        }
        if (status!== 'SUCCEEDED') throw new Error('Timeout');
        let videoUrl = taskStatus.output?.output?.[0] || taskStatus.output?.[0] || taskStatus.output?.videoUrl;
        if (!videoUrl) throw new Error('No video URL found');
        res.json({ videoUrl, status: "success" });
    } catch (error) {
        res.status(500).json({ error: error.message, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
    }
});

app.post("/api/video/generate-text", async (req, res) => {
    const { prompt, duration = 5 } = req.body;
    if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
    const demoVideoUrl = "https://www.w3schools.com/html/mov_bbb.mp4";
    const runwayKey = process.env.RUNWAYML_API_SECRET;
    if (runwayKey) {
        try {
            const client = new RunwayML({ apiKey: runwayKey });
            const task = await client.textToVideo.create({ model: 'gen4.5', promptText: prompt, ratio: '1280:720', duration: Math.min(Math.max(parseInt(duration), 2), 10) });
            let status = 'PENDING', attempts = 0, taskStatus = null;
            while (attempts < 90) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                taskStatus = await client.tasks.retrieve(task.id);
                status = taskStatus.status;
                if (status === 'SUCCEEDED') break;
                if (status === 'FAILED') throw new Error(`Runway failed`);
                attempts++;
            }
            if (status!== 'SUCCEEDED') throw new Error('Runway timeout');
            let videoUrl = taskStatus.output?.output?.[0] || taskStatus.output?.[0] || taskStatus.output?.videoUrl;
            if (!videoUrl) throw new Error('No video URL from Runway');
            return res.json({ videoUrl, status: "success", provider: "runway" });
        } catch (runwayError) {
            console.warn(`⚠️ RunwayML failed: ${runwayError.message}`);
        }
    }
    return res.json({ videoUrl: demoVideoUrl, status: "demo", provider: "demo" });
});

app.post("/api/video/generate-zeroscope", async (req, res) => {
    const { prompt, fps = 24, width = 1024, height = 576, guidance_scale = 17.5, negative_prompt = "very blue, dust, noisy, washed out, ugly, distorted, broken" } = req.body;
    if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
    const apiKey = process.env.REPLICATE_API_KEY_ZEROSCOPE;
    if (!apiKey) return res.status(500).json({ error: "Zeroscope API key not configured", demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4" });
    try {
        const Replicate = (await import('replicate')).default;
        const replicateZeroScope = new Replicate({ auth: apiKey });
        const modelVersion = "anotherjesse/zeroscope-v2-xl:9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";
        const input = { fps: Math.min(Math.max(parseInt(fps), 8), 30), width: Math.min(Math.max(parseInt(width), 256), 1024), height: Math.min(Math.max(parseInt(height), 256), 576), prompt, guidance_scale: parseFloat(guidance_scale), negative_prompt };
        const output = await replicateZeroScope.run(modelVersion, { input });
        let videoUrl = null;
        if (Array.isArray(output) && output.length > 0) {
            if (typeof output[0].url === 'function') videoUrl = output[0].url();
            else if (typeof output[0] === 'string') videoUrl = output[0];
            else if (output[0].url) videoUrl = output[0].url;
        } else if (typeof output === 'string') videoUrl = output;
        else if (output && output.url) videoUrl = output.url;
        if (!videoUrl) throw new Error("No video URL found");
        res.json({ videoUrl, status: "success", provider: "zeroscope" });
    } catch (error) {
        res.status(500).json({ error: error.message, demoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
    }
});

app.post("/api/video/generate-sora", async (req, res) => {
    const { prompt, model = "sora-2-pro", seconds = 8, size = "1280x720" } = req.body;
    if (!prompt) return res.status(400).json({ error: "प्रॉम्प्ट देना जरूरी है 🙏" });
    const apiKey = process.env.OPENAI_VIDEO_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Sora API key not configured", videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
    try {
        const openai = new OpenAI({ apiKey });
        if (!openai.videos || typeof openai.videos.create!== 'function') {
            return res.json({ videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", status: "demo", provider: "demo" });
        }
        const video = await openai.videos.create({ model: model, prompt: prompt, seconds: parseInt(seconds), size: size });
        let videoStatus = video, attempts = 0;
        while (videoStatus.status!== "completed" && videoStatus.status!== "failed" && attempts < 60) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            videoStatus = await openai.videos.retrieve(video.id);
            attempts++;
        }
        if (videoStatus.status === "failed") throw new Error(videoStatus.error?.message || "Sora failed");
        if (videoStatus.status!== "completed") throw new Error("Sora timeout");
        const videoUrl = videoStatus.url;
        if (!videoUrl) throw new Error("No video URL");
        res.json({ videoUrl, status: "success", provider: "sora", videoId: video.id });
    } catch (error) {
        res.status(500).json({ error: error.message, videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4", demo: true });
    }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
