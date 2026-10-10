// Blackjack against the house. Dealer stands on all 17s, blackjack pays 3:2,
// double on any two cards, split pairs (up to 4 hands), split aces get one card each.
const { newDeck, shuffle } = require('../cards');

const meta = {
  id: 'blackjack',
  name: 'Blackjack',
  blurb: 'Everyone vs. the house, 1-7 players. Bet chips, beat the dealer.',
  minPlayers: 1,
  maxPlayers: 7,
  usesChips: true,
  continuous: true,
  allowJoinMidGame: true,
  options: [
    { key: 'minBet', label: 'Minimum bet', min: 1, max: 1000, default: 10 },
    { key: 'maxBet', label: 'Maximum bet', min: 10, max: 100000, default: 500 },
    { key: 'decks', label: 'Decks in shoe', min: 1, max: 8, default: 4 },
  ],
};

const cardValue = (c) => (c[0] === 'A' ? 11 : 'TJQK'.includes(c[0]) ? 10 : Number(c[0]));

function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) { total += cardValue(c); if (c[0] === 'A') aces++; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards) => cards.length === 2 && handTotal(cards).total === 21;

function create(players, options) {
  const s = {
    options: {
      minBet: options.minBet,
      maxBet: Math.max(options.minBet, options.maxBet),
      decks: options.decks,
    },
    seats: players.map((p) => ({ id: p.id, name: p.name, leaving: false })),
    shoe: [],
    roundNo: 0,
  };
  newRound(s);
  return s;
}

function addPlayer(s, p) {
  if (s.seats.some((x) => x.id === p.id)) return;
  if (s.seats.length >= meta.maxPlayers) throw new Error('Table is full');
  s.seats.push({ id: p.id, name: p.name, leaving: false });
}

function draw(s) {
  if (!s.shoe.length) s.shoe = shuffle(newDeck(s.options.decks));
  return s.shoe.pop();
}

function newRound(s) {
  s.seats = s.seats.filter((x) => !x.leaving);
  if (s.shoe.length < 52 * s.options.decks * 0.25) {
    s.shoe = shuffle(newDeck(s.options.decks));
    s.reshuffled = true;
  } else s.reshuffled = false;
  s.roundNo++;
  s.phase = 'betting';
  s.bets = {};
  s.skipping = {};
  s.hands = {};
  s.dealer = [];
  s.turn = null;
}

function act(s, playerId, action, ctx) {
  const seat = s.seats.find((x) => x.id === playerId);
  if (!seat) throw new Error("You're not at the table");

  if (action.type === 'leave') {
    seat.leaving = true;
    if (s.phase === 'betting') {
      s.seats = s.seats.filter((x) => !x.leaving);
      delete s.bets[playerId];
      maybeDeal(s, ctx);
    } else if (s.phase === 'playing' && s.turn && s.turn.id === playerId) {
      for (const h of s.hands[playerId]) h.done = true;
      advance(s, ctx);
    }
    return;
  }

  if (s.phase === 'betting') {
    if (action.type === 'bet') {
      const amount = Math.floor(Number(action.amount));
      if (!(amount >= s.options.minBet && amount <= s.options.maxBet)) {
        throw new Error(`Bet between ${s.options.minBet} and ${s.options.maxBet}`);
      }
      if (amount > ctx.getChips(playerId)) throw new Error("You don't have enough chips");
      s.bets[playerId] = amount;
      delete s.skipping[playerId];
      maybeDeal(s, ctx);
      return;
    }
    if (action.type === 'skip') {
      delete s.bets[playerId];
      s.skipping[playerId] = true;
      maybeDeal(s, ctx);
      return;
    }
    if (action.type === 'deal') {
      if (!Object.keys(s.bets).length) throw new Error('Nobody has bet yet');
      deal(s, ctx);
      return;
    }
    throw new Error('Place your bet');
  }

  if (s.phase === 'settled') {
    if (action.type === 'next') { newRound(s); return; }
    throw new Error('Round is over');
  }

  if (s.phase !== 'playing' || !s.turn || s.turn.id !== playerId) throw new Error("It's not your turn");
  const hands = s.hands[playerId];
  const hand = hands[s.turn.hand];

  switch (action.type) {
    case 'hit':
      hand.cards.push(draw(s));
      if (handTotal(hand.cards).total >= 21) hand.done = true;
      break;
    case 'stand':
      hand.done = true;
      break;
    case 'double':
      if (hand.cards.length !== 2) throw new Error('You can only double on your first two cards');
      if (ctx.getChips(playerId) < hand.bet) throw new Error('Not enough chips to double');
      ctx.addChips(playerId, -hand.bet);
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(draw(s));
      hand.done = true;
      break;
    case 'split': {
      if (!canSplit(hand, hands, ctx.getChips(playerId))) throw new Error("You can't split this hand");
      ctx.addChips(playerId, -hand.bet);
      const second = { cards: [hand.cards.pop()], bet: hand.bet, done: false, split: true };
      hand.split = true;
      hand.cards.push(draw(s));
      second.cards.push(draw(s));
      hands.splice(s.turn.hand + 1, 0, second);
      if (hand.cards[0][0] === 'A') { hand.done = true; second.done = true; }
      else {
        if (handTotal(hand.cards).total === 21) hand.done = true;
        if (handTotal(second.cards).total === 21) second.done = true;
      }
      break;
    }
    default:
      throw new Error('Unknown action');
  }
  advance(s, ctx);
}

