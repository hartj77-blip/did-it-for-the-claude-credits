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
    played: [], // every card played this round (public, used by bots)
    voids: [[], [], [], []], // suits each seat has shown out of (public)
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
    r.played.push(card);
    if (r.trick.length && suitOf(card) !== suitOf(r.trick[0].card)) {
      const led = suitOf(r.trick[0].card);
      if (!r.voids[seat].includes(led)) r.voids[seat].push(led);
    }
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
// Bots remember played cards and who is out of which suit (public information),
// bid with a trick estimate that includes Nil, and play to the team's situation:
// make the bid, then avoid bags, cover a partner's Nil, and try to set opponents.

const SUITS_NS = ['H', 'D', 'C'];
const bySuit = (cards) => {
  const out = { S: [], H: [], D: [], C: [] };
  for (const c of cards) out[suitOf(c)].push(c);
  for (const k of Object.keys(out)) out[k].sort((a, b) => rankOf(b) - rankOf(a));
  return out;
};

function estimateTricks(hand) {
  const suits = bySuit(hand);
  const sp = suits.S.map(rankOf);
  let tricks = 0;
  let spadeHonors = 0;
  for (const st of SUITS_NS) {
    const rs = suits[st].map(rankOf);
    const n = rs.length;
    if (rs.includes(14)) tricks += n <= 5 ? 1 : 0.6;
    if (rs.includes(13)) tricks += n >= 2 && n <= 4 ? 0.8 : n === 5 ? 0.4 : n === 1 ? 0.2 : 0;
    if (rs.includes(12) && n >= 3 && n <= 4 && (rs.includes(14) || rs.includes(13))) tricks += 0.3;
  }
  if (sp.includes(14)) { tricks += 1; spadeHonors++; }
  if (sp.includes(13)) { tricks += sp.length >= 2 ? 0.9 : 0.5; spadeHonors++; }
  if (sp.includes(12)) { tricks += sp.length >= 3 ? 0.7 : 0.3; spadeHonors++; }
  tricks += Math.max(0, sp.length - 3) * 0.85; // long spades win late tricks
  // Spare low spades can ruff short side suits.
  let spare = Math.max(0, Math.min(sp.length - spadeHonors, 3));
  for (const st of SUITS_NS) {
    const n = suits[st].length;
    if (n === 0 && spare > 0) { const use = Math.min(2, spare); tricks += use * 0.75; spare -= use; }
    else if (n === 1 && spare > 0) { tricks += 0.5; spare -= 1; }
  }
  return tricks;
}

function nilViable(hand) {
  const suits = bySuit(hand);
  const sp = suits.S.map(rankOf);
  if (sp.length > 3 || sp.some((r) => r >= 11)) return false;
  if (sp.length === 3 && sp[0] >= 9) return false;
  for (const st of SUITS_NS) {
    const rs = suits[st].map(rankOf);
    if (rs.includes(14)) return false;
    // A king or queen needs enough small cards beneath it to duck under.
    if (rs.includes(13) && rs.filter((r) => r <= 8).length < 3) return false;
    if (rs.includes(12) && rs.filter((r) => r <= 8).length < 2) return false;
    if (rs.length && rs[rs.length - 1] >= 8) return false; // nothing low to duck with
  }
  return true;
}

function chooseBid(s, seat) {
  const r = s.round;
  const hand = r.hands[seat];
  const partnerBid = r.bids[(seat + 2) % 4];
  const team = seat % 2;
  const est = estimateTricks(hand);
  if (partnerBid !== 0 && est < 2.2 && nilViable(hand)) return 0;
  let bid = Math.round(est - 0.15);
  if (s.bags[team] >= 7) bid = Math.round(est + 0.3); // bid up to soak up tricks near a bag penalty
  if (partnerBid !== null && partnerBid > 0) bid = Math.min(bid, 13 - partnerBid);
  return Math.max(1, Math.min(13, bid));
}

function teamSituation(s, seat) {
  const r = s.round;
  const need = (t) => {
    let bid = 0;
    let got = 0;
    for (const x of [t, t + 2]) if (r.bids[x] !== 0) { bid += r.bids[x]; got += r.tricks[x]; }
    return bid - got;
  };
  const us = seat % 2;
  return { ourNeed: need(us), theirNeed: need(1 - us), left: r.hands[seat].length };
}

// Is this card certain to be the highest of its suit still out (ignoring trumps)?
function isBoss(r, card, hand) {
  const st = suitOf(card);
  const rank = rankOf(card);
  for (let x = rank + 1; x <= 14; x++) {
    const c = 'xx23456789TJQKA'[x] + st;
    if (!r.played.includes(c) && !hand.includes(c)) return false;
  }
  return true;
}

