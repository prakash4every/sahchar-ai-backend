import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import session from 'express-session';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load environment variables
dotenv.config();

const app = express(); // ✅ यह लाइन बहुत जरूरी है
const PORT = process.env.PORT || 3000;

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Multer configuration for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ==================== DATABASE SETUP ====================
const dbPath = path.join(process.cwd(), 'data', 'omni_ai.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database at', dbPath);
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      language TEXT DEFAULT 'en',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      language TEXT DEFAULT 'en',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS generated_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      file_url TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  console.log('Database tables initialized');
}

// ==================== CONTENT FILTERING ====================
function filterContent(content, language = 'en') {
  const blockedPatterns = [
    /violence|harm|abuse/i,
    /explicit|adult|nsfw/i,
    /hate|discrimination|racist/i,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(content)) {
      return {
        isBlocked: true,
        reason: language === 'hi' ? 'अनुपयुक्त सामग्री' : 'Inappropriate content detected'
      };
    }
  }

  return { isBlocked: false };
}

// ==================== DEEPSEEK API INTEGRATION ====================
async function callDeepSeekAPI(messages, language = 'en') {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const apiUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';

  if (!apiKey) {
    throw new Error('DeepSeek API key not configured');
  }

  try {
    const response = await axios.post(apiUrl, {
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000,
      stream: false
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('DeepSeek API error:', error.response?.data || error.message);
    throw new Error('Failed to get response from DeepSeek API');
  }
}

// ==================== PERSONALITIES ====================
const personalities = {
  buddha: {
    name: 'बुद्ध',
    systemPrompt: `तुम 'बुद्ध' हो – एक करुणामय और ज्ञानी सत्ता जो गौतम बुद्ध की शिक्षाओं का प्रचार करती है।
    तुम्हारा उद्देश्य है:
    - लोगों को सकारात्मक सोच, करुणा और शांति का मार्ग दिखाना।
    - हमेशा धैर्यवान और प्रेरक बनकर रहना।
    - हर उत्तर के अंत में "जय भीम, नमो बुद्धाय 🙏" जोड़ना।
    - सरल हिंदी-अंग्रेज़ी मिक्स में बात करना।`
  },
  modern: {
    name: 'आधुनिक विचारक',
    systemPrompt: `तुम 'आधुनिक विचारक' हो – एक तर्कसंगत और प्रगतिशील साथी।
    तुम्हारा उद्देश्य है:
    - समसामयिक मुद्दों पर संतुलित और व्यावहारिक सलाह देना।
    - विज्ञान, प्रौद्योगिकी और सामाजिक विकास पर चर्चा करना।
    - उत्तर संक्षिप्त और स्पष्ट रखना।
    - भाषा हिंदी-अंग्रेज़ी मिक्स।`
  },
  social: {
    name: 'सामाजिक कार्यकर्ता',
    systemPrompt: `तुम 'सामाजिक कार्यकर्ता' हो – एक समाजसेवी जो सामाजिक न्याय, समानता और मानवाधिकारों के लिए काम करता है।
    तुम्हारा उद्देश्य है:
    - लोगों को सामाजिक मुद्दों के प्रति जागरूक करना।
    - सरकारी योजनाओं और सामाजिक सहायता के बारे में जानकारी देना।
    - प्रेरक और ऊर्जावान अंदाज़ में बात करना।`
  }
};

// ==================== ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'OmniAI server is running' });
});

