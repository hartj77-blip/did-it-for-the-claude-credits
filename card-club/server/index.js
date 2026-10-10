// Card Club server: static files + a WebSocket per player.
// The server is authoritative: clients send intents, the server runs the rules
// and sends each player a personalised view (so nobody can see other hands).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Rooms } = require('./rooms');

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

const rooms = new Rooms({ dataFile: path.join(DATA_DIR, 'rooms.json') });
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.player = null; // { id, name }
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      send(ws, { t: 'error', msg: e.message || 'Something went wrong' });
    }
  });

  ws.on('close', () => {
    if (ws.roomCode) rooms.disconnect(ws.roomCode, ws);
  });
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  if (!n) throw new Error('Pick a name first');
  return n;
}

function handle(ws, msg) {
  if (msg.t === 'hello') {
    const token = typeof msg.token === 'string' && msg.token.length >= 16 ? msg.token.slice(0, 64) : crypto.randomBytes(16).toString('hex');
    // The token stays secret in the browser; the public id is a hash of it,
    // so the same browser gets its seat back after a reload or server restart.
    const id = 'p_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    ws.player = { id, name: msg.name ? cleanName(msg.name) : null };
    send(ws, { t: 'welcome', id, token });
    return;
  }
  if (!ws.player) throw new Error('Say hello first');

  switch (msg.t) {
    case 'create': {
      ws.player.name = cleanName(msg.name || ws.player.name);
      if (ws.roomCode) rooms.leave(ws.roomCode, ws);
      const room = rooms.create(ws.player);
      rooms.join(room.code, ws);
      return;
    }
    case 'join': {
      ws.player.name = cleanName(msg.name || ws.player.name);
      const code = String(msg.code || '').toUpperCase().trim();
      if (ws.roomCode && ws.roomCode !== code) rooms.leave(ws.roomCode, ws);
      rooms.join(code, ws);
      return;
    }
    case 'leave':
      if (ws.roomCode) rooms.leave(ws.roomCode, ws);
      send(ws, { t: 'left' });
      return;
    default:
      if (!ws.roomCode) throw new Error('Join a room first');
      rooms.command(ws.roomCode, ws, msg);
  }
}

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
