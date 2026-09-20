const http = require('http');
const { WebSocketServer } = require('ws');

// HTTP server for health check and upgrade handling
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'Healthy', timestamp: Date.now() }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  ws.on('message', (message) => {
    console.log('Received:', message.toString());
  });
  ws.send(JSON.stringify({ type: 'connected', message: 'Welcome to the WebSocket server' }));
});

// Proper HTTP Upgrade Handling
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/ws' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
