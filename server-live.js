import { WebSocketServer } from 'ws';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`✅ Echo server on ${PORT}`));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('🔌 Client connected (echo mode)');
    ws.on('message', (data) => {
        // Just send back the same audio chunk
        ws.send(data);
    });
    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: code=${code}, reason=${reason?.toString() || 'none'}`);
    });
});
