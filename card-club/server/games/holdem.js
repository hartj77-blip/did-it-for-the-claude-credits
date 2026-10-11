// No-limit Texas Hold'em. Stacks come straight from the room's chip bank:
// read at the start of each hand, settled back when the hand ends.
const { newDeck, shuffle, rankOf, suitOf } = require('../cards');
const { bestHand, compareScores, describe } = require('../handeval');

const meta = {
  id: 'holdem',
  name: "Texas Hold'em",
  blurb: 'No-limit poker, 2-9 players. Bets come out of your chip stack.',
  minPlayers: 2,
  maxPlayers: 9,
  usesChips: true,
  continuous: true, // plays hand after hand until the host ends the session
  allowJoinMidGame: true,
  options: [
    { key: 'smallBlind', label: 'Small blind', min: 1, max: 1000, default: 10 },
    { key: 'bigBlind', label: 'Big blind', min: 2, max: 2000, default: 20 },
  ],
};

function create(players, options, ctx) {
  const s = {
    options: {
      smallBlind: options.smallBlind,
      bigBlind: Math.max(options.bigBlind, options.smallBlind),
    },
    seats: players.map((p) => ({ id: p.id, name: p.name, sittingOut: false, leaving: false })),
    dealerSeat: -1,
    handNo: 0,
    hand: null,
  };
  startHand(s, ctx);
  return s;
}

function addPlayer(s, p) {
  if (s.seats.some((x) => x.id === p.id)) return;
  if (s.seats.length >= meta.maxPlayers) throw new Error('Table is full');
  s.seats.push({ id: p.id, name: p.name, sittingOut: false, leaving: false });
}

function startHand(s, ctx) {
  // Players who asked to leave are dropped between hands.
  s.seats = s.seats.filter((x) => !x.leaving);
  const eligible = s.seats
    .map((seat, i) => ({ seat, i, stack: ctx.getChips(seat.id) }))
    .filter((x) => !x.seat.sittingOut && x.stack > 0);

  if (eligible.length < 2) {
    s.hand = { phase: 'waiting' };
    return;
  }

  // Move the button to the next eligible seat.
  let nextDealer = eligible.find((x) => x.i > s.dealerSeat) || eligible[0];
  s.dealerSeat = nextDealer.i;
  s.handNo++;

  const deck = shuffle(newDeck());
  const players = eligible.map((x) => ({
    id: x.seat.id,
    name: x.seat.name,
    stack: x.stack,
    startStack: x.stack,
    hole: [deck.pop(), deck.pop()],
    bet: 0,
    total: 0,
    folded: false,
    allIn: false,
    acted: false,
    lastAction: '',
  }));
  const n = players.length;
  const dealerIdx = eligible.findIndex((x) => x.i === s.dealerSeat);
  const sbIdx = n === 2 ? dealerIdx : (dealerIdx + 1) % n;
  const bbIdx = (sbIdx + 1) % n;

  const h = {
    phase: 'betting',
    deck,
    board: [],
    players,
    street: 'preflop',
    dealerIdx,
    sbIdx,
    bbIdx,
    currentBet: s.options.bigBlind,
    minRaise: s.options.bigBlind,
    toAct: -1,
    results: null,
  };
  s.hand = h;
  put(players[sbIdx], s.options.smallBlind);
  players[sbIdx].lastAction = 'SB';
  put(players[bbIdx], s.options.bigBlind);
  players[bbIdx].lastAction = 'BB';

  h.toAct = nextToAct(h, bbIdx);
  if (h.toAct === -1) endStreet(s, ctx);
}

function put(p, amount) {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.bet += a;
  p.total += a;
  if (p.stack === 0) p.allIn = true;
  return a;
}

function needsToAct(h, p) {
  return !p.folded && !p.allIn && (!p.acted || p.bet < h.currentBet);
}

function nextToAct(h, from) {
  const n = h.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (needsToAct(h, h.players[i])) return i;
  }
  return -1;
}

function live(h) {
  return h.players.filter((p) => !p.folded);
}

