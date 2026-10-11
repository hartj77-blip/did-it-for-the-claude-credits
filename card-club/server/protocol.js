// Message handling shared by the Node server and the in-browser host.
// A "connection" is anything with { player, roomCode, readyState, send(string) }:
// a WebSocket on the server, or a WebRTC data channel / local loopback in the browser.
const crypto = require('crypto');

const MAX_MESSAGE = 8 * 1024;

function send(conn, obj) {
  if (conn.readyState === 1) conn.send(JSON.stringify(obj));
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  if (!n) throw new Error('Pick a name first');
  return n;
}

// idFromToken: turns the browser's secret token into its public player id.
// fixedCode:   (browser host) the one room code this host serves.
// canCreate:   whether a connection may create rooms.
function createHandler(rooms, { idFromToken, fixedCode = null, canCreate = () => true }) {
  function handle(conn, msg) {
    if (msg.t === 'hello') {
      const token = typeof msg.token === 'string' && msg.token.length >= 16
        ? msg.token.slice(0, 64)
        : crypto.randomBytes(16).toString('hex');
      // The token stays secret in the browser; the public id is derived from it,
      // so the same browser gets its seat back after a reload or restart.
      const id = idFromToken(token);
      conn.player = { id, name: msg.name ? cleanName(msg.name) : null };
      send(conn, { t: 'welcome', id, token });
      return;
    }
    if (!conn.player) throw new Error('Say hello first');

    switch (msg.t) {
      case 'create': {
        if (!canCreate(conn)) throw new Error("You can't create rooms here");
        conn.player.name = cleanName(msg.name || conn.player.name);
        if (conn.roomCode) rooms.leave(conn.roomCode, conn);
        const room = fixedCode && rooms.rooms.has(fixedCode) ? rooms.rooms.get(fixedCode) : rooms.create(conn.player, fixedCode);
        rooms.join(room.code, conn);
        return;
      }
      case 'join': {
        conn.player.name = cleanName(msg.name || conn.player.name);
        const code = String(msg.code || '').toUpperCase().trim();
        if (conn.roomCode && conn.roomCode !== code) rooms.leave(conn.roomCode, conn);
        rooms.join(code, conn);
        return;
      }
      case 'leave':
        if (conn.roomCode) rooms.leave(conn.roomCode, conn);
        send(conn, { t: 'left' });
        return;
      default:
        if (!conn.roomCode) throw new Error('Join a room first');
        rooms.command(conn.roomCode, conn, msg);
    }
  }

  // Entry point for a raw incoming message.
  return function onMessage(conn, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(conn, msg);
    } catch (e) {
      send(conn, { t: 'error', msg: e.message || 'Something went wrong' });
    }
  };
}

module.exports = { createHandler, cleanName, send };
