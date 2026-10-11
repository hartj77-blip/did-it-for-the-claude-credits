// Two-player Gin Rummy with automatic meld finding, layoffs and standard scoring.
const { newDeck, shuffle, suitOf, removeCard } = require('../cards');

const meta = {
  id: 'ginrummy',
  name: 'Gin Rummy',
  blurb: '2 players. Build sets and runs, knock with 10 or less deadwood.',
  minPlayers: 2,
  maxPlayers: 2,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'target', label: 'Points to win', min: 25, max: 500, step: 25, default: 100 },
    { key: 'stake', label: 'Chip stake per player (winner takes the pot)', min: 0, max: 100000, step: 10, default: 0 },
  ],
};

const GIN_BONUS = 25;
const BIG_GIN_BONUS = 31;
const UNDERCUT_BONUS = 25;
const GAME_BONUS = 100;
const BOX_BONUS = 25;

// Ace is low in gin.
const ginRank = (c) => 'A23456789TJQK'.indexOf(c[0]) + 1;
const value = (c) => Math.min(10, ginRank(c));
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 };
const byRank = (a, b) => ginRank(a) - ginRank(b) || SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)];

function allMelds(cards) {
  const melds = [];
  const ranks = {};
  for (const c of cards) (ranks[ginRank(c)] = ranks[ginRank(c)] || []).push(c);
  for (const group of Object.values(ranks)) {
    if (group.length >= 3) {
      if (group.length === 4) {
        melds.push(group.slice());
        for (let skip = 0; skip < 4; skip++) melds.push(group.filter((_, i) => i !== skip));
      } else melds.push(group.slice());
    }
  }
  const suits = {};
  for (const c of cards) (suits[suitOf(c)] = suits[suitOf(c)] || []).push(c);
  for (const group of Object.values(suits)) {
    group.sort(byRank);
    for (let i = 0; i < group.length; i++) {
      let j = i;
      while (j + 1 < group.length && ginRank(group[j + 1]) === ginRank(group[j]) + 1) {
        j++;
        if (j - i >= 2) melds.push(group.slice(i, j + 1));
      }
    }
  }
  return melds;
}

// Minimum-deadwood arrangement of a hand.
function bestMelds(cards) {
  const melds = allMelds(cards);
  const total = cards.reduce((a, c) => a + value(c), 0);
  let best = { deadwood: total, melds: [] };
  const used = new Set();
  const chosen = [];
  (function rec(start, meldedValue) {
    const dw = total - meldedValue;
    if (dw < best.deadwood) best = { deadwood: dw, melds: chosen.map((m) => m.slice()) };
    for (let k = start; k < melds.length; k++) {
      const m = melds[k];
      if (m.some((c) => used.has(c))) continue;
      m.forEach((c) => used.add(c));
      chosen.push(m);
      rec(k + 1, meldedValue + m.reduce((a, c) => a + value(c), 0));
      chosen.pop();
      m.forEach((c) => used.delete(c));
    }
  })(0, 0);
  const inMeld = new Set(best.melds.flat());
  best.deadCards = cards.filter((c) => !inMeld.has(c)).sort(byRank);
  best.melds.forEach((m) => m.sort(byRank));
  return best;
}

function isSet(meld) {
  return meld.every((c) => ginRank(c) === ginRank(meld[0]));
}

// Lay the defender's loose cards onto the knocker's melds wherever they fit.
function layOff(knockerMelds, deadCards) {
  const melds = knockerMelds.map((m) => m.slice());
  let remaining = deadCards.slice();
  const laid = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of remaining.slice()) {
      for (const m of melds) {
        let fits = false;
        if (isSet(m)) fits = m.length < 4 && ginRank(c) === ginRank(m[0]);
        else if (suitOf(c) === suitOf(m[0])) {
          const lo = ginRank(m[0]);
          const hi = ginRank(m[m.length - 1]);
          fits = ginRank(c) === lo - 1 || ginRank(c) === hi + 1;
        }
        if (fits) {
          m.push(c);
          m.sort(byRank);
          laid.push(c);
          remaining = remaining.filter((x) => x !== c);
          changed = true;
          break;
        }
      }
    }
  }
  return { melds, laid, remaining };
}

function create(players, options) {
  const s = {
    options: { target: options.target },
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: [0, 0],
    handsWon: [0, 0],
    dealer: Math.floor(Math.random() * 2),
    roundNo: 0,
    history: [],
    round: null,
    over: null,
  };
  deal(s);
  return s;
}