function act(s, playerId, action, ctx) {
  const h = s.hand;
  if (action.type === 'next') {
    if (h.phase !== 'done' && h.phase !== 'waiting') throw new Error('Hand still in progress');
    startHand(s, ctx);
    return;
  }
  if (action.type === 'sitout') {
    const seat = s.seats.find((x) => x.id === playerId);
    if (!seat) throw new Error('Not seated');
    seat.sittingOut = !!action.value;
    if (h.phase === 'waiting') startHand(s, ctx);
    return;
  }
  if (action.type === 'leave') {
    const seat = s.seats.find((x) => x.id === playerId);
    if (!seat) throw new Error('Not seated');
    seat.leaving = true;
    seat.sittingOut = true;
    // Fold right away if they are still in the hand.
    if (h.phase === 'betting') {
      const p = h.players.find((x) => x.id === playerId);
      if (p && !p.folded) {
        if (h.players[h.toAct] === p) return act(s, playerId, { type: 'fold' }, ctx);
        p.folded = true;
        p.lastAction = 'Fold';
        // The player to act hasn't changed; only check whether the hand is now over.
        const remaining = live(h);
        if (remaining.length === 1) finishUncontested(s, ctx, remaining[0]);
      }
    } else {
      s.seats = s.seats.filter((x) => !x.leaving);
    }
    return;
  }

  if (h.phase !== 'betting') throw new Error('No betting right now');
  const idx = h.toAct;
  const p = h.players[idx];
  if (!p || p.id !== playerId) throw new Error("It's not your turn");

  const toCall = h.currentBet - p.bet;
  let type = action.type;
  if (type === 'allin') {
    const to = p.bet + p.stack;
    type = to > h.currentBet ? 'raise' : 'call';
    action = { type, amount: to };
  }

  switch (type) {
    case 'fold':
      p.folded = true;
      p.lastAction = 'Fold';
      break;
    case 'check':
      if (toCall > 0) throw new Error('You must call or fold');
      p.lastAction = 'Check';
      break;
    case 'call': {
      if (toCall <= 0) { p.lastAction = 'Check'; break; }
      const paid = put(p, toCall);
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `Call ${paid}`;
      break;
    }
    case 'raise': {
      const raiseTo = Math.floor(Number(action.amount));
      const maxTo = p.bet + p.stack;
      if (!Number.isFinite(raiseTo) || raiseTo <= h.currentBet) throw new Error('Raise must be more than the current bet');
      if (raiseTo > maxTo) throw new Error("You don't have that many chips");
      const minTo = h.currentBet + h.minRaise;
      if (raiseTo < minTo && raiseTo < maxTo) throw new Error(`Minimum raise is to ${minTo}`);
      const raiseBy = raiseTo - h.currentBet;
      const wasBet = h.currentBet === 0;
      put(p, raiseTo - p.bet);
      if (raiseBy >= h.minRaise) {
        h.minRaise = raiseBy;
        // A full raise re-opens the action for everyone else.
        for (const o of h.players) if (o !== p) o.acted = false;
      }
      h.currentBet = raiseTo;
      p.lastAction = p.allIn ? `All-in ${raiseTo}` : wasBet ? `Bet ${raiseTo}` : `Raise to ${raiseTo}`;
      break;
    }
    default:
      throw new Error('Unknown action');
  }
  p.acted = true;
  afterAction(s, ctx, idx);
}

function afterAction(s, ctx, fromIdx) {
  const h = s.hand;
  const remaining = live(h);
  if (remaining.length === 1) {
    finishUncontested(s, ctx, remaining[0]);
    return;
  }
  h.toAct = nextToAct(h, fromIdx);
  if (h.toAct === -1) endStreet(s, ctx);
}

