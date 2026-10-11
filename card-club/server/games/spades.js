// Partnership Spades for exactly 4 players. Seats 0 & 2 vs 1 & 3.
const { newDeck, shuffle, rankOf, suitOf, removeCard } = require('../cards');

const meta = {
  id: 'spades',
  name: 'Spades',
  blurb: '4 players in two partnerships. Bid, take tricks, watch your bags.',
  minPlayers: 4,
  maxPlayers: 4,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'target', label: 'Points to win', min: 100, max: 1000, step: 50, default: 500 },
    { key: 'stake', label: 'Chip stake per player (winners split the pot)', min: 0, max: 100000, step: 10, default: 0 },
  ],
};

const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 };
const sortHand = (hand) => hand.sort((a, b) => SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)] || rankOf(b) - rankOf(a));
const teamOf = (seat) => seat % 2;

function create(players, options) {
  const s = {
    options: { target: options.target },
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: [0, 0],
    bags: [0, 0],
    dealer: Math.floor(Math.random() * 4),
    roundNo: 0,
    history: [],
    round: null,
    over: null,
  };
  deal(s);
  return s;
}

function deal(s) {
  s.dealer = (s.dealer + 1) % 4;
  s.roundNo++;
  const deck = shuffle(newDeck());
  const hands = [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13)));
  s.round = {
    phase: 'bidding',
    hands,
    bids: [null, null, null, null],
    tricks: [0, 0, 0, 0],
    trick: [],
    lastTrick: null,
    turn: (s.dealer + 1) % 4,
    spadesBroken: false,
    summary: null,
  };
}

function seatOf(s, id) {
  return s.players.findIndex((p) => p.id === id);
}

function legalCards(s, seat) {
  const r = s.round;
  const hand = r.hands[seat];
  if (r.trick.length === 0 || r.trick.length === 4) {
    if (r.spadesBroken) return hand.slice();
    const nonSpades = hand.filter((c) => suitOf(c) !== 'S');
    return nonSpades.length ? nonSpades : hand.slice();
  }
  const led = suitOf(r.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

function trickWinner(trick) {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const ts = suitOf(t.card);
    const bs = suitOf(best.card);
    // Off-suit non-spades can never win; best is always the led suit or a spade.
    if ((ts === bs && rankOf(t.card) > rankOf(best.card)) || (ts === 'S' && bs !== 'S')) best = t;
  }
  return best.seat;
}

function act(s, playerId, action, ctx) {
  if (s.over) throw new Error('Game over');
  const r = s.round;
  const seat = seatOf(s, playerId);
  if (seat === -1) throw new Error("You're not in this game");

  if (action.type === 'next') {
    if (r.phase !== 'roundover') throw new Error('Round still in progress');
    deal(s);
    return;
  }
  if (r.turn !== seat) throw new Error("It's not your turn");

  if (action.type === 'bid') {
    if (r.phase !== 'bidding') throw new Error('Bidding is over');
    const bid = Math.floor(Number(action.bid));
    if (!(bid >= 0 && bid <= 13)) throw new Error('Bid 0 (nil) to 13');
    r.bids[seat] = bid;
    ctx.log(`${s.players[seat].name} bids ${bid === 0 ? 'Nil' : bid}`);
    r.turn = (seat + 1) % 4;
    if (r.bids.every((b) => b !== null)) {
      r.phase = 'playing';
      r.turn = (s.dealer + 1) % 4;
    }
    return;
  }

  if (action.type === 'play') {
    if (r.phase !== 'playing') throw new Error('Not playing yet');
    const card = action.card;
    if (!legalCards(s, seat).includes(card)) throw new Error("You can't play that card");
    if (r.trick.length === 4) { r.lastTrick = r.trick; r.trick = []; }
    removeCard(r.hands[seat], card);
    if (suitOf(card) === 'S') r.spadesBroken = true;
    r.trick.push({ seat, card });

    if (r.trick.length < 4) {
      r.turn = (seat + 1) % 4;
      return;
    }
    const w = trickWinner(r.trick);
    r.tricks[w]++;
    r.turn = w;
    r.trickWinner = w;
    if (r.hands.every((h) => h.length === 0)) scoreRound(s, ctx);
    return;
  }
  throw new Error('Unknown action');
}

function scoreRound(s, ctx) {
  const r = s.round;
  const summary = { teams: [] };
  for (const team of [0, 1]) {
    const seats = [team, team + 2];
    let delta = 0;
    let bags = 0;
    let bid = 0;
    let taken = 0;
    const notes = [];
    for (const seat of seats) {
      const name = s.players[seat].name;
      if (r.bids[seat] === 0) {
        if (r.tricks[seat] === 0) { delta += 100; notes.push(`${name} made Nil (+100)`); }
        else { delta -= 100; bags += r.tricks[seat]; notes.push(`${name} broke Nil (-100)`); }
      } else {
        bid += r.bids[seat];
        taken += r.tricks[seat];
      }
    }
    if (bid > 0) {
      if (taken >= bid) {
        delta += bid * 10 + (taken - bid);
        bags += taken - bid;
      } else {
        delta -= bid * 10;
        notes.push(`Set! (-${bid * 10})`);
      }
    }
    s.bags[team] += bags;
    if (s.bags[team] >= 10) {
      s.bags[team] -= 10;
      delta -= 100;
      notes.push('10 bags (-100)');
    }
    s.scores[team] += delta;
    summary.teams.push({ bid, taken, nilBids: seats.filter((x) => r.bids[x] === 0).length, delta, bags, notes });
  }
  summary.bids = r.bids.slice();
  summary.tricks = r.tricks.slice();
  summary.scores = s.scores.slice();
  r.summary = summary;
  r.phase = 'roundover';
  s.history.push(summary);
  ctx.log(`Round ${s.roundNo}: ${teamName(s, 0)} ${fmt(summary.teams[0].delta)}, ${teamName(s, 1)} ${fmt(summary.teams[1].delta)}`);

  const [a, b] = s.scores;
  const t = s.options.target;
  if ((a >= t || b >= t) && a !== b) {
    const win = a > b ? 0 : 1;
    s.over = {
      winners: [s.players[win].id, s.players[win + 2].id],
      summary: `${teamName(s, win)} win ${Math.max(a, b)}-${Math.min(a, b)}`,
    };
  }
}

const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);
const teamName = (s, t) => `${s.players[t].name} & ${s.players[t + 2].name}`;