function deal(s) {
  s.dealer = 1 - s.dealer;
  s.roundNo++;
  const stock = shuffle(newDeck());
  const hands = [stock.splice(0, 10).sort(byRank), stock.splice(0, 10).sort(byRank)];
  s.round = {
    phase: 'draw',
    hands,
    stock,
    discard: [stock.pop()],
    turn: 1 - s.dealer,
    takenFromDiscard: null,
    lastDraw: null,
    result: null,
  };
}

const seatOf = (s, id) => s.players.findIndex((p) => p.id === id);

function act(s, playerId, action, ctx) {
  if (s.over) throw new Error('Game over');
  const r = s.round;
  const seat = seatOf(s, playerId);
  if (seat === -1) throw new Error("You're not in this game");

  if (action.type === 'next') {
    if (r.phase !== 'roundover') throw new Error('Hand still in progress');
    deal(s);
    return;
  }
  if (r.turn !== seat) throw new Error("It's not your turn");
  const hand = r.hands[seat];
  const name = s.players[seat].name;

  if (action.type === 'draw') {
    if (r.phase !== 'draw') throw new Error('You already drew');
    let card;
    if (action.from === 'discard') {
      if (!r.discard.length) throw new Error('Discard pile is empty');
      card = r.discard.pop();
      r.takenFromDiscard = card;
      ctx.log(`${name} takes the ${cardName(card)}`);
    } else {
      card = r.stock.pop();
      r.takenFromDiscard = null;
    }
    hand.push(card);
    r.lastDraw = { seat, card, from: action.from === 'discard' ? 'discard' : 'stock' };
    r.phase = 'discard';
    return;
  }

  if (action.type === 'discard' || action.type === 'knock') {
    if (r.phase !== 'discard') throw new Error('Draw a card first');
    const card = action.card;

    if (action.type === 'knock' && !card) {
      // Big gin: all 11 cards melded, no discard.
      const b = bestMelds(hand);
      if (b.deadwood !== 0) throw new Error('Big Gin needs all 11 cards melded');
      return resolveKnock(s, seat, ctx, true);
    }
    if (!hand.includes(card)) throw new Error("You don't have that card");
    if (card === r.takenFromDiscard) throw new Error("You can't discard the card you just picked up");

    if (action.type === 'knock') {
      const rest = hand.filter((c) => c !== card);
      if (bestMelds(rest).deadwood > 10) throw new Error('You need 10 or less deadwood to knock');
    }
    removeCard(hand, card);
    r.discard.push(card);
    r.takenFromDiscard = null;
    r.lastDraw = null;

    if (action.type === 'knock') return resolveKnock(s, seat, ctx, false);

    if (r.stock.length <= 2) {
      r.phase = 'roundover';
      r.result = { type: 'draw', text: 'Stock ran out. No score this hand.' };
      s.history.push({ text: 'Draw', scores: s.scores.slice() });
      ctx.log('Gin Rummy: stock ran out, hand is a draw');
      return;
    }
    r.turn = 1 - seat;
    r.phase = 'draw';
    return;
  }
  throw new Error('Unknown action');
}

function resolveKnock(s, seat, ctx, bigGin) {
  const r = s.round;
  const other = 1 - seat;
  const k = bestMelds(r.hands[seat]);
  const d = bestMelds(r.hands[other]);
  const kn = s.players[seat].name;
  const dn = s.players[other].name;
  let winner;
  let points;
  let type;
  let layoff = { melds: k.melds, laid: [], remaining: d.deadCards };
  let defenderDeadwood = d.deadwood;

  if (bigGin) {
    type = 'biggin'; winner = seat; points = BIG_GIN_BONUS + d.deadwood;
  } else if (k.deadwood === 0) {
    type = 'gin'; winner = seat; points = GIN_BONUS + d.deadwood;
  } else {
    layoff = layOff(k.melds, d.deadCards);
    defenderDeadwood = layoff.remaining.reduce((a, c) => a + value(c), 0);
    if (k.deadwood < defenderDeadwood) {
      type = 'knock'; winner = seat; points = defenderDeadwood - k.deadwood;
    } else {
      type = 'undercut'; winner = other; points = UNDERCUT_BONUS + k.deadwood - defenderDeadwood;
    }
  }

  s.scores[winner] += points;
  s.handsWon[winner]++;
  const label = { biggin: 'Big Gin', gin: 'Gin', knock: 'Knock', undercut: 'Undercut' }[type];
  const text = type === 'undercut'
    ? `${kn} knocked with ${k.deadwood}, but ${dn} undercut with ${defenderDeadwood}! ${dn} scores ${points}.`
    : `${kn} ${type === 'knock' ? `knocks with ${k.deadwood}` : `goes ${label}`}. ${dn} has ${defenderDeadwood} deadwood. ${kn} scores ${points}.`;
  r.result = {
    type,
    label,
    knocker: seat,
    winner,
    points,
    text,
    knockerMelds: layoff.melds,
    knockerDead: k.deadCards,
    knockerDeadwood: k.deadwood,
    defenderMelds: d.melds,
    defenderLaid: layoff.laid,
    defenderDead: layoff.remaining,
    defenderDeadwood,
  };
  r.phase = 'roundover';
  s.history.push({ text: `${label}: ${s.players[winner].name} +${points}`, scores: s.scores.slice() });
  ctx.log(`Gin Rummy: ${text}`);

  if (s.scores[winner] >= s.options.target) {
    const loser = 1 - winner;
    const final = [0, 1].map((i) => s.scores[i] + s.handsWon[i] * BOX_BONUS + (i === winner ? GAME_BONUS : 0));
    s.finalScores = final;
    s.over = {
      winners: [s.players[winner].id],
      summary: `${s.players[winner].name} wins ${final[winner]} to ${final[loser]} (incl. game & box bonuses)`,
    };
  }
}