function endStreet(s, ctx) {
  const h = s.hand;
  for (;;) {
    for (const p of h.players) { p.bet = 0; p.acted = false; }
    h.currentBet = 0;
    h.minRaise = s.options.bigBlind;

    if (h.street === 'river') return showdown(s, ctx);
    if (h.street === 'preflop') { h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); h.street = 'flop'; }
    else if (h.street === 'flop') { h.board.push(h.deck.pop()); h.street = 'turn'; }
    else if (h.street === 'turn') { h.board.push(h.deck.pop()); h.street = 'river'; }

    for (const p of h.players) if (!p.folded && !p.allIn) p.lastAction = '';
    const canAct = h.players.filter((p) => !p.folded && !p.allIn);
    if (canAct.length >= 2) {
      h.toAct = nextToAct(h, h.dealerIdx);
      if (h.toAct !== -1) return;
    }
    // Zero or one player can still bet: run the board out.
    h.toAct = -1;
  }
}

function returnUncalled(h) {
  const sorted = h.players.map((p) => p.total).sort((a, b) => b - a);
  const top = h.players.find((p) => p.total === sorted[0]);
  const excess = sorted[0] - (sorted[1] || 0);
  if (excess > 0) {
    top.total -= excess;
    top.stack += excess;
  }
}

function finishUncontested(s, ctx, winner) {
  const h = s.hand;
  returnUncalled(h);
  const pot = h.players.reduce((a, p) => a + p.total, 0);
  winner.stack += pot;
  h.results = {
    showdown: false,
    pots: [{ amount: pot, winners: [winner.id] }],
    winnings: { [winner.id]: pot },
    hands: {},
  };
  ctx.log(`${winner.name} wins ${pot} (everyone else folded)`);
  endHand(s, ctx);
}

