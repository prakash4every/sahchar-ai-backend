import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

dotenv.config();
const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ HTTP on ${PORT}`));
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (req,res)=> res.send('Sahchar Live v5'));

// --- helpers ---
function pcmToWav(pcm, rate=16000){
  const h=Buffer.alloc(44);
  h.write('RIFF',0); h.writeUInt32LE(36+pcm.length,4); h.write('WAVE',8);
  h.write('fmt ',12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
  h.writeUInt16LE(1,22); h.writeUInt32LE(rate,24); h.writeUInt32LE(rate*2,28);
  h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write('data',36);
  h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}
function calculateRMS(buf){
  let sum=0;
  for(let i=0;i<buf.length;i+=2){
    const s=buf.readInt16LE(i);
    sum+=s*s;
  }
  return Math.sqrt(sum/(buf.length/2))/32768;
}
async function ttsToPcm(text){
  const r=await openai.audio.speech.create({
    model:"tts-1", voice:"nova", input:text, response_format:"pcm"
  });
  return Buffer.from(await r.arrayBuffer());
}

// --- websocket ---
wss.on('connection', (ws)=>{
  console.log('🔌 Connected');
  let audioBuffer=[]; let isProcessing=false; let isBotSpeaking=false;
  let stopTTS=false; let silenceTimer=null;

  const history=[{role:'system',content:'तुम SuperSahchar हो। यूज़र हिंदी या English बोलेगा, उसी भाषा में छोटा जवाब दो।'}];
  const safeSend=(d)=>{try{ws.readyState===1&&ws.send(d)}catch{}};

  function resetSilence(){
    if(silenceTimer) clearTimeout(silenceTimer);
    silenceTimer=setTimeout(()=>{ if(audioBuffer.length>0) processAudio(); }, 800); // 0.8s
  }

  async function processAudio(){
    if(isProcessing) return;
    isProcessing=true;
    const full=Buffer.concat(audioBuffer); audioBuffer=[];
    const rms=calculateRMS(full);
    console.log(`🎤 Audio: ${full.length} bytes, RMS=${rms.toFixed(4)}`);

    if(rms<0.003 || full.length<3200){ // threshold कम
      console.log('⚠️ Too quiet, skip');
      isProcessing=false; return;
    }
    if(isBotSpeaking){ stopTTS=true; isBotSpeaking=false; }

    const wav=pcmToWav(full,16000);
    const tmp=path.join('/tmp',`a_${randomUUID()}.wav`);
    fs.writeFileSync(tmp,wav);

    try{
      const tr=await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: 'whisper-1',
        // language हटाया - auto detect
        prompt: 'User speaks Hindi or English. Common: good morning, hello, कैसे हो'
      });
      const text=(tr.text||'').trim();
      if(!text){ isProcessing=false; return; }
      console.log(`📝 ${text}`);
      safeSend(JSON.stringify({type:'user_text',text}));

      history.push({role:'user',content:text});
      if(history.length>11) history.splice(1,2);
      const comp=await openai.chat.completions.create({
        model:'gpt-4o-mini', messages:history, max_tokens:150, temperature:0.7
      });
      const reply=comp.choices[0].message.content;
      console.log(`🤖 ${reply}`);
      history.push({role:'assistant',content:reply});
      safeSend(JSON.stringify({type:'bot_text',text:reply}));
      await new Promise(r=>setTimeout(r,100)); // UI update

      // TTS stream - slower for Render
      isBotSpeaking=true; stopTTS=false;
      const pcm=await ttsToPcm(reply);
      const CHUNK=480; // 10ms @24k
      for(let i=0;i<pcm.length;i+=CHUNK){
        if(stopTTS || ws.readyState!==1) break;
        safeSend(pcm.subarray(i,i+CHUNK));
        await new Promise(r=>setTimeout(r,35));
      }
      console.log(`🔊 Sent ${pcm.length} bytes TTS`);
      isBotSpeaking=false;
      safeSend(JSON.stringify({type:'status',text:'ready'}));
    }catch(e){
      console.error('❌',e.message);
    }finally{
      try{fs.unlinkSync(tmp)}catch{}
      isProcessing=false;
    }
  }

  ws.on('message', (data, isBinary)=>{
    if(!isBinary){
      try{
        const j=JSON.parse(data.toString());
        if(j.type==='barge-in'){
          stopTTS=true; isBotSpeaking=false;
          console.log('🔴 Barge-in');
          safeSend(JSON.stringify({type:'barge-in-ack'}));
        }
      }catch{}
      return;
    }
    audioBuffer.push(Buffer.from(data));
    resetSilence();
  });

  ws.on('close',()=>{ console.log('🔌 Disconnected'); if(silenceTimer) clearTimeout(silenceTimer); });
});
