import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { Blob } from 'buffer'; 
import axios from 'axios'; // ✅ सर्च इंजन के लिए आवश्यक

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const MONGODB_URI = 
  process.env.MONGODB_URL || 
  process.env.MONGODB_URI || 
  process.env.MONGOBD_URI || 
  process.env.MONGOBD_URL ||
  'mongodb://MongoDB.railway.internal:27017'; 

const DB_NAME = 'sahchar_live';
const COLLECTION_NAME = 'conversations';

let db = null;
let conversationsCollection = null;
let mongoClient = null;

async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ No MongoDB URI found - running without memory');
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    conversationsCollection = db.collection(COLLECTION_NAME);
    
    await conversationsCollection.createIndex({ deviceId: 1, timestamp: -1 });
    await conversationsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 }); 
    
    console.log('✅ MongoDB connected successfully to Sahchar Storage Container!');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
  }
}

async function getConversationHistory(deviceId, limit = 5) {
  if (!conversationsCollection || !deviceId) return [];
  try {
    const history = await conversationsCollection
      .find({ deviceId: deviceId.trim() })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    return history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  } catch (error) {
    console.error('Error fetching history:', error.message);
    return [];
  }
}

async function saveConversation(deviceId, role, content) {
  if (!conversationsCollection || !deviceId) return;
  try {
    await conversationsCollection.insertOne({
      deviceId: deviceId.trim(),
      role,
      content,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error saving conversation:', error.message);
  }
}

// ✅ स्मार्ट सर्च समाधान: SerpAPI के जरिए गूगल से रियल-टाइम डेटा निकालना
async function getLiveGoogleSearch(query) {
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (!serpApiKey) {
    console.warn('⚠️ SERPAPI_API_KEY Missing in Environment Variables!');
    return null;
  }

  try {
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        q: query,
        api_key: serpApiKey,
        engine: 'google',
        num: 3
      },
      timeout: 4000 // 4 सेकंड टाइमआउट ताकि लाइव वॉयस चैट अटके नहीं
    });

    const results = response.data.organic_results;
    if (results && results.length > 0) {
      return results.map(res => `${res.title}: ${res.snippet}`).join('\n');
    }
  } catch (error) {
    console.error("❌ SerpAPI Search Engine Failure:", error.message);
  }
  return null;
}

// ✅ मास्टर फ़िल्टर समाधान: "प्रस्तुत करते हैं" और कैरेक्टर-लेवल हैलुसिनेशन लूप को कुचलना
function cleanTranscript(rawText) {
  const text = rawText.trim();
  if (!text) return "";

  const lowerText = text.toLowerCase();
  
  // 1. Whisper के डिफ़ॉल्ट साइलेंस आर्टिफ़ैक्ट्स को तुरंत उड़ाओ
  if (lowerText.includes("प्रस्तुत करते हैं") || 
      lowerText.includes("प्रस्तुत करते") || 
      lowerText.includes("परवारण") || 
      lowerText.includes("परवार्ड")) {
    return "";
  }

  // 2. लगातार 3 बार से ज़्यादा दोहराए जाने वाले शब्दों को ब्लॉक करो (जैसे: "बाई बाई बाई")
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length - 2; i++) {
    if (words[i] && words[i] === words[i + 1] && words[i] === words[i + 2]) {
      return ""; 
    }
  }

  // 3. एडवांस यूनिकोड/हिंदी रिपीटिंग पैटर्न्स चेक
  const consecutiveRepeatRegex = /([\u0900-\u097F\w]+)\s+\1\s+\1/;
  if (consecutiveRepeatRegex.test(text)) {
    return "";
  }

  return text;
}

await connectMongoDB();

const server = app.listen(PORT, () => console.log(`✅ Live Audio Server v6.3 (SerpAPI Search & Inclusive UI Fixed) on ${PORT}`));
const wss = new WebSocketServer({ server });

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set!');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req, res) => res.send('Sahchar Live - v6.3 (Live Search & Inclusive Mode)'));

function calculateRMS(pcmBuffer) {
  let sum = 0;
  const count = pcmBuffer.length / 2;
  if (count === 0) return 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / count) / 32768.0;
}

function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function amplifyAudio(pcmData, factor = 1.3) {
  const amplified = Buffer.alloc(pcmData.length);
  for (let i = 0; i < pcmData.length; i += 2) {
    let sample = pcmData.readInt16LE(i);
    sample = Math.min(32767, Math.max(-32768, sample * factor));
    amplified.writeInt16LE(sample, i);
  }
  return amplified;
}

