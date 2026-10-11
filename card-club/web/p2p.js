// Peer-to-peer mode for the static (GitHub Pages) build.
// The player who creates a room runs the whole game engine in their own tab;
// everyone else connects straight to that tab over WebRTC, using the free PeerJS
// cloud to find each other. Both sides get a "transport" with the same shape as a
// WebSocket (send / onopen / onmessage / onclose / readyState), so app.js barely cares.
(() => {
  'use strict';

  const PREFIX = 'cardclub-v1-';
  const STORE_KEY = 'cc_host_rooms';
  const LAST_KEY = 'cc_last_hosted';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Developer hook: when served from localhost, ?peerServer=localhost:9000 uses a local
  // PeerJS server instead of the public one. Ignored on any real domain.
  function peerOptions() {
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    let override = null;
    try {
      override = new URLSearchParams(location.search).get('peerServer') || sessionStorage.getItem('cc_peer_server');
      if (override && isLocal) sessionStorage.setItem('cc_peer_server', override);
    } catch {}
    if (!override || !isLocal) return { debug: 1 };
    const [host, port] = override.split(':');
    return { debug: 1, host, port: Number(port) || 9000, path: '/', secure: false, config: { iceServers: [] } };
  }

  function randomCode() {
    const buf = crypto.getRandomValues(new Uint32Array(4));
    return Array.from(buf, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }

  // Public player id from the secret token (the host already sees tokens, so this
  // only needs to be stable and not reveal the token to other players).
  function hash53(str, seed) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  const idFromToken = (t) => 'p_' + hash53(t, 1).toString(16).padStart(14, '0') + hash53(t, 2).toString(16).slice(-2);

  function makeTransport() {
    const t = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      reason: null,
      _send: () => {},
      send(s) { if (t.readyState === 1) t._send(s); },
      close() { t._closed('closed'); },
      _open() { t.readyState = 1; if (t.onopen) t.onopen(); },
      _deliver(s) { if (t.readyState === 1 && t.onmessage) t.onmessage({ data: s }); },
      _closed(reason) {
        if (t.readyState === 3) return;
        t.readyState = 3;
        t.reason = reason;
        if (t.onclose) t.onclose({ reason });
      },
    };
    return t;
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, peerOptions());
      const onError = (err) => { peer.destroy(); reject(err); };
      peer.once('open', () => { peer.off('error', onError); resolve(peer); });
      peer.once('error', onError);
    });
  }

  function friendly(err) {
    const map = {
      'browser-incompatible': "This browser doesn't support peer-to-peer connections. Try Chrome, Safari, Firefox or Edge.",
      network: "Couldn't reach the matchmaking server. Check your internet connection.",
      'server-error': "Couldn't reach the matchmaking server. Try again in a moment.",
      'socket-error': "Couldn't reach the matchmaking server. Check your internet connection.",
    };
    return new Error(map[err.type] || err.message || 'Connection failed');
  }

  // ---------- hosting ----------
  let hosting = null; // { peer, rooms, code }

  async function host(existingCode) {
    if (hosting) throw new Error('Already hosting a room in this tab');
    let code = existingCode;
    let peer;
    for (let attempt = 1; ; attempt++) {
      if (!code) code = randomCode();
      try {
        peer = await openPeer(PREFIX + code);
        break;
      } catch (err) {
        if (err.type !== 'unavailable-id' || attempt >= 6) {
          if (err.type === 'unavailable-id') {
            throw new Error(existingCode
              ? `Room ${existingCode} is already open somewhere else (another tab or device?).`
              : 'Could not reserve a room code. Try again.');
          }
          throw friendly(err);
        }
        // A brand-new room just picks another code. Reopening the same room after a
        // reload can briefly collide with the old tab's registration, so wait it out.
        if (existingCode) await sleep(2500); else code = null;
      }
    }

    const engine = window.CardClubEngine;
    const rooms = new engine.Rooms({
      storage: {
        load() { const s = store.get(STORE_KEY); return s ? JSON.parse(s) : null; },
        save(data) { store.set(STORE_KEY, JSON.stringify(data)); },
      },
    });
    const onMessage = engine.createHandler(rooms, {
      idFromToken,
      fixedCode: code,
      canCreate: (conn) => conn.isLocal,
    });

    peer.on('connection', (dc) => {
      const conn = {
        player: null,
        roomCode: null,
        isLocal: false,
        get readyState() { return dc.open ? 1 : 3; },
        send(s) { try { dc.send(s); } catch {} },
      };
      dc.on('data', (d) => onMessage(conn, d));
      const gone = () => {
        if (conn.roomCode) rooms.disconnect(conn.roomCode, conn);
        conn.roomCode = null;
      };
      dc.on('close', gone);
      dc.on('error', gone);
    });
    // Losing the matchmaking server doesn't drop existing players, but new ones
    // can't find us until we re-register.
    peer.on('disconnected', () => {
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('error', (err) => console.warn('PeerJS:', err.type, err.message));
    window.addEventListener('pagehide', () => rooms.saveNow());
    store.set(LAST_KEY, code);

    // The host's own client talks to the engine through a loopback transport.
    const t = makeTransport();
    const conn = {
      player: null,
      roomCode: null,
      isLocal: true,
      readyState: 1,
      send(s) { setTimeout(() => t._deliver(s), 0); },
    };
    t._send = (s) => setTimeout(() => onMessage(conn, s), 0);
    hosting = { peer, rooms, code };
    setTimeout(() => t._open(), 0);
    return { transport: t, code, resumed: rooms.rooms.has(code) };
  }

  function stopHosting() {
    if (!hosting) return;
    hosting.rooms.saveNow();
    hosting.peer.destroy();
    hosting = null;
  }

  // ---------- joining ----------
  function join(code) {
    const t = makeTransport();
    const peer = new Peer(peerOptions());
    let done = false;
    const fail = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      t._closed(reason);
      try { peer.destroy(); } catch {}
    };
    const timer = setTimeout(() => fail('unreachable'), 20000);
    t.close = () => fail('closed');

    peer.on('open', () => {
      const dc = peer.connect(PREFIX + code, { reliable: true });
      dc.on('open', () => {
        clearTimeout(timer);
        t._send = (s) => { try { dc.send(s); } catch {} };
        t._open();
      });
      dc.on('data', (d) => t._deliver(d));
      dc.on('close', () => fail('closed'));
      dc.on('error', () => fail('closed'));
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') fail('unreachable');
      else if (err.type === 'disconnected' || err.type === 'network') { /* signaling hiccup; data channel may be fine */ }
      else fail(friendly(err).message);
    });
    return t;
  }

  function savedRooms() {
    try {
      const data = JSON.parse(store.get(STORE_KEY) || 'null');
      return data ? data.rooms.map((r) => r.code) : [];
    } catch { return []; }
  }

  window.CardClubP2P = {
    host,
    join,
    stopHosting,
    isHosting: () => !!hosting,
    hostingCode: () => (hosting ? hosting.code : null),
    lastHosted: () => {
      const c = store.get(LAST_KEY);
      return c && savedRooms().includes(c) ? c : null;
    },
  };
})();
