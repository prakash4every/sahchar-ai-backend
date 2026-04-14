// server-live.js me ye change karo

let audioBuffer = [];
let isProcessing = false;
let isBotSpeaking = false;
let botSpeakingEndTime = 0; // Naya variable
let silenceTimer = null;
let isClosed = false;

async function speak(sentence) {
    if (!sentence.trim() || isClosed) return;
    isBotSpeaking = true; // Bot bolna start
    console.log(`🔊 TTS: ${sentence}`);
    try {
        const mp3Stream = await ttsStream(sentence);
        const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);
        console.log(`🔊 PCM converted: ${pcmBuffer.length} bytes`);

        const CHUNK_SIZE = 640;
        let sentBytes = 0;
        const startTime = Date.now();

        for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
            if (isClosed || ws.readyState!== ws.OPEN) break;
            const chunk = pcmBuffer.slice(i, i + CHUNK_SIZE);
            ws.send(chunk);
            sentBytes += chunk.length;

            const expectedTime = (sentBytes / (16000 * 2)) * 1000;
            const elapsedTime = Date.now() - startTime;
            const waitTime = Math.max(0, expectedTime - elapsedTime);
            if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }
        console.log('🔊 PCM sent to client complete');
    } catch (err) {
        console.error('❌ TTS error:', err.message);
    } finally {
        // FIX: Bot bolna khatam hone ke 300ms baad mic chalu karo
        botSpeakingEndTime = Date.now() + 300;
        setTimeout(() => {
            isBotSpeaking = false;
            console.log('🎤 Mic unmuted after bot finished');
        }, 300);
    }
}