function autoAction(s, id) {
  if (s.over) return null;
  const r = s.round;
  const seat = seatOf(s, id);
  if (seat !== r.turn) return null;
  const hand = r.hands[seat];

  if (r.phase === 'bidding') return { type: 'bid', bid: chooseBid(s, seat) };
  if (r.phase !== 'playing') return null;

  const legal = legalCards(s, seat);
  const play = (card) => ({ type: 'play', card });
  const low = (cards) => cards.reduce((a, c) => (rankOf(c) < rankOf(a) ? c : a));
  const high = (cards) => cards.reduce((a, c) => (rankOf(c) > rankOf(a) ? c : a));
  const nonSpade = (cards) => { const ns = cards.filter((c) => suitOf(c) !== 'S'); return ns.length ? ns : cards; };
  const trick = r.trick.length === 4 ? [] : r.trick;
  const partner = (seat + 2) % 4;
  const iAmNil = r.bids[seat] === 0;
  const partnerNil = r.bids[partner] === 0 && r.tricks[partner] === 0;
  const { ourNeed, theirNeed, left } = teamSituation(s, seat);
  // After making our bid, extra tricks are bags, unless they'd stop the other side making theirs.
  const settingThem = theirNeed > 0 && theirNeed >= left - 1;
  const wantTricks = ourNeed > 0 || settingThem;
  const opponentsVoid = (st) => [1, 3].map((d) => (seat + d) % 4).some((o) => r.voids[o].includes(st));

  // ----- leading -----
  if (trick.length === 0) {
    if (iAmNil) return play(low(nonSpade(legal)));
    const bosses = legal.filter((c) => isBoss(r, c, hand) && (suitOf(c) === 'S' || !opponentsVoid(suitOf(c))));
    if (partnerNil || wantTricks) {
      // Cash sure winners; draw out trumps first if we hold most of them.
      const spBoss = bosses.filter((c) => suitOf(c) === 'S');
      const mySpades = hand.filter((c) => suitOf(c) === 'S').length;
      const spadesOut = 13 - r.played.filter((c) => suitOf(c) === 'S').length - mySpades;
      if (spBoss.length && mySpades > spadesOut) return play(spBoss[0]);
      const sideBoss = bosses.filter((c) => suitOf(c) !== 'S');
      if (sideBoss.length) return play(high(sideBoss));
      // Lead a suit partner can trump but the opponents can't.
      const ruffable = legal.filter((c) => suitOf(c) !== 'S' && r.voids[partner].includes(suitOf(c)) && !opponentsVoid(suitOf(c)));
      if (ruffable.length && !partnerNil) return play(low(ruffable));
      // Otherwise lead low from the shortest side suit to make a void for ruffing.
      const suits = bySuit(legal);
      const side = SUITS_NS.filter((st) => suits[st].length).sort((a, b) => suits[a].length - suits[b].length);
      if (side.length) return play(suits[side[0]][suits[side[0]].length - 1]);
      return play(low(legal));
    }
    // Bid already made: lead low, and avoid leading winners that would add bags.
    const losers = legal.filter((c) => !isBoss(r, c, hand));
    return play(low(nonSpade(losers.length ? losers : legal)));
  }

  // ----- following -----
  const winningSeat = trickWinner(trick);
  const partnerWinning = winningSeat === partner;
  const canWin = legal.filter((c) => trickWinner(trick.concat({ seat, card: c })) === seat);
  const cantWin = legal.filter((c) => !canWin.includes(c));
  const last = trick.length === 3;
  const surelyHolds = (c) => last || (isBoss(r, c, hand) && (suitOf(c) === 'S' || !opponentsVoid(suitOf(c))));

  if (iAmNil) return play(cantWin.length ? high(cantWin) : low(legal));

  if (partnerNil) {
    // Take the trick high (overtaking partner if needed) so partner can duck under it.
    if (canWin.length) return play(high(canWin));
    return play(low(nonSpade(legal)));
  }

  if (partnerWinning) {
    const partnerCard = trick.find((t) => t.seat === partner).card;
    const partnerSafe = last || isBoss(r, partnerCard, hand);
    if (!partnerSafe && wantTricks && canWin.length && trick.length === 2) {
      const safeWin = canWin.filter(surelyHolds);
      if (safeWin.length) return play(low(safeWin));
    }
    // Partner has it: throw something cheap (or shed a high card if we're avoiding bags).
    if (!wantTricks && cantWin.length) return play(high(nonSpade(cantWin)));
    return play(low(nonSpade(cantWin.length ? cantWin : legal)));
  }

  if (wantTricks && canWin.length) {
    const sure = canWin.filter(surelyHolds);
    if (sure.length) return play(low(sure));
    // Not guaranteed: still take it with the cheapest winner, unless that wastes a big spade early.
    return play(low(canWin));
  }
  if (!wantTricks && cantWin.length) return play(high(cantWin)); // shed high cards safely
  return play(low(nonSpade(cantWin.length ? cantWin : legal)));
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