function showdown(s, ctx) {
  const h = s.hand;
  returnUncalled(h);
  const contenders = live(h);
  const scores = {};
  const hands = {};
  for (const p of contenders) {
    const b = bestHand(p.hole.concat(h.board));
    scores[p.id] = b.score;
    hands[p.id] = { name: describe(b.score), cards: b.cards };
  }

  // Build main pot + side pots from each all-in level.
  const levels = [...new Set(contenders.map((p) => p.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const L of levels) {
    let amount = 0;
    for (const p of h.players) amount += Math.max(0, Math.min(p.total, L) - prev);
    const eligible = contenders.filter((p) => p.total >= L);
    if (amount > 0) pots.push({ amount, eligible });
    prev = L;
  }
  // Anything left over (shouldn't happen after returnUncalled) joins the last pot.
  const counted = pots.reduce((a, p) => a + p.amount, 0);
  const totalIn = h.players.reduce((a, p) => a + p.total, 0);
  if (pots.length && totalIn > counted) pots[pots.length - 1].amount += totalIn - counted;

  const winnings = {};
  const n = h.players.length;
  const seatOrder = (id) => (h.players.findIndex((p) => p.id === id) - h.dealerIdx - 1 + n) % n;
  const potResults = [];
  for (const pot of pots) {
    let best = null;
    let winners = [];
    for (const p of pot.eligible) {
      const c = best ? compareScores(scores[p.id], best) : 1;
      if (c > 0) { best = scores[p.id]; winners = [p]; }
      else if (c === 0) winners.push(p);
    }
    winners.sort((a, b) => seatOrder(a.id) - seatOrder(b.id));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const w of winners) {
      const amt = share + (odd-- > 0 ? 1 : 0);
      w.stack += amt;
      winnings[w.id] = (winnings[w.id] || 0) + amt;
    }
    potResults.push({ amount: pot.amount, winners: winners.map((w) => w.id) });
  }

  h.results = { showdown: true, pots: potResults, winnings, hands };
  for (const [id, amt] of Object.entries(winnings)) {
    const p = h.players.find((x) => x.id === id);
    ctx.log(`${p.name} wins ${amt} with ${hands[id].name}`);
  }
  endHand(s, ctx);
}

function endHand(s, ctx) {
  const h = s.hand;
  h.phase = 'done';
  h.toAct = -1;
  // Apply as a delta so a rebuy made mid-hand isn't overwritten.
  for (const p of h.players) ctx.addChips(p.id, p.stack - p.startStack);
}

// Chips only move when a hand ends, so ending the session mid-hand simply cancels it.
function abort() {}

function waitingOn(s) {
  const h = s.hand;
  if (h.phase !== 'betting' || h.toAct < 0) return [];
  return [h.players[h.toAct].id];
}

// --- Bot / auto-play ---------------------------------------------------------

function preflopStrength(hole) {
  const [a, b] = hole.map(rankOf).sort((x, y) => y - x);
  const suited = suitOf(hole[0]) === suitOf(hole[1]);
  let v = (a + b) / 28; // 0.14 .. 1
  if (a === b) v += 0.35 + a / 40;
  if (suited) v += 0.06;
  if (a - b === 1) v += 0.04;
  return Math.min(1, v);
}

function postflopStrength(hole, board) {
  const best = bestHand(hole.concat(board)).score;
  const boardOnly = board.length >= 5 ? bestHand(board).score[0] : -1;
  let v = [0.15, 0.45, 0.65, 0.75, 0.82, 0.86, 0.92, 0.97, 1][best[0]];
  if (best[0] === 1) v += (best[1] - 8) / 40; // pair quality
  if (best[0] <= boardOnly) v -= 0.25; // playing the board
  return Math.max(0, Math.min(1, v));
}

function autoAction(s, id, isBot) {
  const h = s.hand;
  const idx = h.toAct;
  const p = h.players[idx];
  if (!p || p.id !== id) return null;
  const toCall = h.currentBet - p.bet;
  if (!isBot) return toCall > 0 ? { type: 'fold' } : { type: 'check' };

  const strength = h.street === 'preflop' ? preflopStrength(p.hole) : postflopStrength(p.hole, h.board);
  const pot = h.players.reduce((a, x) => a + x.total, 0);
  const potOdds = toCall / Math.max(1, pot + toCall);
  const r = Math.random() * 0.15;
  const x = strength + r;

  if (x > 0.85 && p.stack > toCall) {
    const target = h.currentBet + Math.max(h.minRaise, Math.floor(pot * (0.5 + Math.random() * 0.5)));
    const raiseTo = Math.min(p.bet + p.stack, target);
    if (raiseTo > h.currentBet) return { type: 'raise', amount: raiseTo };
  }
  if (toCall === 0) return { type: 'check' };
  if (x > 0.45 + potOdds * 0.6 || (toCall <= s.options.bigBlind && x > 0.4)) return { type: 'call' };
  return { type: 'fold' };
}

// --- View --------------------------------------------------------------------

function view(s, viewerId, ctx) {
  const h = s.hand;
  const out = {
    options: s.options,
    handNo: s.handNo,
    phase: h.phase,
    seats: s.seats.map((seat, i) => ({
      id: seat.id,
      name: seat.name,
      sittingOut: seat.sittingOut,
      dealer: i === s.dealerSeat,
      stack: ctx.getChips(seat.id),
      inHand: false,
    })),
  };
  if (h.phase === 'waiting') return out;

  const pot = h.players.reduce((a, p) => a + p.total, 0);
  out.board = h.board;
  out.street = h.street;
  out.pot = pot;
  out.currentBet = h.currentBet;
  out.toAct = h.toAct >= 0 ? h.players[h.toAct].id : null;
  out.results = h.results;

  for (const seat of out.seats) {
    const idx = h.players.findIndex((p) => p.id === seat.id);
    if (idx === -1) continue;
    const p = h.players[idx];
    const reveal = p.id === viewerId || (h.results && h.results.showdown && !p.folded);
    Object.assign(seat, {
      inHand: true,
      stack: p.stack,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      lastAction: p.lastAction,
      hole: reveal ? p.hole : null,
      sb: idx === h.sbIdx,
      bb: idx === h.bbIdx,
    });
  }

  const me = h.players[h.toAct];
  if (h.phase === 'betting' && me && me.id === viewerId) {
    const toCall = h.currentBet - me.bet;
    const maxTo = me.bet + me.stack;
    out.legal = {
      canCheck: toCall <= 0,
      callAmount: Math.min(toCall, me.stack),
      canRaise: maxTo > h.currentBet,
      minRaiseTo: Math.min(h.currentBet + h.minRaise, maxTo),
      maxRaiseTo: maxTo,
      pot,
    };
  }
  return out;
}

module.exports = { meta, create, act, view, waitingOn, autoAction, abort, addPlayer };