function waitingOn(s) {
  if (s.over) return [];
  const r = s.round;
  if (r.phase === 'bidding' || r.phase === 'playing') return [s.players[r.turn].id];
  return [];
}

// --- Bot -----------------------------------------------------------------------

function estimateBid(hand) {
  let tricks = 0;
  const bySuit = { S: [], H: [], D: [], C: [] };
  for (const c of hand) bySuit[suitOf(c)].push(rankOf(c));
  for (const suit of ['H', 'D', 'C']) {
    const rs = bySuit[suit];
    if (rs.includes(14)) tricks += 1;
    if (rs.includes(13) && rs.length >= 2 && rs.length <= 5) tricks += 0.8;
    if (rs.length <= 1) tricks += 0.4 * Math.min(2, bySuit.S.length - 2 > 0 ? 1 : 0);
  }
  const sp = bySuit.S;
  for (const r of sp) if (r >= 12) tricks += 0.9;
  tricks += Math.max(0, sp.length - 3) * 0.8;
  return Math.max(1, Math.min(13, Math.round(tricks)));
}

function autoAction(s, id) {
  if (s.over) return null;
  const r = s.round;
  const seat = seatOf(s, id);
  if (seat !== r.turn) return null;
  const hand = r.hands[seat];

  if (r.phase === 'bidding') return { type: 'bid', bid: estimateBid(hand) };
  if (r.phase !== 'playing') return null;

  const legal = legalCards(s, seat);
  const low = (cards) => cards.reduce((a, c) => (rankOf(c) < rankOf(a) ? c : a));
  const high = (cards) => cards.reduce((a, c) => (rankOf(c) > rankOf(a) ? c : a));
  const trick = r.trick.length === 4 ? [] : r.trick;

  if (trick.length === 0) {
    const aces = legal.filter((c) => rankOf(c) === 14 && suitOf(c) !== 'S');
    if (aces.length) return { type: 'play', card: aces[0] };
    const nonSpade = legal.filter((c) => suitOf(c) !== 'S');
    return { type: 'play', card: low(nonSpade.length ? nonSpade : legal) };
  }

  const winningSeat = trickWinner(trick);
  const partnerWinning = teamOf(winningSeat) === teamOf(seat);
  const canWin = legal.filter((c) => trickWinner(trick.concat({ seat, card: c })) === seat);
  const nilPartner = r.bids[(seat + 2) % 4] === 0;
  if (partnerWinning && !nilPartner) {
    // Don't waste spades on a trick partner already has.
    const nonSpade = legal.filter((c) => suitOf(c) !== 'S');
    return { type: 'play', card: low(nonSpade.length ? nonSpade : legal) };
  }
  if (r.bids[seat] === 0) {
    const losers = legal.filter((c) => !canWin.includes(c));
    return { type: 'play', card: losers.length ? high(losers) : low(legal) };
  }
  if (canWin.length) return { type: 'play', card: low(canWin) };
  const nonSpade = legal.filter((c) => suitOf(c) !== 'S');
  return { type: 'play', card: low(nonSpade.length ? nonSpade : legal) };
}

// --- View ------------------------------------------------------------------------

function view(s, viewerId) {
  const r = s.round;
  const seat = seatOf(s, viewerId);
  return {
    options: s.options,
    roundNo: s.roundNo,
    dealer: s.dealer,
    mySeat: seat,
    players: s.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      team: teamOf(i),
      bid: r.bids[i],
      tricks: r.tricks[i],
      cardCount: r.hands[i].length,
    })),
    scores: s.scores,
    bags: s.bags,
    phase: r.phase,
    turn: r.turn,
    trick: r.trick,
    trickWinner: r.trick.length === 4 ? r.trickWinner : null,
    lastTrick: r.lastTrick,
    spadesBroken: r.spadesBroken,
    hand: seat >= 0 ? r.hands[seat] : null,
    legal: seat >= 0 && seat === r.turn && r.phase === 'playing' ? legalCards(s, seat) : [],
    summary: r.summary,
    history: s.history,
    over: s.over,
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, legalCards, trickWinner };