function canSplit(hand, hands, chips) {
  return hand.cards.length === 2
    && cardValue(hand.cards[0]) === cardValue(hand.cards[1])
    && hands.length < 4
    && chips >= hand.bet;
}

function maybeDeal(s, ctx) {
  const pending = s.seats.filter((x) => !(x.id in s.bets) && !s.skipping[x.id]);
  if (pending.length === 0 && Object.keys(s.bets).length) deal(s, ctx);
}

function deal(s, ctx) {
  s.phase = 'playing';
  for (const [id, bet] of Object.entries(s.bets)) {
    ctx.addChips(id, -bet);
    s.hands[id] = [{ cards: [], bet, done: false }];
  }
  const order = s.seats.filter((x) => s.hands[x.id]);
  for (let round = 0; round < 2; round++) {
    for (const x of order) s.hands[x.id][0].cards.push(draw(s));
    s.dealer.push(draw(s));
  }
  for (const x of order) {
    const h = s.hands[x.id][0];
    if (isBlackjack(h.cards)) h.done = true;
  }
  // Dealer peeks for blackjack with an ace or ten showing.
  if (isBlackjack(s.dealer)) {
    for (const x of order) for (const h of s.hands[x.id]) h.done = true;
    s.dealerBlackjack = true;
  } else s.dealerBlackjack = false;
  s.turn = null;
  advance(s, ctx);
}

function advance(s, ctx) {
  for (const seat of s.seats) {
    const hands = s.hands[seat.id];
    if (!hands) continue;
    const i = hands.findIndex((h) => !h.done);
    if (i !== -1) { s.turn = { id: seat.id, hand: i }; return; }
  }
  s.turn = null;
  dealerPlay(s);
  settle(s, ctx);
}

function dealerPlay(s) {
  const anyLive = Object.values(s.hands).some((hs) => hs.some((h) => handTotal(h.cards).total <= 21 && !(isBlackjack(h.cards) && !h.split)));
  if (!anyLive || s.dealerBlackjack) return;
  while (handTotal(s.dealer).total < 17) s.dealer.push(draw(s));
}