async function processAudio() {
    if (audioBuffer.length === 0 || isProcessing || isClosed) return;

    // FIX: Bot ke bolne ke 300ms baad tak ka audio ignore karo - echo avoid
    if (Date.now() < botSpeakingEndTime) {
        console.log('⚠️ Dropping audio - bot just finished speaking');
        audioBuffer = [];
        return;
    }

    isProcessing = true;

        let totalBytes = 0;
        let chunksToSend = [];
        for (const chunk of audioBuffer) {
            if (totalBytes + chunk.length <= MAX_CHUNK_BYTES) {
                chunksToSend.push(chunk);
                totalBytes += chunk.length;
            } else {
                const remaining = MAX_CHUNK_BYTES - totalBytes;
                if (remaining > 0) chunksToSend.push(chunk.slice(0, remaining));
                break;
            }
        }

        // FIX 3: Min 0.5 sec audio chahiye + RMS check
        if (totalBytes < MIN_SPEECH_BYTES) {
            console.log(`⚠️ Audio too short: ${totalBytes} bytes, ignoring`);
            audioBuffer = [];
            isProcessing = false;
            return;
        }

        const fullAudio = Buffer.concat(chunksToSend, totalBytes);

        // FIX 4: RMS check - agar awaaz bahut dheemi hai to ignore
        const rms = calculateRMS(fullAudio);
        if (rms < 0.01) { // -40dB se kam
            console.log(`⚠️ Audio too quiet RMS=${rms.toFixed(4)}, ignoring noise`);
            audioBuffer = [];
            isProcessing = false;
            return;
        }

        let processedBytes = 0;
        const newBuffer = [];
        for (const chunk of audioBuffer) {
            if (processedBytes + chunk.length <= totalBytes) {
                processedBytes += chunk.length;
                continue;
            } else {
                const remaining = chunk.length - (totalBytes - processedBytes);
                if (remaining > 0) newBuffer.push(chunk.slice(-remaining));
                break;
            }
        }
        audioBuffer = newBuffer;

        const wavBuffer = pcmToWav(fullAudio, SAMPLE_RATE, 1, 16);

        try {
            const audioStream = await bufferToReadableStream(wavBuffer);
            const response = await groqClient.audio.transcriptions.create({
                file: audioStream,
                model: 'whisper-large-v3',
                language: 'hi',
                response_format: 'text',
                temperature: 0,
            });
            const transcript = response.trim();

            // FIX 5: Strong blacklist
            const badWords = [
                'हाँ', 'हम्म', 'अच्छा', 'Mumbai', 'Subscribe', 'Thank you', 'okay',
                'झाल', 'कुण', 'ओ', 'आ', 'हाई', 'अहाँ', 'मदद', 'पूछ', 'धन्यवाद',
                'Hello', 'Hi', 'Yes', 'No', 'OK'
            ];

            if (!transcript || transcript.length < 3 || badWords.some(w => transcript.includes(w))) {
                console.log(`⚠️ Ignoring bad transcript: "${transcript}"`);
                isProcessing = false;
                return;
            }

            console.log(`📝 Transcript: ${transcript}`);

            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'user_text', text: transcript }));
            }

            if (!isBotSpeaking &&!isClosed) {
                isBotSpeaking = true;
                await sendToLLM(transcript);
            }
        } catch (err) {
            console.error('❌ Groq error:', err.message);
        } finally {
            isProcessing = false;
            if (audioBuffer.length > 0 &&!isClosed) processAudio();
        }
    }

    async function sendToLLM(text) {
        if (isClosed) return;
        console.log(`🤖 LLM: ${text}`);

        const history = sessionHistories.get(sessionId);
        history.push({ role: 'user', content: text });
        if (history.length > 7) history.splice(1, history.length - 7);

        try {
            const fullReply = await callNvidiaWithFallback(history);
            if (fullReply) history.push({ role: 'assistant', content: fullReply });

            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'bot_text', text: fullReply }));
            }

            if (db) {
                db.collection('conversations').insertOne({
                    sessionId: deviceId,
                    userMessage: text,
                    botReply: fullReply,
                    timestamp: new Date()
                }).catch(e => console.error("MongoDB insert error:", e));
            }

            const sentences = fullReply.match(/[^।!?]+[।!?]?/g) || [fullReply];
            for (const sentence of sentences) {
                if (isClosed) break;
                await speak(sentence.trim());
            }
        } catch (err) {
            console.error('❌ LLM error:', err.message);
            if (!isClosed) await speak('मुझे समझ नहीं आया।');
        } finally {
            isBotSpeaking = false;
        }
    }

    async function speak(sentence) {
        if (!sentence.trim() || isClosed) return;
        console.log(`🔊 TTS: ${sentence}`);
        try {
            const mp3Stream = await ttsStream(sentence);
            const pcmBuffer = await convertMp3StreamToPcm16k(mp3Stream);
            console.log(`🔊 PCM converted: ${pcmBuffer.length} bytes`);

            const CHUNK_SIZE = 640;
            let sentBytes = 0;
            const startTime = Date.now();

            for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
                if (isClosed || ws.readyState!== ws.OPEN) break;
                const chunk = pcmBuffer.slice(i, i + CHUNK_SIZE);
                ws.send(chunk);
                sentBytes += chunk.length;

                const expectedTime = (sentBytes / (16000 * 2)) * 1000;
                const elapsedTime = Date.now() - startTime;
                const waitTime = Math.max(0, expectedTime - elapsedTime);
                if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
            }
            console.log('🔊 PCM sent to client complete');
        } catch (err) {
            console.error('❌ TTS error:', err.message);
        }
    }

    ws.on('message', (data) => {
        if (isClosed) return;
        const chunk = Buffer.isBuffer(data)? data : Buffer.from(data);
        audioBuffer.push(chunk);
        resetSilenceTimer();
        checkMaxDuration();
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: ${sessionId}, code=${code}, reason=${reason?.toString() || 'none'}`);
        isClosed = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        audioBuffer = [];
        setTimeout(() => sessionHistories.delete(sessionId), 5 * 60 * 1000);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        isClosed = true;
    });
});