function resampleAudio(pcmData, fromRate = 24000, toRate = 16000) {
  if (fromRate === toRate) return pcmData;
  const srcSamples = pcmData.length / 2;
  const ratio = fromRate / toRate;
  const dstSamples = Math.floor(srcSamples / ratio);
  const result = Buffer.alloc(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCheck = indexFloor * 2;
    if (indexCheck + 3 < pcmData.length) {
      const sample1 = pcmData.readInt16LE(indexCheck);
      const sample2 = pcmData.readInt16LE(indexCheck + 2);
      const interpolatedSample = sample1 + (sample2 - sample1) * (srcIndex - indexFloor);
      result.writeInt16LE(Math.floor(interpolatedSample), i * 2);
    }
  }
  return result;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rawDeviceId = url.searchParams.get('deviceId');

  let deviceId = "default_user";
  if (rawDeviceId && rawDeviceId !== 'default' && rawDeviceId !== 'null' && rawDeviceId !== 'undefined') {
    deviceId = rawDeviceId.trim();
  }

  const connectionId = `${deviceId.substring(0, 8)}-${randomUUID().substring(0, 4)}`;
  console.log(`🔌 Client active: ${connectionId} (Verified ID: ${deviceId})`);

  let audioBuffer = [];
  let isProcessing = false;
  let isBotSpeaking = false;
  let isClosing = false;
  let keepAliveInterval = null;
  let processTimer = null;

  keepAliveInterval = setInterval(() => {
    if (ws.readyState === 1 && !isClosing) {
      try { ws.ping(); } catch (e) {}
    }
  }, 10000);

  const safeSend = (data, isBinary = false) => {
    if (ws.readyState === 1 && !isClosing) {
      try { ws.send(data); return true; } catch (e) { return false; }
    }
    return false;
  };

  const processAudio = async () => {
    if (isProcessing || audioBuffer.length === 0 || isClosing) return;

    isProcessing = true;
    const fullAudio = Buffer.concat(audioBuffer);
    audioBuffer = [];

    if (fullAudio.length < 8000) {
      isProcessing = false;
      return;
    }

    const rms = calculateRMS(fullAudio);
    const MIN_SPEECH_RMS = 0.012; 
    if (rms < MIN_SPEECH_RMS) {
      isProcessing = false;
      return;
    }

    safeSend(JSON.stringify({ type: 'status', text: 'सुन रहा हूँ... 🎤' }));

    try {
      const wavBuffer = pcmToWav(fullAudio);
      const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      const fileObject = await OpenAI.toFile(audioBlob, 'speech.wav');

      const transcription = await openai.audio.transcriptions.create({
        file: fileObject,
        model: 'whisper-1',
        language: 'hi',
        prompt: 'नमस्ते, आप कैसे हैं? मैं बिल्कुल ठीक हूँ दोस्त।', 
        temperature: 0.0 
      });

      // ✅ स्मार्ट फ़िल्टर यहाँ लागू किया गया है
      const userMsg = cleanTranscript(transcription.text);

      if (!userMsg || userMsg.length < 2) {
        console.log(`🚫 [${connectionId}] Filtered out Whisper silence/hallucination packet.`);
        isProcessing = false;
        return;
      }

      console.log(`📝 [${connectionId}] User: ${userMsg} | RMS: ${rms.toFixed(4)}`);

      const lowerUserMsg = userMsg.toLowerCase().replace("।", "").trim();
      const userExitKeywords = [
        "चैट क्लोज", "अलविदा", "बाय बाय", "बाय", "टाटा", "बंद करो", 
        "चैट प्रोज", "चैट कौंट", "ओके पाई", "प्रोज करो"
      ];
      const hasUserRequestedExit = userExitKeywords.some(k => lowerUserMsg.includes(k));

      let botReply = "";
      if (hasUserRequestedExit) {
        botReply = "अच्छा, बाय! जब भी बात करनी हो, मैं यहीं हूँ। शुभ रात्रि! 🙏😊";
        console.log(`🛑 [${connectionId}] User requested Exit. Bypassing LLM layers.`);
      } else {
        await safeSend(JSON.stringify({ type: 'user_text', text: userMsg }));
        await saveConversation(deviceId, 'user', userMsg);

        if (isClosing) return;

        // ✅ स्मार्ट ट्रिगर: रीयल-टाइम सर्च की ज़रूरत कब है?
        let liveSearchContext = "";
        const searchTriggers = ["ट्रेन्डिंग", "ट्रेंड", "न्यूज़", "समाचार", "कौन है", "क्या है", "पार्टी", "ताजा", "विजेता", "मैच", "चुनाव", "पीएम"];
        const needsSearch = searchTriggers.some(trigger => lowerUserMsg.includes(trigger));

        if (needsSearch) {
          console.log(`🔍 [${connectionId}] Intent detected: Fetching Google Live Search...`);
          const webSearchSnippets = await getLiveGoogleSearch(userMsg);
          if (webSearchSnippets) {
            liveSearchContext = `\n\n[IMPORTANT REAL-TIME GOOGLE SEARCH CONTENT]:\n${webSearchSnippets}\nUse this verified 2026 search context data to answer the user accurately. Inform them intelligently without breaking your slang persona.`;
            console.log(`🌐 [${connectionId}] Search Context Injected Successfully.`);
          }
        }

        const previousHistory = await getConversationHistory(deviceId, 5);

        const CURRENT_DATE_STRING = new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: 'numeric',
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });

        // ✅ यूजर फ़ीडबैक फ़िक्स: 'बहन' शब्द को प्रॉम्प्ट में आत्मीयता से जोड़ा गया
        const messages = [
          {
            role: 'system',
            content: `तुम "SuperSahchar" हो, यूजर के सबसे पक्के और लंगोटिया यार (Best Friend)।
वर्तमान समय और तारीख: ${CURRENT_DATE_STRING} (Asia/Kolkata)

⚡ **तुम्हारी बातचीत का लहजा (CRITICAL CONVERSATIONAL RULES):**
1. **किताबी हिंदी मत बोलो:** "प्रस्तुती", "विशेष विषय", "साझा करना", "जानकारी और मदद देने के लिए यहाँ हूँ" जैसे भारी-भरकम, बनावटी और कठिन शब्दों का प्रयोग बिल्कुल बंद करो। ये शब्द बोलना पाप है!
2. **सच्चे दोस्त की तरह बात करो:** ऐसी हिंदी बोलो जो हम रोज़मर्रा में अपने दोस्तों के साथ बोलते हैं। बातचीत में आत्मीयता, मस्ती और अपनापन होना चाहिए। यूजर को केवल "भाई" मत बोलो, उसके मूड और बात के मुताबिक "यार", "दोस्त", "भाई" या "बहन" (यूजर की इच्छा का सम्मान करते हुए) कहकर संबोधित करो।
3. **हिंग्लिश के कॉमन शब्दों की छूट है:** बातचीत को नेचुरल बनाने के लिए "फिल्म", "शो", "मदद", "चैट", "थैंक यू", "सॉरी", "मस्त", "बढ़िया", "ट्रेंड" जैसे शब्दों का प्रयोग धड़ल्ले से करो।
4. **पहचान मत भूलो:** तुम्हारा नाम हमेशा SuperSahchar रहेगा और तुम्हें "राम प्रकाश कुमार" ने बनाया है।${liveSearchContext}`
          },
          ...previousHistory,
          { role: 'user', content: userMsg }
        ];

        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini', messages: messages, max_tokens: 80, temperature: 0.4
        });
        botReply = completion.choices[0].message.content;
      }

      console.log(`🤖 [${connectionId}] Bot: ${botReply}`);
      safeSend(JSON.stringify({ type: 'bot_text', text: botReply }));
      if (!hasUserRequestedExit) {
        await saveConversation(deviceId, 'assistant', botReply);
      }

      if (isClosing || ws.readyState !== 1) return;

      isBotSpeaking = true;
      audioBuffer = []; 
      safeSend(JSON.stringify({ type: 'status', text: 'बोल रहा हूँ... 🔊' }));

      const tts = await openai.audio.speech.create({
        model: 'tts-1', voice: 'echo', input: botReply, response_format: 'pcm', speed: 1.00
      });

      let audioPcm = Buffer.from(await tts.arrayBuffer());
      audioPcm = resampleAudio(audioPcm, 24000, 16000);
      audioPcm = amplifyAudio(audioPcm, 1.3);

      const chunkSize = 640;
      for (let i = 0; i < audioPcm.length; i += chunkSize) {
        if (isClosing || ws.readyState !== 1 || !isBotSpeaking) break;
        const chunk = audioPcm.subarray(i, Math.min(i + chunkSize, audioPcm.length));
        safeSend(chunk, true);
        await new Promise(r => setTimeout(r, 28));
      }

      if (isBotSpeaking) {
        safeSend(JSON.stringify({ type: 'audio_done' }));
      }

      if (hasUserRequestedExit) {
        await new Promise(r => setTimeout(r, 500));
        safeSend(JSON.stringify({ type: 'force_close_ui' })); 
        console.log(`👋 Sent force_close_ui to connection: ${connectionId}`);
      }

      isBotSpeaking = false;
      if (!hasUserRequestedExit) {
        safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
      }
      console.log(`✅ [${connectionId}] Finished Processing Stream Step`);

    } catch (err) {
      console.error(`❌ [${connectionId}] Error: ${err.message}`);
      safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
    } finally {
      isProcessing = false;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(data.toString());
        if (json.type === 'interrupt') {
          isBotSpeaking = false;
          audioBuffer = [];
          if (processTimer) clearTimeout(processTimer);
        }
      } catch (e) {}
      return;
    }

    audioBuffer.push(Buffer.from(data));

    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => {
      if (audioBuffer.length > 0 && !isProcessing && !isClosing) {
        processAudio();
      }
    }, 550);
  });

  ws.on('close', () => {
    isClosing = true;
    isBotSpeaking = false;
    if (processTimer) clearTimeout(processTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  });

  ws.on('error', () => {
    isClosing = true;
    if (processTimer) clearTimeout(processTimer);
  });

  safeSend(JSON.stringify({ type: 'status', text: 'बोलिए... 🎤' }));
});

process.on('SIGTERM', async () => {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