function settle(s, ctx) {
  const d = handTotal(s.dealer).total;
  const dealerBJ = isBlackjack(s.dealer);
  for (const seat of s.seats) {
    const hands = s.hands[seat.id];
    if (!hands) continue;
    let net = 0;
    for (const h of hands) {
      const t = handTotal(h.cards).total;
      const natural = isBlackjack(h.cards) && !h.split;
      let payout = 0;
      if (t > 21) h.result = 'Bust';
      else if (natural && !dealerBJ) { h.result = 'Blackjack!'; payout = h.bet + Math.floor(h.bet * 1.5); }
      else if (natural && dealerBJ) { h.result = 'Push'; payout = h.bet; }
      else if (dealerBJ) h.result = 'Dealer blackjack';
      else if (d > 21 || t > d) { h.result = 'Win'; payout = h.bet * 2; }
      else if (t === d) { h.result = 'Push'; payout = h.bet; }
      else h.result = 'Lose';
      h.payout = payout;
      ctx.addChips(seat.id, payout);
      net += payout - h.bet;
    }
    s.hands[seat.id].net = net;
    if (net) ctx.log(`Blackjack: ${seat.name} ${net > 0 ? 'wins' : 'loses'} ${Math.abs(net)}`);
  }
  s.phase = 'settled';
}

function abort(s, ctx) {
  // Refund bets that are on the table if the session ends mid-round.
  if (s.phase === 'playing') {
    for (const [id, hands] of Object.entries(s.hands)) for (const h of hands) ctx.addChips(id, h.bet);
  }
}

function waitingOn(s) {
  if (s.phase === 'betting') return s.seats.filter((x) => !(x.id in s.bets) && !s.skipping[x.id]).map((x) => x.id);
  if (s.phase === 'playing' && s.turn) return [s.turn.id];
  return [];
}

function autoAction(s, id, isBot, ctx) {
  if (s.phase === 'betting') {
    if (id in s.bets || s.skipping[id]) return null;
    if (!isBot) return { type: 'skip' };
    const chips = ctx.getChips(id);
    if (chips < s.options.minBet) return { type: 'skip' };
    return { type: 'bet', amount: Math.min(chips, s.options.maxBet, s.options.minBet * (1 + Math.floor(Math.random() * 3))) };
  }
  if (s.phase !== 'playing' || !s.turn || s.turn.id !== id) return null;
  if (!isBot) return { type: 'stand' };
  const hands = s.hands[id];
  const hand = hands[s.turn.hand];
  const { total, soft } = handTotal(hand.cards);
  const up = cardValue(s.dealer[0]);
  const chips = ctx.getChips(id);
  if (canSplit(hand, hands, chips)) {
    const v = cardValue(hand.cards[0]);
    if (v === 11 || v === 8) return { type: 'split' };
  }
  if (hand.cards.length === 2 && chips >= hand.bet && !soft && (total === 11 || (total === 10 && up < 10))) return { type: 'double' };
  if (soft && total <= 17) return { type: 'hit' };
  if (total <= 11) return { type: 'hit' };
  if (total <= 16 && up >= 7) return { type: 'hit' };
  if (total === 12 && up <= 3) return { type: 'hit' };
  return { type: 'stand' };
}

function view(s, viewerId, ctx) {
  const hideHole = s.phase === 'playing';
  const out = {
    options: s.options,
    roundNo: s.roundNo,
    phase: s.phase,
    reshuffled: s.reshuffled,
    shoeLeft: s.shoe.length,
    dealer: s.dealer.length ? (hideHole ? [s.dealer[0], null] : s.dealer) : [],
    dealerTotal: s.dealer.length ? handTotal(hideHole ? [s.dealer[0]] : s.dealer) : null,
    turn: s.turn,
    seats: s.seats.map((x) => ({
      id: x.id,
      name: x.name,
      chips: ctx.getChips(x.id),
      bet: s.bets[x.id] || null,
      skipping: !!s.skipping[x.id],
      net: s.hands[x.id] ? s.hands[x.id].net : undefined,
      hands: (s.hands[x.id] || []).map((h) => ({ ...h, total: handTotal(h.cards), blackjack: isBlackjack(h.cards) && !h.split })),
    })),
  };
  if (s.phase === 'playing' && s.turn && s.turn.id === viewerId) {
    const hands = s.hands[viewerId];
    const hand = hands[s.turn.hand];
    const chips = ctx.getChips(viewerId);
    out.legal = {
      canDouble: hand.cards.length === 2 && chips >= hand.bet,
      canSplit: canSplit(hand, hands, chips),
    };
  }
  return out;
}

module.exports = { meta, create, act, view, waitingOn, autoAction, abort, addPlayer, handTotal };