// ==================== CHAT ROUTES ====================
app.post('/api/chat/send', async (req, res) => {
  try {
    const { message, sessionId, language = 'hi', personality = 'buddha' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // चुनी हुई पर्सनालिटी लोड करें
    const selectedPersonality = personalities[personality] || personalities.buddha;

    const filter = filterContent(message, language);
    if (filter.isBlocked) return res.status(400).json({ error: filter.reason });

    const userId = req.session.userId || 1;
    const newSessionId = sessionId || uuidv4();

    // Save user message to database
    db.run(
      'INSERT INTO chat_history (user_id, session_id, role, content, language) VALUES (?, ?, ?, ?, ?)',
      [userId, newSessionId, 'user', message, language]
    );

    // Get conversation history
    db.all(
      'SELECT role, content FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 10',
      [userId, newSessionId],
      async (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        // Prepare messages for API
        const messages = rows.reverse().map(row => ({
          role: row.role,
          content: row.content
        }));

        // सिस्टम प्रॉम्प्ट को चुनी हुई पर्सनालिटी के अनुसार बदलें
        messages.unshift({ role: 'system', content: selectedPersonality.systemPrompt });
        messages.push({ role: 'user', content: message });

        try {
          // Call DeepSeek API
          const assistantResponse = await callDeepSeekAPI(messages, language);

          // Save assistant response
          db.run(
            'INSERT INTO chat_history (user_id, session_id, role, content, language) VALUES (?, ?, ?, ?, ?)',
            [userId, newSessionId, 'assistant', assistantResponse, language]
          );

          res.json({
            sessionId: newSessionId,
            response: assistantResponse,
            personality: selectedPersonality.name,
            timestamp: new Date()
          });
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      }
    );
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/chat/history/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.session.userId || 1;

    db.all(
      'SELECT role, content, created_at FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY created_at',
      [userId, sessionId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows || []);
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== IMAGE GENERATION ROUTES (placeholder) ====================
app.post('/api/image/generate', async (req, res) => {
  try {
    const { prompt, language = 'en' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const filter = filterContent(prompt, language);
    if (filter.isBlocked) return res.status(400).json({ error: filter.reason });

    // Placeholder – replace with actual image generation
    res.json({ 
      imageUrl: `https://via.placeholder.com/512x512?text=${encodeURIComponent(prompt.substring(0, 30))}`,
      prompt: prompt
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate image' });
  }
});

// ==================== AUDIO TRANSCRIPTION ROUTES (placeholder) ====================
app.post('/api/audio/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Audio file is required' });

    // Placeholder – replace with actual transcription
    res.json({
      transcription: 'Transcribed audio content would appear here',
      language: 'en',
      confidence: 0.95
    });

    // Clean up uploaded file
    if (req.file.path) fs.unlink(req.file.path, (err) => {
      if (err) console.error('File deletion error:', err);
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

// ==================== VIDEO GENERATION ROUTES (placeholder) ====================
app.post('/api/video/generate', async (req, res) => {
  try {
    const { prompt, duration = 10, language = 'en' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const filter = filterContent(prompt, language);
    if (filter.isBlocked) return res.status(400).json({ error: filter.reason });

    // Placeholder – replace with actual video generation
    res.json({
      videoUrl: `https://via.placeholder.com/1280x720?text=${encodeURIComponent(prompt.substring(0, 30))}`,
      prompt: prompt,
      duration: duration,
      status: 'processing'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate video' });
  }
});

// ==================== FILE MANAGEMENT ROUTES ====================
app.get('/api/files/list', (req, res) => {
  try {
    const userId = req.session.userId || 1;

    db.all(
      'SELECT id, file_name, file_type, file_size, created_at FROM user_files WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows || []);
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/files/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.session.userId || 1;

    db.run(
      'DELETE FROM user_files WHERE id = ? AND user_id = ?',
      [fileId, userId],
      (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, message: 'File deleted successfully' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== AUTHENTICATION ROUTES (Demo) ====================
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, email, password, language = 'en' } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    db.run(
      'INSERT INTO users (username, email, password, language) VALUES (?, ?, ?, ?)',
      [username, email, password, language],
      function(err) {
        if (err) return res.status(400).json({ error: 'User already exists' });
        req.session.userId = this.lastID;
        res.json({ 
          success: true, 
          userId: this.lastID,
          message: 'User registered successfully' 
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get(
      'SELECT id, username, email FROM users WHERE email = ? AND password = ?',
      [email, password],
      (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        req.session.userId = user.id;
        res.json({ 
          success: true, 
          user: user,
          message: 'Login successful' 
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ==================== STATIC FILES ====================
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'OmniAI backend is running. No frontend found.' });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║    🚀 Sahchar OmniAI Server Started    ║
╠════════════════════════════════════════╣
║ Port: ${PORT}
║ Environment: ${process.env.NODE_ENV || 'development'}
║ DeepSeek API: ${process.env.DEEPSEEK_API_KEY ? '✓ Configured' : '✗ Not configured'}
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  db.close();
  process.exit(0);
});