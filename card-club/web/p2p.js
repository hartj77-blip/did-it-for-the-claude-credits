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


  // ---------- voice chat ----------
  // Audio is routed through the host's tab: each player sends their mic to the host,
  // and the host forwards every other player's audio back out. Only host<->player
  // connections are used, the same ones the game already relies on (players never
  // need a direct connection to each other, which some networks block).
  const voice = {
    joined: false,
    muted: false,
    local: null, // our mic MediaStream
    myId: null,
    roster: [], // [{ id, muted }] from the host
    speaking: new Set(),
    remotes: new Map(), // player id -> { audio, meter }
    listeners: [],
    blocked: false, // browser refused to autoplay audio until the next tap
  };
  const voiceState = () => ({
    joined: voice.joined,
    muted: voice.muted,
    roster: voice.roster,
    speaking: [...voice.speaking],
    blocked: voice.blocked,
  });
  const emitVoice = (kind = 'change') => voice.listeners.forEach((fn) => fn(voiceState(), kind));

  let audioCtx = null;
  const meters = new Map(); // id -> { analyser, buf, source, lastLoud }
  let meterTimer = null;
  function addMeter(id, stream) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      meters.set(id, { analyser, source, buf: new Uint8Array(analyser.fftSize), lastLoud: 0 });
    } catch {}
    if (!meterTimer) meterTimer = setInterval(pollMeters, 150);
  }
  function removeMeter(id) {
    const m = meters.get(id);
    if (m) { try { m.source.disconnect(); } catch {} meters.delete(id); }
    if (voice.speaking.delete(id)) emitVoice('speaking');
    if (!meters.size && meterTimer) { clearInterval(meterTimer); meterTimer = null; }
  }
  function pollMeters() {
    const now = Date.now();
    let changed = false;
    for (const [id, m] of meters) {
      m.analyser.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (const v of m.buf) sum += (v - 128) * (v - 128);
      const rms = Math.sqrt(sum / m.buf.length) / 128;
      const mutedSelf = id === voice.myId && voice.muted;
      if (rms > 0.03 && !mutedSelf) m.lastLoud = now;
      const talking = now - m.lastLoud < 350;
      if (talking !== voice.speaking.has(id)) {
        if (talking) voice.speaking.add(id); else voice.speaking.delete(id);
        changed = true;
      }
    }
    if (changed) emitVoice('speaking');
  }

  function playRemote(id, stream) {
    removeRemote(id);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.srcObject = stream;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audio.play().catch(() => { voice.blocked = true; emitVoice(); });
    voice.remotes.set(id, { audio });
    addMeter(id, stream);
  }
  function removeRemote(id) {
    const r = voice.remotes.get(id);
    if (!r) return;
    r.audio.srcObject = null;
    r.audio.remove();
    voice.remotes.delete(id);
    removeMeter(id);
  }
  function removeAllRemotes() { [...voice.remotes.keys()].forEach(removeRemote); }

  function onRoster(users) {
    voice.roster = users;
    const ids = new Set(users.map((u) => u.id));
    for (const id of [...voice.remotes.keys()]) if (!ids.has(id)) removeRemote(id);
    emitVoice();
  }

  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't use the microphone here.");
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      throw new Error(e && e.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow it in your browser settings to use voice chat.'
        : "Couldn't access a microphone.");
    }
  }

  // The host's hub: who is in voice and which forwarding calls exist.
  let hub = null;

  async function voiceJoin(myId) {
    if (voice.joined) return;
    if (!hosting && !guest) throw new Error('Join a room first');
    // Resume audio inside the click that started voice, so phones allow playback.
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); } catch {}
    voice.local = await getMic();
    voice.myId = myId;
    voice.joined = true;
    voice.muted = false;
    addMeter(myId, voice.local);
    if (hosting) hub.add(myId, null, voice.local, null);
    else callHost();
    emitVoice();
  }

  function voiceLeave() {
    if (!voice.joined) return;
    if (hosting) hub.remove(voice.myId);
    else {
      if (guest && guest.micCall) { try { guest.micCall.close(); } catch {} guest.micCall = null; }
      sendToHost({ t: 'voice', op: 'leave' });
    }
    if (voice.local) voice.local.getTracks().forEach((tr) => tr.stop());
    removeMeter(voice.myId);
    voice.local = null;
    voice.joined = false;
    voice.muted = false;
    removeAllRemotes();
    emitVoice();
  }

  function voiceMute(muted) {
    if (!voice.joined) return;
    voice.muted = !!muted;
    voice.local.getAudioTracks().forEach((tr) => { tr.enabled = !voice.muted; });
    if (hosting) hub.setMuted(voice.myId, voice.muted);
    else sendToHost({ t: 'voice', op: 'mute', muted: voice.muted });
    emitVoice();
  }

  function voiceUnlock() {
    voice.blocked = false;
    for (const r of voice.remotes.values()) r.audio.play().catch(() => { voice.blocked = true; });
    if (audioCtx) audioCtx.resume().catch(() => {});
    emitVoice();
  }

  function makeHub(peer) {
    const users = new Map(); // id -> { id, peerId (null = host), stream, inCall, muted, out: Map(srcId -> call) }
    const conns = new Map(); // remote peer id -> game connection
    const closeCall = (c) => { try { c && c.close(); } catch {} };

    // Deliver one player's audio to one listener.
    function deliver(dst, srcId, stream) {
      if (!dst.peerId) { if (srcId !== dst.id) playRemote(srcId, stream); return; }
      const call = peer.call(dst.peerId, stream, { metadata: { from: srcId } });
      dst.out.set(srcId, call);
    }
    function roster() {
      const list = [...users.values()].map((u) => ({ id: u.id, muted: u.muted }));
      const msg = JSON.stringify({ t: 'voiceRoster', users: list });
      for (const c of conns.values()) c.send(msg);
      onRoster(list);
    }
    function add(id, peerId, stream, inCall) {
      remove(id, true);
      const u = { id, peerId, stream, inCall, muted: false, out: new Map() };
      for (const other of users.values()) {
        deliver(other, id, stream);
        deliver(u, other.id, other.stream);
      }
      users.set(id, u);
      roster();
    }
    function remove(id, quiet) {
      const u = users.get(id);
      if (!u) return;
      users.delete(id);
      closeCall(u.inCall);
      u.out.forEach(closeCall);
      for (const other of users.values()) {
        closeCall(other.out.get(id));
        other.out.delete(id);
      }
      removeRemote(id);
      if (!quiet) roster();
    }
    function setMuted(id, muted) {
      const u = users.get(id);
      if (u) { u.muted = !!muted; roster(); }
    }

    // A player's mic arriving at the host.
    peer.on('call', (call) => {
      const conn = conns.get(call.peer);
      if (!conn || !conn.player || !call.metadata || call.metadata.kind !== 'mic') { closeCall(call); return; }
      const id = conn.player.id;
      call.answer();
      call.on('stream', (stream) => {
        const existing = users.get(id);
        if (existing && existing.inCall === call) return; // same call firing again
        add(id, call.peer, stream, call);
      });
      call.on('close', () => { const u = users.get(id); if (u && u.inCall === call) remove(id); });
      call.on('error', () => { const u = users.get(id); if (u && u.inCall === call) remove(id); });
    });

    return {
      add,
      remove,
      setMuted,
      connOpened(peerId, conn) {
        conns.set(peerId, conn);
        if (users.size) conn.send(JSON.stringify({ t: 'voiceRoster', users: [...users.values()].map((u) => ({ id: u.id, muted: u.muted })) }));
      },
      connClosed(peerId, conn) {
        conns.delete(peerId);
        if (conn.player) remove(conn.player.id);
      },
      message(conn, msg) {
        if (!conn.player) return;
        if (msg.op === 'leave') remove(conn.player.id);
        else if (msg.op === 'mute') setMuted(conn.player.id, msg.muted);
      },
      closeAll() { [...users.keys()].forEach((id) => remove(id, true)); },
    };
  }

  // Guest side: the current connection to the host.
  let guest = null; // { peer, dc, hostId, micCall }
  function sendToHost(obj) {
    if (guest && guest.dc && guest.dc.open) { try { guest.dc.send(JSON.stringify(obj)); } catch {} }
  }
  function callHost() {
    if (!guest || !voice.local) return;
    guest.micCall = guest.peer.call(guest.hostId, voice.local, { metadata: { kind: 'mic' } });
    if (voice.muted) sendToHost({ t: 'voice', op: 'mute', muted: true });
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

    hub = makeHub(peer);
    const room = () => rooms.rooms.get(code);
    const note = (text) => { const r = room(); if (r) { rooms.system(r, text); rooms.touch(r); } };

    peer.on('connection', (dc) => {
      // If the direct connection never opens, tell the host so a silent failure is visible.
      const watchdog = setTimeout(() => {
        if (!dc.open) note('Someone tried to join but couldn\'t connect. One of your networks may be blocking it; switching between Wi-Fi and mobile data often helps.');
      }, 25000);
      const conn = {
        player: null,
        roomCode: null,
        isLocal: false,
        get readyState() { return dc.open ? 1 : 3; },
        send(s) { try { dc.send(s); } catch {} },
      };
      dc.on('open', () => { clearTimeout(watchdog); hub.connOpened(dc.peer, conn); });
      dc.on('data', (d) => {
        // Voice control messages are handled here; everything else goes to the game engine.
        if (typeof d === 'string' && d.startsWith('{"t":"voice"')) {
          try { hub.message(conn, JSON.parse(d)); } catch {}
          return;
        }
        onMessage(conn, d);
      });
      let closed = false;
      const gone = () => {
        if (closed) return;
        closed = true;
        hub.connClosed(dc.peer, conn);
        if (conn.roomCode) rooms.disconnect(conn.roomCode, conn);
        conn.roomCode = null;
      };
      dc.on('close', gone);
      dc.on('error', gone);
    });
    // Losing the matchmaking server doesn't drop existing players, but new ones
    // can't find the room until we re-register. Phones drop it whenever the tab is
    // backgrounded, so also retry as soon as the page is visible again.
    const reconnect = () => {
      if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch {} }
    };
    peer.on('disconnected', () => { setStatus(); setTimeout(reconnect, 1500); });
    peer.on('open', () => setStatus());
    peer.on('error', (err) => { console.warn('PeerJS:', err.type, err.message); setStatus(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });
    const timer = setInterval(() => { if (peer.destroyed) clearInterval(timer); else { reconnect(); setStatus(); } }, 5000);
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
    setStatus();
    setTimeout(() => t._open(), 0);
    return { transport: t, code, resumed: rooms.rooms.has(code) };
  }

  // Is the room currently findable by new players?
  let lastOnline = null;
  const statusListeners = [];
  function setStatus() {
    const online = !!(hosting && !hosting.peer.destroyed && !hosting.peer.disconnected);
    if (online === lastOnline) return;
    lastOnline = online;
    statusListeners.forEach((fn) => fn(online));
  }

  function stopHosting() {
    if (!hosting) return;
    voiceLeave();
    hub.closeAll();
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
      if (guest && guest.peer === peer) { guest = null; removeAllRemotes(); }
      clearTimeout(timer);
      t._closed(reason);
      try { peer.destroy(); } catch {}
    };
    // Stages tell the UI what went wrong: never reached the matchmaking server,
    // host not registered (room closed / tab asleep), or found but couldn't connect.
    let stage = 'signaling';
    const timer = setTimeout(() => fail(stage === 'signaling' ? 'no-signaling' : 'blocked'), 20000);
    t.close = () => fail('closed');

    const hostId = PREFIX + code;
    // Forwarded voice from the host (one call per other player in voice).
    peer.on('call', (call) => {
      if (call.peer !== hostId || !voice.joined) { try { call.close(); } catch {} return; }
      const from = call.metadata && call.metadata.from;
      call.answer();
      call.on('stream', (stream) => playRemote(from, stream));
    });

    peer.on('open', () => {
      stage = 'connecting';
      const dc = peer.connect(hostId, { reliable: true });
      dc.on('open', () => {
        clearTimeout(timer);
        guest = { peer, dc, hostId, micCall: null };
        t._send = (s) => { try { dc.send(s); } catch {} };
        t._open();
        if (voice.joined) callHost(); // back after a reconnect: rejoin voice
      });
      dc.on('data', (d) => {
        if (typeof d === 'string' && d.startsWith('{"t":"voiceRoster"')) {
          try { onRoster(JSON.parse(d).users); } catch {}
          return;
        }
        t._deliver(d);
      });
      dc.on('close', () => fail('closed'));
      dc.on('error', () => fail('closed'));
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') fail('unreachable');
      else if (stage !== 'signaling' && (err.type === 'disconnected' || err.type === 'network')) { /* signaling hiccup; data channel may be fine */ }
      else if (stage === 'signaling') fail('no-signaling');
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
    hostOnline: () => !!lastOnline,
    onHostStatus: (fn) => statusListeners.push(fn),
    voiceSupported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection),
    voiceJoin,
    voiceLeave,
    voiceMute,
    voiceUnlock,
    voiceState,
    onVoice: (fn) => voice.listeners.push(fn),
    hostingCode: () => (hosting ? hosting.code : null),
    lastHosted: () => {
      const c = store.get(LAST_KEY);
      return c && savedRooms().includes(c) ? c : null;
    },
  };
})();
