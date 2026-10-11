// Card Club server: static files + a WebSocket per player.
// The server is authoritative: clients send intents, the server runs the rules
// and sends each player a personalised view (so nobody can see other hands).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Rooms } = require('./rooms');
const { createHandler } = require('./protocol');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const rooms = new Rooms({
  storage: {
    load() {
      try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    save(data) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    },
  },
});
const onMessage = createHandler(rooms, {
  idFromToken: (token) => 'p_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16),
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.player = null; // { id, name }
  ws.roomCode = null;
  ws.on('message', (raw) => onMessage(ws, raw.toString()));
  ws.on('close', () => {
    if (ws.roomCode) rooms.disconnect(ws.roomCode, ws);
  });
});

// Drop dead connections so players show as disconnected promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`Card Club running on http://localhost:${PORT}`);
});

function shutdown() {
  rooms.saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
