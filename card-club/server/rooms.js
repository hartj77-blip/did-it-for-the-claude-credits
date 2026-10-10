// Rooms: lobby, members, chip bank, scoreboard, and the game currently running.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAMES = {
  holdem: require('./games/holdem'),
  spades: require('./games/spades'),
  ginrummy: require('./games/ginrummy'),
  blackjack: require('./games/blackjack'),
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOT_NAMES = ['Robo Rita', 'Lucky Lou', 'Card Shark', 'Dealer Dan', 'Chip', 'Ruby', 'Sal', 'Bluffy', 'Ace'];
const BOT_DELAY = 900;
const AFK_GRACE = 30000; // a disconnected player's turn is auto-played after this
const ROOM_TTL = 14 * 24 * 3600 * 1000;
const MAX_CHAT = 100;

function defaultOptions(game) {
  const o = {};
  for (const opt of game.meta.options) o[opt.key] = opt.default;
  return o;
}

class Rooms {
  constructor({ dataFile }) {
    this.rooms = new Map();
    this.dataFile = dataFile;
    this.saveTimer = null;
    this.load();
    setInterval(() => this.cleanup(), 3600 * 1000).unref();
  }

  // --- persistence (chips, scores and history survive restarts; live games do not) ---

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      for (const r of data.rooms || []) {
        const room = this.blankRoom(r.code, r.hostId);
        Object.assign(room, {
          chips: r.chips || {},
          buyins: r.buyins || {},
          history: r.history || [],
          stats: r.stats || {},
          chat: r.chat || [],
          settings: { ...room.settings, ...r.settings },
          gameId: GAMES[r.gameId] ? r.gameId : 'holdem',
          lastActive: r.lastActive || Date.now(),
        });
        for (const id of Object.keys(GAMES)) room.options[id] = { ...room.options[id], ...(r.options || {})[id] };
        for (const m of r.members || []) {
          room.members.set(m.id, { id: m.id, name: m.name, isBot: m.isBot, playing: m.playing !== false, sockets: new Set(), disconnectedAt: Date.now() });
        }
        this.rooms.set(room.code, room);
      }
      console.log(`Loaded ${this.rooms.size} room(s)`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not load saved rooms:', e.message);
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data = {
      rooms: [...this.rooms.values()].map((r) => ({
        code: r.code,
        hostId: r.hostId,
        members: [...r.members.values()].map((m) => ({ id: m.id, name: m.name, isBot: m.isBot, playing: m.playing })),
        chips: r.chips,
        buyins: r.buyins,
        history: r.history.slice(-100),
        stats: r.stats,
        chat: r.chat.slice(-50),
        settings: r.settings,
        gameId: r.gameId,
        options: r.options,
        lastActive: r.lastActive,
      })),
    };
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      fs.writeFileSync(this.dataFile + '.tmp', JSON.stringify(data));
      fs.renameSync(this.dataFile + '.tmp', this.dataFile);
    } catch (e) {
      console.error('Could not save rooms:', e.message);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      const anyone = [...r.members.values()].some((m) => m.sockets.size);
      if (!anyone && now - r.lastActive > ROOM_TTL) this.rooms.delete(code);
    }
    this.save();
  }

  // --- room lifecycle ----------------------------------------------------------

  blankRoom(code, hostId) {
    const options = {};
    for (const [id, g] of Object.entries(GAMES)) options[id] = defaultOptions(g);
    return {
      code,
      hostId,
      members: new Map(),
      chips: {},
      buyins: {},
      chat: [],
      history: [],
      stats: {},
      gameId: 'holdem',
      options,
      settings: { startingChips: 1000 },
      game: null,
      autoTimer: null,
      lastActive: Date.now(),
    };
  }

  create(player) {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const room = this.blankRoom(code, player.id);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    const room = this.rooms.get(code);
    if (!room) throw new Error(`No room with code ${code || '(blank)'}`);
    return room;
  }

  ensureBank(room, id) {
    if (!(id in room.chips)) {
      room.chips[id] = room.settings.startingChips;
      room.buyins[id] = room.settings.startingChips;
    }
  }

  join(code, ws) {
    const room = this.get(code);
    const { id, name } = ws.player;
    let m = room.members.get(id);
    if (!m) {
      if ([...room.members.values()].filter((x) => !x.isBot).length >= 20) throw new Error('Room is full');
      m = { id, name, isBot: false, playing: true, sockets: new Set(), disconnectedAt: null };
      room.members.set(id, m);
      this.ensureBank(room, id);
      this.system(room, `${name} joined`);
    } else if (m.name !== name) {
      this.system(room, `${m.name} is now ${name}`);
      m.name = name;
    }
    m.sockets.add(ws);
    m.disconnectedAt = null;
    m.left = false;
    ws.roomCode = code;
    if (!room.members.has(room.hostId) || room.members.get(room.hostId).left) room.hostId = id;
    this.touch(room);
  }

  disconnect(code, ws) {
    const room = this.rooms.get(code);
    if (!room) return;
    const m = room.members.get(ws.player.id);
    if (!m) return;
    m.sockets.delete(ws);
    if (!m.sockets.size) m.disconnectedAt = Date.now();
    this.touch(room);
  }

  leave(code, ws) {
    const room = this.rooms.get(code);
    ws.roomCode = null;
    if (!room) return;
    const id = ws.player.id;
    const m = room.members.get(id);
    if (!m) return;
    m.sockets.delete(ws);
    if (m.sockets.size) return this.touch(room); // still open in another tab
    m.disconnectedAt = Date.now();
    this.system(room, `${m.name} left`);
    const inGame = room.game && room.game.playerIds.includes(id);
    if (inGame && room.game.module.meta.continuous && !room.game.over) {
      // Drop them from a poker/blackjack table; their chips stay in the bank.
      try { room.game.module.act(room.game.state, id, { type: 'leave' }, this.ctx(room)); } catch {}
      room.game.playerIds = room.game.playerIds.filter((x) => x !== id);
    }
    // In Spades/Gin their seat is auto-played until they come back (same link, same browser).
    m.left = true;
    if (room.hostId === id) this.passHost(room);
    this.touch(room);
  }

  passHost(room) {
    const next = [...room.members.values()].find((x) => !x.isBot && !x.left && x.sockets.size)
      || [...room.members.values()].find((x) => !x.isBot && !x.left);
    if (next) {
      room.hostId = next.id;
      this.system(room, `${next.name} is now the host`);
    }
  }

  system(room, text) {
    room.chat.push({ sys: true, text, at: Date.now() });
    if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  }

  ctx(room) {
    return {
      getChips: (id) => room.chips[id] || 0,
      setChips: (id, v) => { room.chips[id] = Math.max(0, Math.floor(v)); },
      addChips: (id, d) => { room.chips[id] = Math.max(0, Math.floor((room.chips[id] || 0) + d)); },
      log: (text) => this.system(room, text),
    };
  }

  // --- commands from players -----------------------------------------------------

  command(code, ws, msg) {
    const room = this.get(code);
    const me = ws.player.id;
    const member = room.members.get(me);
    if (!member) throw new Error('You are not in this room');
    const isHost = room.hostId === me;
    const hostOnly = () => { if (!isHost) throw new Error('Only the host can do that'); };
    const lobbyOnly = () => { if (room.game) throw new Error('Finish the current game first'); };

    switch (msg.t) {
      case 'chat': {
        const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 300);
        if (!text) return;
        room.chat.push({ from: me, name: member.name, text, at: Date.now() });
        if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
        break;
      }
      case 'selectGame':
        hostOnly(); lobbyOnly();
        if (!GAMES[msg.game]) throw new Error('Unknown game');
        room.gameId = msg.game;
        break;
      case 'setOption': {
        hostOnly(); lobbyOnly();
        const g = GAMES[room.gameId];
        const opt = g.meta.options.find((o) => o.key === msg.key);
        if (!opt) throw new Error('Unknown option');
        const v = Math.floor(Number(msg.value));
        if (!Number.isFinite(v)) throw new Error('Enter a number');
        room.options[room.gameId][opt.key] = Math.max(opt.min, Math.min(opt.max, v));
        break;
      }
      case 'setStartingChips': {
        hostOnly();
        const v = Math.floor(Number(msg.value));
        if (!(v >= 10 && v <= 1000000)) throw new Error('Starting chips must be 10 - 1,000,000');
        room.settings.startingChips = v;
        break;
      }
      case 'togglePlaying': {
        const target = msg.id && msg.id !== me ? (hostOnly(), room.members.get(msg.id)) : member;
        if (!target) throw new Error('No such player');
        target.playing = !target.playing;
        break;
      }
      case 'shuffleSeats': {
        hostOnly(); lobbyOnly();
        const entries = [...room.members.entries()];
        for (let i = entries.length - 1; i > 0; i--) {
          const j = crypto.randomInt(i + 1);
          [entries[i], entries[j]] = [entries[j], entries[i]];
        }
        room.members = new Map(entries);
        this.system(room, 'Seats shuffled');
        break;
      }
      case 'addBot': {
        hostOnly();
        const bots = [...room.members.values()].filter((m) => m.isBot);
        if (bots.length >= 8) throw new Error('That is plenty of bots');
        const used = new Set(bots.map((b) => b.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${bots.length + 1}`;
        const id = 'bot_' + crypto.randomBytes(4).toString('hex');
        room.members.set(id, { id, name, isBot: true, playing: true, sockets: new Set(), disconnectedAt: null });
        this.ensureBank(room, id);
        this.system(room, `${name} (bot) sat down`);
        break;
      }
      case 'kick': {
        hostOnly();
        const target = room.members.get(msg.id);
        if (!target || target.id === me) throw new Error('No such player');
        if (room.game && room.game.playerIds.includes(target.id) && !room.game.over) throw new Error("They're in the current game");
        room.members.delete(target.id);
        for (const s of target.sockets) { s.roomCode = null; s.send(JSON.stringify({ t: 'left', kicked: true })); }
        this.system(room, `${target.name} was removed`);
        break;
      }
      case 'rebuy': {
        const amount = room.settings.startingChips;
        room.chips[me] = (room.chips[me] || 0) + amount;
        room.buyins[me] = (room.buyins[me] || 0) + amount;
        this.system(room, `${member.name} bought in for another ${amount} chips`);
        break;
      }
      case 'botRebuy': {
        hostOnly();
        const bot = room.members.get(msg.id);
        if (!bot || !bot.isBot) throw new Error('No such bot');
        const amount = room.settings.startingChips;
        room.chips[bot.id] = (room.chips[bot.id] || 0) + amount;
        room.buyins[bot.id] = (room.buyins[bot.id] || 0) + amount;
        break;
      }
      case 'resetScores':
        hostOnly(); lobbyOnly();
        for (const id of room.members.keys()) {
          room.chips[id] = room.settings.startingChips;
          room.buyins[id] = room.settings.startingChips;
        }
        room.stats = {};
        room.history = [];
        this.system(room, 'Host reset all chips and scores');
        break;
      case 'start':
        hostOnly(); lobbyOnly();
        this.startGame(room);
        break;
      case 'sitIn': {
        const g = room.game;
        if (!g || g.over || !g.module.meta.allowJoinMidGame) throw new Error("You can't join this game now");
        if (g.playerIds.includes(me)) return;
        g.module.addPlayer(g.state, { id: me, name: member.name });
        g.playerIds.push(me);
        member.playing = true;
        this.system(room, `${member.name} joined the table`);
        break;
      }
      case 'act': {
        const g = room.game;
        if (!g || g.over) throw new Error('No game running');
        if (!g.playerIds.includes(me)) throw new Error("You're watching this game");
        this.applyAction(room, me, msg.action || {});
        break;
      }
      case 'endGame': {
        const g = room.game;
        if (!g) return;
        if (!g.over) hostOnly();
        this.endGame(room);
        break;
      }
      default:
        throw new Error('Unknown command');
    }
    this.touch(room);
  }

  // --- games -------------------------------------------------------------------------

  startGame(room) {
    const module = GAMES[room.gameId];
    const { meta } = module;
    const players = [...room.members.values()].filter((m) => m.playing && !m.left && (m.isBot || m.sockets.size));
    if (players.length < meta.minPlayers || players.length > meta.maxPlayers) {
      const need = meta.minPlayers === meta.maxPlayers ? `exactly ${meta.minPlayers}` : `${meta.minPlayers}-${meta.maxPlayers}`;
      throw new Error(`${meta.name} needs ${need} players (${players.length} ready). Add bots or toggle who's playing.`);
    }
    const options = { ...room.options[room.gameId] };
    const ctx = this.ctx(room);
    for (const p of players) this.ensureBank(room, p.id);

    let pot = 0;
    if (options.stake > 0) {
      const broke = players.filter((p) => ctx.getChips(p.id) < options.stake);
      if (broke.length) throw new Error(`${broke.map((p) => p.name).join(', ')} can't cover the ${options.stake} chip stake`);
      for (const p of players) ctx.addChips(p.id, -options.stake);
      pot = options.stake * players.length;
    }

    const startChips = {};
    const startBuyins = {};
    for (const p of players) { startChips[p.id] = room.chips[p.id]; startBuyins[p.id] = room.buyins[p.id]; }
    const state = module.create(players.map((p) => ({ id: p.id, name: p.name })), options, ctx);
    room.game = {
      id: room.gameId,
      module,
      state,
      playerIds: players.map((p) => p.id),
      startChips,
      startBuyins,
      pot,
      startedAt: Date.now(),
      over: null,
    };
    this.system(room, `${meta.name} started${pot ? ` with a ${pot} chip pot` : ''}`);
  }

  applyAction(room, id, action) {
    const g = room.game;
    g.module.act(g.state, id, action, this.ctx(room));
    if (g.state.over && !g.over) this.finishGame(room);
  }

  // A game with a natural ending (Spades, Gin) has finished.
  finishGame(room) {
    const g = room.game;
    const { winners, summary } = g.state.over;
    const ctx = this.ctx(room);
    if (g.pot) {
      const share = Math.floor(g.pot / winners.length);
      winners.forEach((w, i) => ctx.addChips(w, share + (i === 0 ? g.pot - share * winners.length : 0)));
    }
    g.over = { summary: summary + (g.pot ? ` and take the ${g.pot} chip pot` : '') };
    this.record(room, g, winners, g.over.summary);
  }

  // Host ends a session (or returns to the lobby after a finished game).
  endGame(room) {
    const g = room.game;
    if (!g.over) {
      const ctx = this.ctx(room);
      if (g.module.abort) g.module.abort(g.state, ctx);
      if (g.module.meta.continuous) {
        // Session result: net chip change per player, ignoring rebuys.
        const nets = g.playerIds.concat(Object.keys(g.startChips).filter((x) => !g.playerIds.includes(x)))
          .filter((id, i, a) => a.indexOf(id) === i && id in g.startChips)
          .map((id) => ({ id, net: (room.chips[id] - g.startChips[id]) - (room.buyins[id] - g.startBuyins[id]) }));
        nets.sort((a, b) => b.net - a.net);
        const name = (id) => (room.members.get(id) || { name: '?' }).name;
        const summary = nets.map((n) => `${name(n.id)} ${n.net >= 0 ? '+' : ''}${n.net}`).join(', ');
        const winners = nets.length && nets[0].net > 0 ? [nets[0].id] : [];
        this.record(room, g, winners, summary || 'No hands played');
      } else {
        // Abandoned Spades/Gin game: refund the stake.
        if (g.pot) for (const id of g.playerIds) ctx.addChips(id, g.pot / g.playerIds.length);
        this.system(room, `${g.module.meta.name} was abandoned`);
      }
    }
    clearTimeout(room.autoTimer);
    room.game = null;
  }

  record(room, g, winners, summary) {
    const name = (id) => (room.members.get(id) || { name: '?' }).name;
    room.history.push({
      game: g.id,
      gameName: g.module.meta.name,
      at: Date.now(),
      players: g.playerIds.map(name),
      winners: winners.map(name),
      summary,
    });
    for (const id of new Set([...g.playerIds, ...Object.keys(g.startChips)])) {
      const st = room.stats[id] || (room.stats[id] = { played: 0, wins: 0, byGame: {} });
      st.name = name(id);
      st.played++;
      const bg = st.byGame[g.id] || (st.byGame[g.id] = { played: 0, wins: 0 });
      bg.played++;
      if (winners.includes(id)) { st.wins++; bg.wins++; }
    }
    this.system(room, `🏆 ${g.module.meta.name}: ${summary}`);
  }

  // --- automatic play for bots and disconnected players ----------------------------

  scheduleAuto(room) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
    const g = room.game;
    if (!g || g.over) return;
    const now = Date.now();
    let best = null;
    for (const id of g.module.waitingOn(g.state)) {
      const m = room.members.get(id);
      let delay;
      if (!m || m.isBot) delay = BOT_DELAY + (this.trickPause(g) ? 900 : 0);
      else if (!m.sockets.size) delay = Math.max(300, AFK_GRACE - (now - (m.disconnectedAt || now)));
      else continue;
      if (!best || delay < best.delay) best = { id, delay, isBot: !m || m.isBot };
    }
    if (!best) return;
    room.autoTimer = setTimeout(() => {
      room.autoTimer = null;
      if (room.game !== g || g.over) return;
      const ctx = this.ctx(room);
      try {
        const action = g.module.autoAction(g.state, best.id, best.isBot, ctx);
        if (action) this.applyAction(room, best.id, action);
      } catch (e) {
        console.error(`Auto-play failed in ${room.code}:`, e.message);
      }
      this.touch(room);
    }, best.delay);
  }

  // Leave a finished trick on the table a moment longer before a bot leads.
  trickPause(g) {
    return g.id === 'spades' && g.state.round.trick.length === 4;
  }

  // --- broadcasting ---------------------------------------------------------------------

  touch(room) {
    room.lastActive = Date.now();
    this.broadcast(room);
    this.scheduleAuto(room);
    this.save();
  }

  broadcast(room) {
    for (const m of room.members.values()) {
      if (!m.sockets.size) continue;
      const payload = JSON.stringify({ t: 'room', room: this.viewFor(room, m.id) });
      for (const ws of m.sockets) if (ws.readyState === 1) ws.send(payload);
    }
  }

  viewFor(room, viewerId) {
    const ctx = this.ctx(room);
    const g = room.game;
    const members = [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      isBot: m.isBot,
      connected: m.isBot || m.sockets.size > 0,
      left: !!m.left,
      playing: m.playing,
      chips: room.chips[m.id] || 0,
      net: (room.chips[m.id] || 0) - (room.buyins[m.id] || 0),
      buyins: room.buyins[m.id] || 0,
      inGame: !!(g && g.playerIds.includes(m.id)),
    }));
    let game = null;
    if (g) {
      let view;
      try { view = g.module.view(g.state, viewerId, ctx); } catch (e) { view = { error: e.message }; }
      game = {
        id: g.id,
        name: g.module.meta.name,
        continuous: !!g.module.meta.continuous,
        canSitIn: !!g.module.meta.allowJoinMidGame && !g.playerIds.includes(viewerId),
        playerIds: g.playerIds,
        pot: g.pot,
        over: g.over,
        waitingOn: g.over ? [] : g.module.waitingOn(g.state),
        view,
      };
    }
    return {
      code: room.code,
      hostId: room.hostId,
      you: viewerId,
      members,
      chat: room.chat.slice(-60),
      history: room.history.slice(-30).reverse(),
      stats: room.stats,
      gameId: room.gameId,
      options: room.options,
      settings: room.settings,
      catalog: Object.values(GAMES).map((x) => x.meta),
      game,
    };
  }
}

module.exports = { Rooms, GAMES };