function cardName(c) {
  const r = { A: 'Ace', T: '10', J: 'Jack', Q: 'Queen', K: 'King' }[c[0]] || c[0];
  return `${r} of ${{ S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[c[1]]}`;
}

function waitingOn(s) {
  if (s.over || s.round.phase === 'roundover') return [];
  return [s.players[s.round.turn].id];
}

// --- Bot -----------------------------------------------------------------------

function bestDiscard(hand, forbidden) {
  let best = null;
  for (const c of hand) {
    if (c === forbidden) continue;
    const dw = bestMelds(hand.filter((x) => x !== c)).deadwood;
    if (!best || dw < best.dw || (dw === best.dw && value(c) > value(best.card))) best = { card: c, dw };
  }
  return best;
}

function autoAction(s, id) {
  if (s.over) return null;
  const r = s.round;
  const seat = seatOf(s, id);
  if (seat !== r.turn) return null;
  const hand = r.hands[seat];

  if (r.phase === 'draw') {
    const top = r.discard[r.discard.length - 1];
    if (top) {
      const now = bestMelds(hand).deadwood;
      const withTop = bestDiscard(hand.concat(top), top);
      if (withTop && withTop.dw < now - 1) return { type: 'draw', from: 'discard' };
    }
    return { type: 'draw', from: 'stock' };
  }
  if (r.phase === 'discard') {
    if (bestMelds(hand).deadwood === 0) return { type: 'knock' };
    const d = bestDiscard(hand, r.takenFromDiscard);
    if (d.dw <= 10 && (d.dw <= 4 || r.stock.length < 20)) return { type: 'knock', card: d.card };
    return { type: 'discard', card: d.card };
  }
  return null;
}

// --- View ------------------------------------------------------------------------

function view(s, viewerId) {
  const r = s.round;
  const seat = seatOf(s, viewerId);
  const out = {
    options: s.options,
    roundNo: s.roundNo,
    mySeat: seat,
    players: s.players.map((p, i) => ({ id: p.id, name: p.name, cardCount: r.hands[i].length, score: s.scores[i], handsWon: s.handsWon[i] })),
    phase: r.phase,
    turn: r.turn,
    dealer: s.dealer,
    stockCount: r.stock.length,
    discardTop: r.discard[r.discard.length - 1] || null,
    discardCount: r.discard.length,
    result: r.result,
    history: s.history,
    finalScores: s.finalScores || null,
    over: s.over,
    bonuses: { gin: GIN_BONUS, bigGin: BIG_GIN_BONUS, undercut: UNDERCUT_BONUS, game: GAME_BONUS, box: BOX_BONUS },
  };
  // Opponent's draw from the discard pile is public; a stock draw is not.
  if (r.lastDraw && (r.lastDraw.from === 'discard' || r.lastDraw.seat === seat)) out.lastDraw = r.lastDraw;
  if (seat >= 0) {
    const hand = r.hands[seat];
    const b = bestMelds(hand);
    out.hand = hand;
    out.melds = b.melds;
    out.deadCards = b.deadCards;
    out.deadwood = b.deadwood;
    out.takenFromDiscard = r.takenFromDiscard;
    if (r.phase === 'discard' && r.turn === seat) {
      // Deadwood left after discarding each card, so the UI can show when knocking is allowed.
      out.discardOptions = {};
      for (const c of hand) out.discardOptions[c] = bestMelds(hand.filter((x) => x !== c)).deadwood;
      out.canBigGin = b.deadwood === 0;
    }
  }
  if (r.phase === 'roundover') out.hands = r.hands;
  return out;
}

module.exports = { meta, create, act, view, waitingOn, autoAction, bestMelds, layOff };
