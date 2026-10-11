// Card Club client. The server sends a full personalised room snapshot on every change;
// we re-render from it. User intents go back as small messages.
(() => {
  'use strict';

  // ---------- state ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const S = {
    ws: null,
    connected: false,
    me: null,
    token: store.get('cc_token'),
    name: store.get('cc_name') || '',
    room: null,
    wantRoom: new URLSearchParams(location.search).get('room'),
    tab: 'players',
    unread: 0,
    lastChatCount: 0,
    wasMyTurn: false,
    sound: store.get('cc_sound') !== 'off',
    retry: 0,
    status: null, // connecting/hosting message shown on the landing page
    error: null, // why the last join attempt failed (shown until the next attempt)
    ui: { raiseTo: null, raiseKey: '', bet: 0, selected: null, pendingStage: false },
  };
  if (S.wantRoom) S.wantRoom = S.wantRoom.toUpperCase();

  const $app = document.getElementById('app');
  const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;

  // ---------- connection ----------
  // Two ways to reach the game engine:
  //  - server mode: a WebSocket to the Node server that served this page
  //  - p2p mode (GitHub Pages build): the room creator's tab runs the engine and
  //    friends connect to it via WebRTC (see web/p2p.js)
  const P2P = window.CARD_CLUB_MODE === 'p2p' ? window.CardClubP2P : null;

  function attach(t, onWelcome, onClose) {
    S.ws = t;
    t.onopen = () => {
      S.connected = true;
      S.retry = 0;
      S.status = null;
      renderTopbar();
      send({ t: 'hello', token: S.token, name: S.name || undefined });
    };
    t.onmessage = (e) => handleMessage(JSON.parse(e.data), onWelcome);
    t.onclose = (e) => {
      if (S.ws !== t) return; // a transport we already replaced
      S.connected = false;
      renderTopbar();
      onClose(e || {});
    };
  }

  function handleMessage(msg, onWelcome) {
    if (msg.t === 'welcome') {
      S.me = msg.id;
      S.token = msg.token;
      store.set('cc_token', msg.token);
      onWelcome();
    } else if (msg.t === 'room') {
      onRoom(msg.room);
    } else if (msg.t === 'left') {
      S.room = null;
      S.wantRoom = null;
      history.replaceState(null, '', location.pathname);
      if (msg.kicked) toast('The host removed you from the room');
      if (P2P && S.ws) { const t = S.ws; S.ws = null; t.close(); }
      render();
    } else if (msg.t === 'error') {
      toast(msg.msg);
      if (!S.room && S.wantRoom && /No room/.test(msg.msg)) {
        S.wantRoom = null;
        history.replaceState(null, '', location.pathname);
        render();
      }
    }
  }

  function connectServer() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    attach(ws, () => {
      const code = S.room ? S.room.code : S.wantRoom;
      if (code && S.name) send({ t: 'join', code, name: S.name });
      else render();
    }, () => {
      const delay = Math.min(10000, 500 * 2 ** S.retry++);
      setTimeout(connectServer, delay);
    });
  }

  // P2P: create a new room (code = null) or reopen one this browser hosted before.
  async function hostRoom(code) {
    S.status = code ? `Opening room ${code}…` : 'Setting up your room…';
    render();
    try {
      const { transport, code: c, resumed } = await P2P.host(code);
      attach(transport, () => send(resumed ? { t: 'join', code: c, name: S.name } : { t: 'create', name: S.name }), () => {});
    } catch (e) {
      S.status = null;
      toast(e.message);
      render();
    }
  }

  // P2P: connect to a friend's room. Keeps retrying if we drop out mid-game, and
  // keeps waiting for a few minutes if the host's tab isn't reachable yet (phones
  // pause background tabs, so the host may just need to switch back to it).
  const JOIN_PATIENCE = 3 * 60 * 1000;
  function joinRoom(code, waitingSince = Date.now()) {
    S.wantRoom = code;
    S.error = null;
    S.joinAttempt = (S.joinAttempt || 0) + 1;
    const attempt = S.joinAttempt;
    const waited = Date.now() - waitingSince;
    if (!S.room) {
      S.status = waited < 5000
        ? `Connecting to room ${code}…`
        : `Waiting for the host of room ${code}… Ask them to keep Card Club open on their screen.`;
      render();
    }
    attach(P2P.join(code), () => send({ t: 'join', code, name: S.name }), (e) => {
      if (attempt !== S.joinAttempt) return; // cancelled or superseded
      if (S.room && S.room.code === code) {
        if (S.retry === 0) toast('Lost connection to the host. Reconnecting…');
        const delay = Math.min(10000, 1000 * 2 ** S.retry++);
        setTimeout(() => { if (S.room && S.room.code === code && !S.connected) joinRoom(code); }, delay);
        return;
      }
      if (e.reason === 'unreachable' && Date.now() - waitingSince < JOIN_PATIENCE) {
        setTimeout(() => { if (attempt === S.joinAttempt && !S.room) joinRoom(code, waitingSince); }, 3000);
        return;
      }
      S.status = null;
      S.error = {
        unreachable: `Room ${code} isn't open right now. Check the code, and make sure the host has Card Club open on their screen (not in a background tab), then try again.`,
        blocked: `Found room ${code} but couldn't connect to the host. A network is probably blocking it: try switching between Wi-Fi and mobile data (on your side or the host's), or avoid work/school Wi-Fi.`,
        'no-signaling': "Couldn't reach the matchmaking server. Check your internet connection, turn off any VPN or ad/tracker blocker for this site, and try again.",
      }[e.reason] || `Couldn't connect to room ${code} (${e.reason}).`;
      render();
    });
  }

  function cancelJoin() {
    S.joinAttempt = (S.joinAttempt || 0) + 1;
    if (S.ws) { const t = S.ws; S.ws = null; t.close(); }
    S.status = null;
    render();
  }

  function startOrJoin(mode, code) {
    if (!P2P) return send(mode === 'create' ? { t: 'create', name: S.name } : { t: 'join', code, name: S.name });
    if (mode === 'create') return hostRoom(null);
    if (mode === 'reopen') return hostRoom(code);
    return joinRoom(code);
  }

  function boot() {
    if (P2P) P2P.onHostStatus(() => renderTopbar());
    render();
    if (!P2P) return connectServer();
    // Coming back to a room link (or reloading): reconnect automatically.
    if (S.wantRoom && S.name) {
      if (P2P.lastHosted() === S.wantRoom) hostRoom(S.wantRoom);
      else joinRoom(S.wantRoom);
    }
  }

  // Warn the host before closing the tab while friends are connected.
  window.addEventListener('beforeunload', (e) => {
    if (P2P && P2P.isHosting() && S.room && S.room.members.some((m) => !m.isBot && m.connected && m.id !== S.me)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
    else toast('Reconnecting… try again in a second');
  }
  const act = (action) => send({ t: 'act', action });

  function onRoom(room) {
    const first = !S.room || S.room.code !== room.code;
    S.room = room;
    S.wantRoom = room.code;
    if (first) history.replaceState(null, '', `?room=${room.code}`);

    // unread chat
    const others = room.chat.filter((m) => !m.sys && m.from !== S.me).length;
    if (!first && S.tab !== 'chat' && others > S.lastChatCount) S.unread += others - S.lastChatCount;
    S.lastChatCount = others;

    // your-turn alert
    const myTurn = !!(room.game && room.game.waitingOn.includes(S.me));
    if (myTurn && !S.wasMyTurn) { beep(); }
    S.wasMyTurn = myTurn;
    document.title = myTurn ? '● Your turn · Card Club' : `Card Club · ${room.code}`;

    if (first) render(); else renderRoom();
  }

  let audioCtx = null;
  function beep() {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.3);
    } catch {}
  }

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- helpers ----------
  const member = (id) => (S.room && S.room.members.find((m) => m.id === id)) || { name: '?' };
  const isHost = () => S.room && S.room.hostId === S.me;

  // Cards on screen after the previous render; only cards not in here get the deal-in animation.
  let seenCards = new Set();
  function cardHTML(c, cls = '', attrs = '') {
    if (!c) return `<div class="card back ${cls}" ${attrs}></div>`;
    const r = c[0] === 'T' ? '10' : c[0];
    const s = SUITS[c[1]];
    const red = c[1] === 'H' || c[1] === 'D' ? 'red' : '';
    const fresh = seenCards.has(c) ? '' : 'fresh';
    return `<div class="card ${red} ${fresh} ${cls}" data-card="${c}" ${attrs}><span class="corner">${r}<br>${s}</span><span class="pip">${s}</span><span class="corner br">${r}<br>${s}</span></div>`;
  }
  const cardsHTML = (cards, cls = '', wrap = 'cards') => `<div class="${wrap}">${cards.map((c) => cardHTML(c, cls)).join('')}</div>`;

  function chipColor(n) {
    if (n >= 500) return 'gold';
    if (n >= 100) return 'black';
    if (n >= 25) return 'green';
    if (n >= 10) return 'blue';
    return '';
  }

  // ---------- top-level render ----------
  function render() {
    if (!S.room) return renderLanding();
    $app.innerHTML = `
      <div class="room">
        <header class="topbar" id="topbar"></header>
        <main class="stage" id="stage"></main>
        <aside class="side">
          <nav class="tabs" id="tabs"></nav>
          <div class="tab-body" id="tabbody"></div>
          <form class="chat-form hidden" id="chatform" style="padding:8px 12px 12px">
            <input type="text" id="chatinput" maxlength="300" placeholder="Say something…" autocomplete="off">
            <button class="btn primary" type="submit">Send</button>
          </form>
        </aside>
      </div>`;
    document.getElementById('chatform').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chatinput');
      if (input.value.trim()) send({ t: 'chat', text: input.value });
      input.value = '';
    });
    renderRoom();
  }

  function renderRoom() {
    renderTopbar();
    renderStage();
    renderSide();
  }

  function renderLanding() {
    document.title = 'Card Club';
    const joining = S.wantRoom;
    const mine = P2P && P2P.lastHosted();
    const reopening = joining && mine === joining;
    const busy = !!S.status;
    const dis = busy ? 'disabled' : '';
    let actions;
    if (joining) {
      actions = `
        <button class="btn primary big" style="width:100%" type="submit" data-mode="${reopening ? 'reopen' : 'join'}" ${dis}>${reopening ? 'Reopen' : 'Join'} room ${esc(joining)}</button>
        <div class="or"><a href="#" id="start-own" class="muted">or start your own room</a></div>`;
    } else {
      actions = `
        <button class="btn primary big" style="width:100%" type="submit" data-mode="create" ${dis}>Create a room</button>
        ${mine ? `<button class="btn" style="width:100%;margin-top:8px" type="button" id="reopen-btn" ${dis}>Reopen your room ${esc(mine)}</button>` : ''}
        <div class="or">or join with a code</div>
        <div class="row">
          <input type="text" id="code" class="code-input" maxlength="4" placeholder="ABCD" autocomplete="off">
          <button class="btn" type="button" id="join-btn" ${dis}>Join</button>
        </div>`;
    }
    $app.innerHTML = `
      <div class="landing">
        <div class="landing-card">
          <div class="logo">Card Club <span class="suits">♠♥♦♣</span></div>
          <p class="tagline">${joining ? `You've been invited to room <b>${esc(joining)}</b>.` : 'Cards with your friends, right in the browser. No sign-up.'}</p>
          <form id="landing-form">
            <div class="field">
              <label for="name">Your name</label>
              <input type="text" id="name" maxlength="20" value="${esc(S.name)}" placeholder="e.g. Sam" autocomplete="nickname" required>
            </div>
            ${actions}
          </form>
          ${busy ? `<p class="status-line">${esc(S.status)}${S.status.startsWith('Waiting') || S.status.startsWith('Connecting') ? ' <a href="#" id="cancel-join" class="muted">Cancel</a>' : ''}</p>` : ''}
          ${S.error && !busy ? `<p class="error-line">${esc(S.error)}</p>` : ''}
          ${P2P && !joining ? '<p class="muted" style="font-size:13px;margin:16px 0 0">Creating a room makes this tab the game host. Keep it open while you play.</p>' : ''}
          <div class="game-list"><span>Texas Hold'em</span><span>Spades</span><span>Gin Rummy</span><span>Blackjack</span></div>
        </div>
      </div>`;
    const nameEl = document.getElementById('name');
    const getName = () => {
      const n = nameEl.value.trim();
      if (!n) { toast('Enter your name first'); nameEl.focus(); return null; }
      S.name = n;
      store.set('cc_name', n);
      return n;
    };
    document.getElementById('landing-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!getName()) return;
      const mode = e.submitter ? e.submitter.dataset.mode : joining ? (reopening ? 'reopen' : 'join') : 'create';
      startOrJoin(mode, joining);
    });
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.addEventListener('click', () => {
      if (!getName()) return;
      const code = document.getElementById('code').value.trim().toUpperCase();
      if (code.length !== 4) return toast('Room codes are 4 letters');
      startOrJoin(code === mine ? 'reopen' : 'join', code);
    });
    const reopenBtn = document.getElementById('reopen-btn');
    if (reopenBtn) reopenBtn.addEventListener('click', () => { if (getName()) startOrJoin('reopen', mine); });
    const cancel = document.getElementById('cancel-join');
    if (cancel) cancel.addEventListener('click', (e) => { e.preventDefault(); cancelJoin(); });
    const own = document.getElementById('start-own');
    if (own) own.addEventListener('click', (e) => {
      e.preventDefault();
      S.wantRoom = null;
      history.replaceState(null, '', location.pathname);
      renderLanding();
    });
    if (!S.name) nameEl.focus();
  }

  function renderTopbar() {
    const el = document.getElementById('topbar');
    if (!el || !S.room) return;
    el.innerHTML = `
      <div class="logo">Card Club <span class="suits">♠♥♦♣</span></div>
      <span class="room-code" title="Room code">${esc(S.room.code)}</span>
      <button class="btn small" data-a="copy-link">Copy invite link</button>
      <span class="spacer"></span>
      ${P2P && P2P.isHosting() ? (P2P.hostOnline()
        ? '<span class="tag host" title="Your tab is running this room. If you close it, the game pauses for everyone.">● Room online · keep this tab open</span>'
        : '<span class="tag offline" title="New players can\'t find the room until this reconnects. Players already here are unaffected.">● Reconnecting… new players can\'t join yet</span>') : ''}
      <span class="muted" style="font-size:13px"><span class="conn ${S.connected ? '' : 'off'}"></span> ${S.connected ? esc(S.name) : 'Reconnecting…'}</span>
      <button class="btn small ghost" data-a="sound" title="Turn alert sound">${S.sound ? '🔔' : '🔕'}</button>
      <button class="btn small ghost" data-a="leave">Leave</button>`;
  }

  // Don't clobber a field the user is typing in; re-render when they leave it.
  function renderStage() {
    const el = document.getElementById('stage');
    if (!el) return;
    const a = document.activeElement;
    if (a && el.contains(a) && a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox') {
      S.ui.pendingStage = true;
      return;
    }
    S.ui.pendingStage = false;
    const g = S.room.game;
    if (!g) el.innerHTML = lobbyHTML();
    else el.innerHTML = gameChromeHTML(g) + (RENDER[g.id] || (() => ''))(g.view, g);
    afterStage();
  }

  // ---------- lobby ----------
  const GAME_SUIT = { holdem: '♠', spades: '♣', ginrummy: '♦', blackjack: '♥' };

  function lobbyHTML() {
    const r = S.room;
    const host = isHost();
    const game = r.catalog.find((g) => g.id === r.gameId);
    const opts = r.options[r.gameId];
    const playing = r.members.filter((m) => m.playing && !m.left && m.connected);
    const count = playing.length;
    const ok = count >= game.minPlayers && count <= game.maxPlayers;
    const need = game.minPlayers === game.maxPlayers ? `exactly ${game.minPlayers}` : `${game.minPlayers}–${game.maxPlayers}`;

    const tiles = r.catalog.map((g) => `
      <button class="gtile ${g.id === r.gameId ? 'on' : ''}" data-a="select-game" data-game="${g.id}" ${host ? '' : 'disabled style="cursor:default;opacity:1"'}>
        <span class="gsuit">${GAME_SUIT[g.id] || '♠'}</span>
        <span class="gname">${esc(g.name)}</span>
        <span class="gblurb">${esc(g.blurb)}</span>
      </button>`).join('');

    const optFields = game.options.map((o) => `
      <div class="field">
        <label>${esc(o.label)}</label>
        <input type="number" data-opt="${o.key}" value="${opts[o.key]}" min="${o.min}" max="${o.max}" step="${o.step || 1}" ${host ? '' : 'disabled'}>
      </div>`).join('');

    let seatIdx = 0;
    const seats = r.members.filter((m) => !m.left || m.playing).map((m) => {
      const active = m.playing && !m.left && m.connected;
      let team = '';
      if (r.gameId === 'spades' && active) {
        const t = seatIdx % 2;
        team = `<span class="tag ${t ? 'team-b' : 'team-a'}">Team ${t ? 'B' : 'A'}</span>`;
      }
      if (active) seatIdx++;
      const canToggle = host || m.id === S.me;
      return `
        <div class="seat-row ${active ? '' : 'out'}">
          <input type="checkbox" ${m.playing ? 'checked' : ''} ${canToggle ? '' : 'disabled'} data-a="toggle-playing" data-id="${m.id}" title="Playing next game">
          <span class="name">${m.isBot ? '🤖 ' : ''}${esc(m.name)}${m.id === S.me ? ' <span class="muted">(you)</span>' : ''}</span>
          ${team}
          ${m.id === r.hostId ? '<span class="tag host">host</span>' : ''}
          ${!m.connected ? '<span class="tag">offline</span>' : ''}
          <span class="muted" style="font-variant-numeric:tabular-nums">${fmt(m.chips)} chips</span>
          ${host && m.id !== S.me ? `<button class="btn small ghost" data-a="kick" data-id="${m.id}" title="Remove">✕</button>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="lobby">
        <h2>Pick a game</h2>
        <p class="muted" style="margin:0">${host ? 'You’re the host: choose a game, set it up, then start.' : `${esc(member(r.hostId).name)} is the host and picks the game.`}</p>
        <div class="games">${tiles}</div>

        ${game.options.length ? `<div class="panel"><div class="section-title">${esc(game.name)} settings</div><div class="opts">${optFields}</div></div>` : ''}

        <div class="panel">
          <div class="row" style="justify-content:space-between;margin-bottom:10px">
            <div class="section-title" style="margin:0">Who's playing</div>
            <div class="row">
              ${host ? '<button class="btn small" data-a="add-bot">+ Add bot</button>' : ''}
              ${host && r.gameId === 'spades' ? '<button class="btn small" data-a="shuffle">Shuffle teams</button>' : ''}
            </div>
          </div>
          <div class="seats">${seats}</div>
          ${r.gameId === 'spades' ? '<p class="muted" style="font-size:13px;margin:10px 0 0">Team A sits across from Team A. Use “Shuffle teams” for random partners.</p>' : ''}
        </div>

        <div class="panel start-bar">
          <div>
            <b>${count} ready</b> <span class="muted">· ${esc(game.name)} needs ${need}</span>
            ${!ok && count < game.minPlayers ? '<div class="muted" style="font-size:13px">Invite friends with the link up top, or add bots.</div>' : ''}
          </div>
          ${host ? `<button class="btn primary big" data-a="start" ${ok ? '' : 'disabled'}>Start ${esc(game.name)}</button>` : '<span class="muted">Waiting for the host to start…</span>'}
        </div>

        ${host ? `
        <div class="panel">
          <div class="section-title">Room settings</div>
          <div class="row">
            <div class="field" style="margin:0">
              <label>Starting chips / rebuy amount</label>
              <input type="number" data-setting="startingChips" value="${r.settings.startingChips}" min="10" max="1000000" step="10">
            </div>
            <button class="btn small danger" data-a="reset" style="align-self:flex-end">Reset all chips & scores</button>
          </div>
        </div>` : ''}
      </div>`;
  }

  function gameChromeHTML(g) {
    const host = isHost();
    const playing = g.playerIds.includes(S.me);
    const waitingNames = g.waitingOn.filter((id) => id !== S.me).map((id) => esc(member(id).name));
    const myTurn = g.waitingOn.includes(S.me);
    let right = '';
    if (g.over) right = '<button class="btn primary" data-a="end-game">Back to lobby</button>';
    else if (host) right = `<button class="btn small danger" data-a="end-game" data-confirm="${g.continuous ? 'End this session and record the results?' : 'Abandon this game? Stakes are refunded.'}">${g.continuous ? 'End session' : 'Abandon game'}</button>`;
    return `
      <div class="game-head">
        <h2>${esc(g.name)}</h2>
        ${g.pot ? `<span class="tag">Pot ${fmt(g.pot)} chips</span>` : ''}
        ${myTurn ? '<span class="turn-pill">Your turn</span>' : waitingNames.length ? `<span class="muted" style="font-size:13px">Waiting on ${waitingNames.slice(0, 3).join(', ')}${waitingNames.length > 3 ? '…' : ''}</span>` : ''}
        ${!playing ? '<span class="tag">Watching</span>' : ''}
        <span class="spacer"></span>
        ${g.canSitIn && !g.over ? '<button class="btn small primary" data-a="sit-in">Join the table</button>' : ''}
        ${right}
      </div>
      ${g.over ? `<div class="banner big">🏆 ${esc(g.over.summary)}</div>` : ''}`;
  }

  // ---------- Texas Hold'em ----------
  function holdemHTML(v) {
    const seats = v.seats;
    const myIdx = seats.findIndex((s) => s.id === S.me);
    const n = seats.length;
    const order = seats.map((_, k) => seats[(Math.max(0, myIdx) + k) % n]);
    const tall = window.innerWidth <= 600;
    const rx = tall ? 40 : 46;
    const ry = tall ? 43 : 43;

    const seatEls = order.map((s, k) => {
      const ang = (Math.PI / 2) + (k * 2 * Math.PI) / n;
      const x = 50 + rx * Math.cos(ang);
      const y = 50 + ry * Math.sin(ang);
      const me = s.id === S.me;
      const turn = v.toAct === s.id;
      const won = v.results && v.results.winnings[s.id];
      let cards = '';
      if (s.inHand && !s.folded) {
        if (s.hole) cards = cardsHTML(s.hole, 'sm' + (won && v.results.showdown ? ' win' : ''), 'cards overlap');
        else cards = cardsHTML([null, null], 'xs', 'cards overlap');
      }
      const handName = v.results && v.results.hands[s.id] ? `<div class="pact" style="color:var(--gold)">${esc(v.results.hands[s.id].name)}</div>` : '';
      let status = s.lastAction || '';
      if (!s.inHand) status = s.sittingOut ? 'Sitting out' : s.stack <= 0 ? 'Out of chips' : 'Next hand';
      if (won) status = `<span class="good">Wins ${fmt(won)}</span>`;
      // Bets sit between the seat and the pot. On a narrow phone table the board spans
      // almost the full width, so side seats put their bet just below their box instead.
      const chipHTML = s.bet ? `<span class="chip ${chipColor(s.bet)}"></span>${fmt(s.bet)}` : '';
      const besideSeat = tall && Math.abs(y - 50) < 20;
      const bet = s.bet && !besideSeat
        ? `<div class="betchip" style="left:${50 + (x - 50) * 0.55}%;top:${48 + (y - 50) * 0.52}%">${chipHTML}</div>`
        : '';
      return `
        ${bet}
        <div class="pseat ${me ? 'me' : ''} ${turn ? 'turn' : ''} ${s.folded ? 'folded' : ''}" style="left:${x}%;top:${y}%">
          ${cards}
          <div class="pbox" style="position:relative">
            ${s.dealer ? '<span class="dbtn">D</span>' : ''}
            <div class="pname">${member(s.id).isBot ? '🤖 ' : ''}${esc(s.name)}</div>
            <div class="pstack">${fmt(s.stack)}${s.allIn ? ' · ALL IN' : ''}</div>
            <div class="pact">${status}</div>
            ${handName}
          </div>
          ${s.bet && besideSeat ? `<div class="betchip inline">${chipHTML}</div>` : ''}
        </div>`;
    }).join('');

    const board = v.board ? v.board.concat(Array(5 - v.board.length).fill('empty')) : [];
    const bestCards = v.results && v.results.showdown
      ? new Set(Object.entries(v.results.hands).filter(([id]) => v.results.winnings[id]).flatMap(([, h]) => h.cards))
      : new Set();
    const boardHTML = board.map((c) => (c === 'empty' ? '<div class="card empty sm"></div>' : cardHTML(c, 'sm' + (bestCards.has(c) ? ' win' : '')))).join('');

    let center = '';
    if (v.phase === 'waiting') center = `<div class="pot">Waiting for 2+ players with chips</div>`;
    else center = `<div class="cards board">${boardHTML}</div><div class="pot">Pot ${fmt(v.pot)}</div>`;

    return `
      <div class="felt">
        <div class="felt-center">${center}<div class="muted" style="font-size:12px">Blinds ${fmt(v.options.smallBlind)}/${fmt(v.options.bigBlind)} · Hand #${v.handNo}</div></div>
        ${seatEls}
      </div>
      ${holdemActions(v)}`;
  }

  function holdemActions(v) {
    const meSeat = v.seats.find((s) => s.id === S.me);
    if (!meSeat) return '';
    const L = v.legal;
    const parts = [];
    if (L) {
      const key = `${v.handNo}-${v.street}-${v.currentBet}`;
      if (S.ui.raiseKey !== key || S.ui.raiseTo == null) { S.ui.raiseKey = key; S.ui.raiseTo = L.minRaiseTo; }
      S.ui.raiseTo = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, S.ui.raiseTo));
      const verb = v.currentBet > 0 ? 'Raise to' : 'Bet';
      const half = Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, v.currentBet + Math.floor(L.pot / 2)));
      const full = Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, v.currentBet + L.pot));
      parts.push(`
        <div class="row">
          <button class="btn danger big" data-a="h-fold">Fold</button>
          ${L.canCheck ? '<button class="btn big" data-a="h-check">Check</button>' : `<button class="btn big" data-a="h-call">Call ${fmt(L.callAmount)}</button>`}
          ${L.canRaise ? `<button class="btn primary big" data-a="h-raise" id="raise-btn">${L.maxRaiseTo === S.ui.raiseTo ? 'All-in' : verb} ${fmt(S.ui.raiseTo)}</button>` : ''}
        </div>
        ${L.canRaise && L.maxRaiseTo > L.minRaiseTo ? `
        <div class="raise-box">
          <input type="range" id="raise-range" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="1" value="${S.ui.raiseTo}">
          <input type="number" id="raise-num" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${S.ui.raiseTo}">
          <button class="btn small" data-a="h-preset" data-v="${L.minRaiseTo}">Min</button>
          <button class="btn small" data-a="h-preset" data-v="${half}">½ Pot</button>
          <button class="btn small" data-a="h-preset" data-v="${full}">Pot</button>
          <button class="btn small" data-a="h-preset" data-v="${L.maxRaiseTo}">All-in</button>
        </div>` : ''}`);
    } else {
      const row = [];
      if (v.phase === 'done' || v.phase === 'waiting') row.push('<button class="btn primary big" data-a="h-next">Deal next hand</button>');
      row.push(`<label class="row muted" style="font-size:14px"><input type="checkbox" data-a="h-sitout" ${meSeat.sittingOut ? 'checked' : ''}> Sit out next hand</label>`);
      if (member(S.me).chips <= 0 && !meSeat.inHand) row.push(`<button class="btn" data-a="rebuy">Rebuy ${fmt(S.room.settings.startingChips)}</button>`);
      row.push('<button class="btn small ghost" data-a="h-leave">Leave table</button>');
      parts.push(`<div class="row">${row.join('')}</div>`);
    }
    return `<div class="actions">${parts.join('')}</div>`;
  }

  // ---------- Spades ----------
  function spadesHTML(v, g) {
    const base = v.mySeat >= 0 ? v.mySeat : 0;
    const rel = (seat) => (seat - base + 4) % 4;
    const myTeam = v.mySeat >= 0 ? v.mySeat % 2 : 0;
    const teamNames = [0, 1].map((t) => `${esc(v.players[t].name)} & ${esc(v.players[t + 2].name)}`);
    const teamBox = (t) => `
      <div class="team-score" style="${t === myTeam ? 'border-color:rgba(233,196,106,.5)' : ''}">
        <div class="ts-names">${t === myTeam && v.mySeat >= 0 ? 'Your team · ' : ''}${teamNames[t]}</div>
        <div class="ts-num">${v.scores[t]}</div>
        <div class="muted" style="font-size:12px">Bags ${v.bags[t]} · Bid ${bidSum(v, t)} · Won ${v.players[t].tricks + v.players[t + 2].tricks}</div>
      </div>`;

    const seats = v.players.map((p, i) => {
      const r = rel(i);
      const turn = v.turn === i && v.phase !== 'roundover' && !v.over;
      const bid = p.bid === null ? (v.phase === 'bidding' ? '…' : '–') : p.bid === 0 ? 'Nil' : p.bid;
      const backs = r === 0 || !p.cardCount ? '' : `<div class="card-count">${cardHTML(null, 'xs')}<span>×${p.cardCount}</span></div>`;
      return `
        <div class="tseat s${r}">
          <div class="pseat ${turn ? 'turn' : ''} ${p.id === S.me ? 'me' : ''}" style="position:static;transform:none">
            <div class="pbox" style="position:relative">
              ${v.dealer === i ? '<span class="dbtn">D</span>' : ''}
              <div class="pname"><span class="${p.team ? 'team-b' : 'team-a'}">●</span> ${member(p.id).isBot ? '🤖 ' : ''}${esc(p.name)}</div>
              <div class="pstack">Bid ${bid} · Won ${p.tricks}</div>
            </div>
            ${backs}
          </div>
        </div>`;
    }).join('');

    const winnerSeat = v.trickWinner;
    const trick = v.trick.map((t) => `<div class="tplay s${rel(t.seat)}">${cardHTML(t.card, t.seat === winnerSeat ? 'win' : '')}</div>`).join('');

    let below = '';
    const myTurn = v.mySeat >= 0 && v.turn === v.mySeat && !v.over;
    if (v.phase === 'bidding' && myTurn) {
      const btns = Array.from({ length: 14 }, (_, b) => `<button class="btn ${b === 0 ? 'danger' : ''}" data-a="s-bid" data-v="${b}">${b === 0 ? 'Nil' : b}</button>`).join('');
      const partnerBid = v.players[(v.mySeat + 2) % 4].bid;
      below = `<div class="actions"><div><b>Your bid</b> <span class="muted">· partner ${partnerBid === null ? 'hasn’t bid' : `bid ${partnerBid === 0 ? 'Nil' : partnerBid}`}</span></div><div class="bid-grid">${btns}</div></div>`;
    } else if (v.phase === 'roundover' && v.summary && !v.over) {
      below = `<div class="actions"><div class="result-panel">${spadesSummary(v)}<button class="btn primary big" data-a="next-round">Next round</button></div></div>`;
    } else if (v.over && v.summary) {
      below = `<div class="actions"><div class="result-panel">${spadesSummary(v)}</div></div>`;
    }

    let hand = '';
    if (v.hand) {
      const legal = new Set(v.legal);
      hand = `<div class="hand">${v.hand.map((c) => {
        const can = myTurn && v.phase === 'playing' && legal.has(c);
        const dim = myTurn && v.phase === 'playing' && !legal.has(c);
        return cardHTML(c, `${can ? 'click' : ''} ${dim ? 'dim' : ''}`, can ? 'data-a="s-play"' : '');
      }).join('')}</div>`;
    }

    return `
      <div class="scoreline">${teamBox(0)}${teamBox(1)}</div>
      <div class="muted" style="text-align:center;font-size:12px;margin-top:6px">Round ${v.roundNo} · playing to ${v.options.target}${v.spadesBroken ? ' · ♠ broken' : ''}</div>
      <div class="trick-table">${seats}${trick}</div>
      ${hand}
      ${below}`;
  }

  function bidSum(v, t) {
    const b = [v.players[t].bid, v.players[t + 2].bid];
    if (b.some((x) => x === null)) return '…';
    return b.map((x) => (x === 0 ? 'Nil' : x)).join('+');
  }

  function spadesSummary(v) {
    const s = v.summary;
    const rows = [0, 1].map((t) => `
      <tr>
        <td style="text-align:left">${esc(v.players[t].name)} & ${esc(v.players[t + 2].name)}</td>
        <td>${s.teams[t].bid}${s.teams[t].nilBids ? ` + ${s.teams[t].nilBids} Nil` : ''}</td>
        <td>${s.teams[t].taken}</td>
        <td class="${s.teams[t].delta >= 0 ? 'good' : 'bad'}">${signed(s.teams[t].delta)}</td>
        <td><b>${s.scores[t]}</b></td>
      </tr>
      ${s.teams[t].notes.length ? `<tr><td colspan="5" class="muted" style="font-size:12px;border-top:none">${s.teams[t].notes.map(esc).join(' · ')}</td></tr>` : ''}`).join('');
    return `<table class="summary"><tr><th style="text-align:left">Team</th><th>Bid</th><th>Took</th><th>Round</th><th>Total</th></tr>${rows}</table>`;
  }

  // ---------- Gin Rummy ----------
  function ginHTML(v) {
    const me = v.mySeat;
    const oppSeat = me >= 0 ? 1 - me : 1;
    const viewSeat = me >= 0 ? me : 0;
    const opp = v.players[oppSeat];
    const mine = v.players[viewSeat];
    const myTurn = me >= 0 && v.turn === me && v.phase !== 'roundover' && !v.over;
    const res = v.result;

    const scoreBox = (p, label) => `
      <div class="team-score">
        <div class="ts-names">${label}${esc(p.name)}</div>
        <div class="ts-num">${p.score}</div>
        <div class="muted" style="font-size:12px">${p.handsWon} hand${p.handsWon === 1 ? '' : 's'} won</div>
      </div>`;

    const meldsHTML = (melds, dead, deadLabel, laid = []) => `
      <div class="meld-row">
        ${melds.map((m) => `<div><div class="meld">${m.map((c) => cardHTML(c, 'sm' + (laid.includes(c) ? ' hl' : ''))).join('')}</div></div>`).join('')}
        ${dead && dead.length ? `<div><div class="meld dead">${dead.map((c) => cardHTML(c, 'sm')).join('')}</div><div class="meld-label">${deadLabel}</div></div>` : ''}
      </div>`;

    // Opponent row
    let oppHTML;
    if (v.phase === 'roundover' && res && res.type !== 'draw') {
      const oppIsKnocker = res.knocker === oppSeat;
      oppHTML = oppIsKnocker
        ? meldsHTML(res.knockerMelds, res.knockerDead, `deadwood ${res.knockerDeadwood}`, res.defenderLaid)
        : meldsHTML(res.defenderMelds, res.defenderDead, `deadwood ${res.defenderDeadwood}`);
    } else if (v.phase === 'roundover' && v.hands) {
      oppHTML = cardsHTML(v.hands[oppSeat], 'sm', 'cards overlap');
    } else {
      oppHTML = `<div class="cards overlap">${Array(opp.cardCount).fill(0).map(() => cardHTML(null, 'sm')).join('')}</div>`;
    }

    // Piles
    const canDraw = myTurn && v.phase === 'draw';
    const piles = `
      <div class="piles">
        <div class="pile">
          ${v.stockCount ? cardHTML(null, canDraw ? 'click hl' : '', canDraw ? 'data-a="g-draw-stock"' : '') : '<div class="card empty"></div>'}
          <span>Stock · ${v.stockCount}</span>
        </div>
        <div class="pile">
          ${v.discardTop ? cardHTML(v.discardTop, canDraw ? 'click hl' : '', canDraw ? 'data-a="g-draw-discard"' : '') : '<div class="card empty"></div>'}
          <span>Discard</span>
        </div>
      </div>`;

    // My hand
    let mineHTML = '';
    let controls = '';
    if (me >= 0) {
      if (v.phase === 'roundover' && res && res.type !== 'draw') {
        const iKnocked = res.knocker === me;
        mineHTML = iKnocked
          ? meldsHTML(res.knockerMelds, res.knockerDead, `deadwood ${res.knockerDeadwood}`, res.defenderLaid)
          : meldsHTML(res.defenderMelds, res.defenderDead, `deadwood ${res.defenderDeadwood}`);
      } else {
        const sel = S.ui.selected && v.hand.includes(S.ui.selected) ? S.ui.selected : null;
        S.ui.selected = sel;
        const canDiscard = myTurn && v.phase === 'discard';
        const cardFor = (c) => {
          const cls = ['sm'];
          if (canDiscard && c !== v.takenFromDiscard) cls.push('click');
          if (c === sel) cls.push('sel');
          if (c === v.takenFromDiscard || (v.lastDraw && v.lastDraw.card === c && v.lastDraw.seat === me)) cls.push('hl');
          return cardHTML(c, cls.join(' '), canDiscard && c !== v.takenFromDiscard ? 'data-a="g-select"' : '');
        };
        mineHTML = `
          <div class="meld-row">
            ${v.melds.map((m) => `<div><div class="meld">${m.map(cardFor).join('')}</div></div>`).join('')}
            ${v.deadCards.length ? `<div><div class="meld dead">${v.deadCards.map(cardFor).join('')}</div><div class="meld-label">unmatched</div></div>` : ''}
          </div>
          <div><span class="muted">Deadwood</span> <span class="deadwood">${v.deadwood}</span></div>`;
        if (canDiscard) {
          const after = sel ? v.discardOptions[sel] : null;
          const knockLabel = after === 0 ? 'Gin!' : `Knock${after != null ? ` (${after})` : ''}`;
          controls = `
            <div class="actions">
              <div class="muted">${sel ? `Selected ${cardLabel(sel)}${after != null ? ` · deadwood after: ${after}` : ''}` : 'Tap a card to discard'}</div>
              <div class="row">
                <button class="btn big" data-a="g-discard" ${sel ? '' : 'disabled'}>Discard</button>
                <button class="btn primary big" data-a="g-knock" ${sel && after <= 10 ? '' : 'disabled'}>${knockLabel}</button>
                ${v.canBigGin ? '<button class="btn primary big" data-a="g-biggin">Big Gin!</button>' : ''}
              </div>
            </div>`;
        } else if (canDraw) {
          controls = '<div class="actions"><div class="muted">Draw from the stock or take the discard</div></div>';
        }
      }
      if (v.phase === 'roundover' && !v.over) {
        controls = `<div class="actions"><div class="banner" style="margin:0">${esc(res.text)}</div><button class="btn primary big" data-a="next-round">Next hand</button></div>`;
      } else if (v.over && res) {
        controls = `<div class="actions"><div class="banner" style="margin:0">${esc(res.text)}</div></div>`;
      }
    }

    const hist = v.history.length ? `<div class="muted" style="font-size:12px;text-align:center">${v.history.slice(-4).map((h) => esc(h.text)).join(' · ')}</div>` : '';
    return `
      <div class="scoreline">${scoreBox(opp, '')}${scoreBox(mine, me >= 0 ? 'You · ' : '')}</div>
      <div class="muted" style="text-align:center;font-size:12px;margin:6px 0">Hand ${v.roundNo} · playing to ${v.options.target} · ${v.turn === me ? 'your turn' : `${esc(v.players[v.turn].name)}'s turn`}</div>
      ${hist}
      <div class="gin-area">
        <div>${oppHTML}</div>
        ${v.phase === 'roundover' ? '' : piles}
        ${v.lastDraw && v.lastDraw.from === 'discard' && v.lastDraw.seat !== me ? `<div class="muted" style="font-size:13px">${esc(v.players[v.lastDraw.seat].name)} took the ${cardLabel(v.lastDraw.card)}</div>` : ''}
        <div>${mineHTML}</div>
      </div>
      ${controls}`;
  }

  function cardLabel(c) {
    const r = { A: 'A', T: '10', J: 'J', Q: 'Q', K: 'K' }[c[0]] || c[0];
    return `${r}${SUITS[c[1]]}`;
  }

  // ---------- Blackjack ----------
  function blackjackHTML(v) {
    const dealerTotal = v.dealerTotal ? `${v.dealerTotal.total}${v.dealerTotal.soft && v.dealerTotal.total < 21 ? ' (soft)' : ''}` : '';
    const dealer = `
      <div class="bj-dealer">
        <div class="muted" style="font-size:13px">Dealer ${dealerTotal ? `· <b style="color:var(--ink)">${dealerTotal}</b>` : ''}</div>
        ${v.dealer.length ? cardsHTML(v.dealer) : '<div class="cards"><div class="card empty"></div><div class="card empty"></div></div>'}
      </div>`;

    const seats = v.seats.map((s) => {
      const me = s.id === S.me;
      const turn = v.turn && v.turn.id === s.id;
      const hands = s.hands.map((h, i) => {
        const cls = h.result ? (/Win|Blackjack!/.test(h.result) ? 'win' : /Push/.test(h.result) ? '' : 'lose') : '';
        return `
          <div class="bj-hand ${turn && v.turn.hand === i ? 'active' : ''}">
            ${cardsHTML(h.cards, 'sm', 'cards overlap')}
            <div class="bj-total">${h.blackjack ? 'Blackjack' : `${h.total.total}${h.total.soft && h.total.total < 21 ? ' soft' : ''}`} · ${fmt(h.bet)}${h.doubled ? ' (2×)' : ''}</div>
            ${h.result ? `<span class="res ${cls}">${esc(h.result)}</span>` : ''}
          </div>`;
      }).join('');
      let status = '';
      if (v.phase === 'betting') status = s.bet ? `Bet ${fmt(s.bet)}` : s.skipping ? 'Sitting out' : 'Betting…';
      if (v.phase === 'settled' && s.net !== undefined) status = `<span class="${s.net > 0 ? 'good' : s.net < 0 ? 'bad' : ''}">${s.net === 0 ? 'Even' : signed(s.net)}</span>`;
      return `
        <div class="bj-seat ${turn ? 'turn' : ''} ${me ? 'me' : ''}">
          <div class="pname" style="font-weight:600">${member(s.id).isBot ? '🤖 ' : ''}${esc(s.name)}</div>
          <div class="pstack" style="color:var(--gold);font-variant-numeric:tabular-nums">${fmt(s.chips)} chips</div>
          ${hands}
          <div style="font-size:13px">${status}</div>
        </div>`;
    }).join('');

    return `
      <div class="bj-felt">
        ${dealer}
        <div class="rule">BLACKJACK PAYS 3 TO 2 · DEALER STANDS ON ALL 17s</div>
        <div class="bj-seats">${seats}</div>
      </div>
      ${v.reshuffled && v.phase === 'betting' ? '<div class="muted" style="text-align:center;font-size:12px;margin-top:6px">Fresh shoe shuffled</div>' : ''}
      ${blackjackActions(v)}`;
  }

  function blackjackActions(v) {
    const seat = v.seats.find((s) => s.id === S.me);
    if (!seat) return '';
    const chips = member(S.me).chips;
    if (v.phase === 'betting') {
      const anyBet = v.seats.some((s) => s.bet);
      if (seat.bet || seat.skipping) {
        return `<div class="actions"><div class="muted">${seat.bet ? `You bet ${fmt(seat.bet)}.` : 'Sitting out this round.'} Waiting for others…</div>
          <div class="row">${anyBet ? '<button class="btn primary" data-a="bj-deal">Deal now</button>' : ''}<button class="btn small" data-a="bj-rebet">Change</button><button class="btn small ghost" data-a="bj-leave">Leave table</button></div></div>`;
      }
      const o = v.options;
      // S.ui.bet is what the chip buttons have stacked up; 0 means "the minimum".
      S.ui.bet = Math.min(S.ui.bet, o.maxBet, chips);
      const shown = Math.max(o.minBet, S.ui.bet);
      const chipBtn = (n, color) => `<button class="chip-btn" style="background:${color}" data-a="bj-add" data-v="${n}">${n >= 1000 ? `${n / 1000}k` : n}</button>`;
      return `
        <div class="actions">
          <div style="font-size:18px">Bet <b>${fmt(shown)}</b> <span class="muted" style="font-size:13px">(${fmt(o.minBet)}–${fmt(o.maxBet)})</span></div>
          <div class="row">${chipBtn(5, '#c62828')}${chipBtn(25, '#2c8a4f')}${chipBtn(100, '#222')}${chipBtn(500, '#7b4bb5')}${chipBtn(1000, '#c9a227')}</div>
          <div class="row">
            <button class="btn small" data-a="bj-clear">Clear</button>
            <button class="btn primary big" data-a="bj-bet" ${chips >= o.minBet ? '' : 'disabled'}>Place bet</button>
            <button class="btn small" data-a="bj-skip">Sit out round</button>
            ${chips < o.minBet ? `<button class="btn" data-a="rebuy">Rebuy ${fmt(S.room.settings.startingChips)}</button>` : ''}
          </div>
        </div>`;
    }
    if (v.phase === 'playing' && v.legal) {
      return `
        <div class="actions"><div class="row">
          <button class="btn primary big" data-a="bj-hit">Hit</button>
          <button class="btn big" data-a="bj-stand">Stand</button>
          <button class="btn big" data-a="bj-double" ${v.legal.canDouble ? '' : 'disabled'}>Double</button>
          <button class="btn big" data-a="bj-split" ${v.legal.canSplit ? '' : 'disabled'}>Split</button>
        </div></div>`;
    }
    if (v.phase === 'settled') {
      return '<div class="actions"><button class="btn primary big" data-a="next-round">Next round</button></div>';
    }
    return '';
  }

  const RENDER = { holdem: holdemHTML, spades: spadesHTML, ginrummy: ginHTML, blackjack: blackjackHTML };

  function afterStage() {
    seenCards = new Set([...document.querySelectorAll('#stage .card[data-card]')].map((e) => e.dataset.card));
    const range = document.getElementById('raise-range');
    const num = document.getElementById('raise-num');
    const btn = document.getElementById('raise-btn');
    if (range && num) {
      const update = (val, from) => {
        const L = S.room.game.view.legal;
        const v = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.floor(Number(val) || 0)));
        S.ui.raiseTo = v;
        if (from !== 'range') range.value = v;
        if (from !== 'num') num.value = v;
        const verb = S.room.game.view.currentBet > 0 ? 'Raise to' : 'Bet';
        if (btn) btn.textContent = `${v === L.maxRaiseTo ? 'All-in' : verb} ${fmt(v)}`;
      };
      range.addEventListener('input', () => update(range.value, 'range'));
      num.addEventListener('change', () => update(num.value, 'num'));
    }
  }

  // ---------- side panel ----------
  function renderSide() {
    const tabs = document.getElementById('tabs');
    const body = document.getElementById('tabbody');
    const form = document.getElementById('chatform');
    if (!tabs) return;
    if (S.tab === 'chat') S.unread = 0;
    tabs.innerHTML = ['players', 'scores', 'chat'].map((t) => `
      <button class="${S.tab === t ? 'on' : ''}" data-a="tab" data-tab="${t}">
        ${{ players: 'Players', scores: 'Scores', chat: 'Chat' }[t]}${t === 'chat' && S.unread ? `<span class="badge">${S.unread}</span>` : ''}
      </button>`).join('');
    form.classList.toggle('hidden', S.tab !== 'chat');
    if (S.tab === 'players') body.innerHTML = playersHTML();
    else if (S.tab === 'scores') body.innerHTML = scoresHTML();
    else {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.innerHTML = `<div class="chat-log">${S.room.chat.map((m) => (m.sys
        ? `<div class="msg sys">${esc(m.text)}</div>`
        : `<div class="msg"><b>${esc(m.name)}</b> ${esc(m.text)}</div>`)).join('') || '<div class="muted">No messages yet. Say hi!</div>'}</div>`;
      if (atBottom || !body.dataset.scrolled) { body.scrollTop = body.scrollHeight; body.dataset.scrolled = '1'; }
    }
  }

  function playersHTML() {
    const r = S.room;
    const list = r.members.filter((m) => !m.left || m.inGame).slice().sort((a, b) => b.chips - a.chips);
    const items = list.map((m) => `
      <div class="pitem ${m.left ? 'left' : ''}">
        <span class="conn ${m.connected ? '' : 'off'}" title="${m.connected ? 'Online' : 'Offline'}"></span>
        <span class="name">${m.isBot ? '🤖 ' : ''}${esc(m.name)}${m.id === S.me ? ' <span class="muted">(you)</span>' : ''}</span>
        ${m.id === r.hostId ? '<span class="tag host">host</span>' : ''}
        <span style="text-align:right">
          <div class="chips"><span class="chip ${chipColor(m.chips)}" style="width:12px;height:12px;border-width:2px;vertical-align:-1px"></span> ${fmt(m.chips)}</div>
          <div class="net ${m.net > 0 ? 'good' : m.net < 0 ? 'bad' : 'muted'}">${signed(m.net)}</div>
        </span>
      </div>`).join('');
    const me = member(S.me);
    return `
      <div class="section-title">Chip counts</div>
      <div class="plist">${items}</div>
      <p class="muted" style="font-size:12px">Net = chips now minus everything bought in. Everyone starts with ${fmt(r.settings.startingChips)}.</p>
      <div class="row">
        <button class="btn small" data-a="rebuy" data-confirm="Buy in for another ${fmt(r.settings.startingChips)} chips? It counts against your net.">Rebuy ${fmt(r.settings.startingChips)}</button>
        ${isHost() ? r.members.filter((m) => m.isBot && m.chips < r.settings.startingChips / 4).map((b) => `<button class="btn small ghost" data-a="bot-rebuy" data-id="${b.id}">Top up ${esc(b.name)}</button>`).join('') : ''}
      </div>
      ${me.buyins > r.settings.startingChips ? `<p class="muted" style="font-size:12px">You've bought in ${fmt(me.buyins)} total.</p>` : ''}`;
  }

  function scoresHTML() {
    const r = S.room;
    const names = {};
    for (const m of r.members) names[m.id] = m.name;
    const rows = Object.entries(r.stats)
      .map(([id, st]) => ({ id, name: names[id] || st.name, ...st }))
      .sort((a, b) => b.wins - a.wins || b.played - a.played);
    const gameNames = Object.fromEntries(r.catalog.map((g) => [g.id, g.name]));
    const lb = rows.length ? `
      <table class="lb">
        <tr><th>Player</th><th class="num">Wins</th><th class="num">Played</th></tr>
        ${rows.map((x) => `<tr><td>${esc(x.name)}<div class="muted" style="font-size:11px">${Object.entries(x.byGame).map(([g, s]) => `${esc(gameNames[g] || g)} ${s.wins}/${s.played}`).join(' · ')}</div></td><td class="num"><b>${x.wins}</b></td><td class="num">${x.played}</td></tr>`).join('')}
      </table>` : '<p class="muted">No games finished yet. Results land here automatically.</p>';
    const hist = r.history.length ? `<div class="hist">${r.history.map((h) => `
      <div class="hitem">
        <div class="h-top"><span>${esc(h.gameName)}</span><span>${new Date(h.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
        <div>${h.winners.length ? `🏆 ${h.winners.map(esc).join(' & ')} · ` : ''}${esc(h.summary)}</div>
      </div>`).join('')}</div>` : '<p class="muted">Nothing yet.</p>';
    return `<div class="section-title">Leaderboard</div>${lb}<div class="section-title">History</div>${hist}`;
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
    const a = el.dataset.a;
    const d = el.dataset;
    const v = S.room && S.room.game ? S.room.game.view : null;
    switch (a) {
      case 'copy-link': {
        const url = `${location.origin}${location.pathname}?room=${S.room.code}`;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
          .then(() => toast('Invite link copied. Send it to your friends!', 'info'))
          .catch(() => prompt('Copy this link:', url));
        break;
      }
      case 'sound': S.sound = !S.sound; store.set('cc_sound', S.sound ? 'on' : 'off'); renderTopbar(); if (S.sound) beep(); break;
      case 'leave':
        if (P2P && P2P.isHosting()) {
          if (confirm('Close this room? Everyone will be disconnected. You can reopen it later with the same code, and chips and scores are kept.')) {
            P2P.stopHosting();
            location.href = location.pathname;
          }
        } else if (confirm('Leave this room? Your chips are saved if you come back.')) send({ t: 'leave' });
        break;
      case 'tab': S.tab = d.tab; renderSide(); if (S.tab === 'chat') document.getElementById('chatinput').focus(); break;
      case 'select-game': send({ t: 'selectGame', game: d.game }); break;
      case 'toggle-playing': send({ t: 'togglePlaying', id: d.id }); break;
      case 'add-bot': send({ t: 'addBot' }); break;
      case 'shuffle': send({ t: 'shuffleSeats' }); break;
      case 'kick': if (confirm(`Remove ${member(d.id).name} from the room?`)) send({ t: 'kick', id: d.id }); break;
      case 'start': send({ t: 'start' }); break;
      case 'reset': if (confirm('Reset everyone back to starting chips and clear the scoreboard?')) send({ t: 'resetScores' }); break;
      case 'rebuy': send({ t: 'rebuy' }); break;
      case 'bot-rebuy': send({ t: 'botRebuy', id: d.id }); break;
      case 'end-game': send({ t: 'endGame' }); break;
      case 'sit-in': send({ t: 'sitIn' }); break;
      case 'next-round': act({ type: 'next' }); break;
      // hold'em
      case 'h-fold': act({ type: 'fold' }); break;
      case 'h-check': act({ type: 'check' }); break;
      case 'h-call': act({ type: 'call' }); break;
      case 'h-raise': act({ type: 'raise', amount: S.ui.raiseTo }); break;
      case 'h-preset': {
        S.ui.raiseTo = Number(d.v);
        renderStage();
        break;
      }
      case 'h-next': act({ type: 'next' }); break;
      case 'h-sitout': act({ type: 'sitout', value: el.checked }); break;
      case 'h-leave': if (confirm('Leave the table? You can rejoin from the game screen.')) act({ type: 'leave' }); break;
      // spades
      case 's-bid': act({ type: 'bid', bid: Number(d.v) }); break;
      case 's-play': act({ type: 'play', card: el.dataset.card }); break;
      // gin
      case 'g-draw-stock': act({ type: 'draw', from: 'stock' }); break;
      case 'g-draw-discard': act({ type: 'draw', from: 'discard' }); break;
      case 'g-select': S.ui.selected = S.ui.selected === el.dataset.card ? null : el.dataset.card; renderStage(); break;
      case 'g-discard': act({ type: 'discard', card: S.ui.selected }); S.ui.selected = null; break;
      case 'g-knock': act({ type: 'knock', card: S.ui.selected }); S.ui.selected = null; break;
      case 'g-biggin': act({ type: 'knock' }); break;
      // blackjack
      case 'bj-add': S.ui.bet += Number(d.v); renderStage(); break;
      case 'bj-clear': S.ui.bet = 0; renderStage(); break;
      case 'bj-bet': act({ type: 'bet', amount: Math.max(v.options.minBet, S.ui.bet) }); break;
      case 'bj-skip': act({ type: 'skip' }); break;
      case 'bj-rebet': act({ type: 'unbet' }); break;
      case 'bj-deal': act({ type: 'deal' }); break;
      case 'bj-hit': act({ type: 'hit' }); break;
      case 'bj-stand': act({ type: 'stand' }); break;
      case 'bj-double': act({ type: 'double' }); break;
      case 'bj-split': act({ type: 'split' }); break;
      case 'bj-leave': if (confirm('Leave the blackjack table?')) act({ type: 'leave' }); break;
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.opt) send({ t: 'setOption', key: el.dataset.opt, value: el.value });
    if (el.dataset.setting === 'startingChips') send({ t: 'setStartingChips', value: el.value });
  });

  document.addEventListener('focusout', () => {
    setTimeout(() => { if (S.ui.pendingStage && S.room) renderStage(); }, 0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-opt], input[data-setting]')) e.target.blur();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.room) renderStage(); }, 150);
  });

  boot();
})();
