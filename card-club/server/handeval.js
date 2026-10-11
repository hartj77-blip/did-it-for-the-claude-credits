// Poker hand evaluation: best 5 of up to 7 cards.
// A hand's score is an array [category, ...tiebreak ranks]; compare lexicographically.
const { rankOf, suitOf } = require('./cards');

const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

function evaluate5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // Groups sorted by size, then rank: e.g. full house -> [[3, K], [2, 4]]
  const groups = Object.entries(counts)
    .map(([r, n]) => [n, Number(r)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map((g) => g[1]);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...byGroup];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...byGroup];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
  if (groups[0][0] === 2) return [1, ...byGroup];
  return [0, ...ranks];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function bestHand(cards) {
  let best = null;
  let bestCards = null;
  const n = cards.length;
  if (n <= 5) return { score: evaluate5(cards), cards: cards.slice() };
  const pick = [];
  (function rec(start) {
    if (pick.length === 5) {
      const hand = pick.map((i) => cards[i]);
      const s = evaluate5(hand);
      if (!best || compareScores(s, best) > 0) { best = s; bestCards = hand; }
      return;
    }
    for (let i = start; i <= n - (5 - pick.length); i++) {
      pick.push(i); rec(i + 1); pick.pop();
    }
  })(0);
  return { score: best, cards: bestCards };
}

const RANK_WORDS = { 14: 'Aces', 13: 'Kings', 12: 'Queens', 11: 'Jacks', 10: 'Tens', 9: 'Nines', 8: 'Eights', 7: 'Sevens', 6: 'Sixes', 5: 'Fives', 4: 'Fours', 3: 'Threes', 2: 'Twos' };
const RANK_WORD = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };

function describe(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8: return a === 14 ? 'Royal Flush' : `Straight Flush, ${RANK_WORD[a]} high`;
    case 7: return `Four ${RANK_WORDS[a]}`;
    case 6: return `Full House, ${RANK_WORDS[a]} full of ${RANK_WORDS[b]}`;
    case 5: return `Flush, ${RANK_WORD[a]} high`;
    case 4: return `Straight, ${RANK_WORD[a]} high`;
    case 3: return `Three ${RANK_WORDS[a]}`;
    case 2: return `Two Pair, ${RANK_WORDS[a]} and ${RANK_WORDS[b]}`;
    case 1: return `Pair of ${RANK_WORDS[a]}`;
    default: return `${RANK_WORD[a]} High`;
  }
}

// Fast 7-card evaluator for bot simulations. Cards are ints (rank * 4 + suit,
// rank 2..14). Returns one number; higher is better. Orders hands exactly like
// bestHand() but without allocating, which matters when bots run thousands of
// trial deals per decision on a phone.
const SUIT_INDEX = { S: 0, H: 1, D: 2, C: 3 };
const toInt = (c) => rankOf(c) * 4 + SUIT_INDEX[suitOf(c)];

function topStraight(mask) {
  if (mask & (1 << 14)) mask |= 1 << 1; // ace plays low too
  for (let hi = 14; hi >= 5; hi--) if (((mask >> (hi - 4)) & 31) === 31) return hi;
  return 0;
}

const counts = new Int8Array(15);
const suitCounts = new Int8Array(4);
const suitMasks = new Int32Array(4);

function score7(cards, n = cards.length) {
  counts.fill(0); suitCounts.fill(0); suitMasks.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const r = cards[i] >> 2;
    const st = cards[i] & 3;
    counts[r]++; suitCounts[st]++;
    suitMasks[st] |= 1 << r;
    rankMask |= 1 << r;
  }
  const pack = (cat, a = 0, b = 0, c = 0, d = 0, e = 0) => cat * 1048576 + a * 65536 + b * 4096 + c * 256 + d * 16 + e;

  for (let st = 0; st < 4; st++) {
    if (suitCounts[st] >= 5) {
      const sf = topStraight(suitMasks[st]);
      if (sf) return pack(8, sf);
      const top = [];
      for (let r = 14; r >= 2 && top.length < 5; r--) if (suitMasks[st] & (1 << r)) top.push(r);
      // Seven cards can hold a flush and a full house at once; the boat wins.
      const flushScore = pack(5, ...top);
      const q = quadsOrBoat(pack);
      return q > flushScore ? q : flushScore;
    }
  }
  const q = quadsOrBoat(pack);
  if (q) return q;
  const st8 = topStraight(rankMask);
  if (st8) return pack(4, st8);

  let trips = 0;
  const pairs = [];
  const singles = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 3 && !trips) trips = r;
    else if (counts[r] >= 2) pairs.push(r);
    else if (counts[r] === 1) singles.push(r);
  }
  if (trips) return pack(3, trips, singles[0], singles[1]);
  if (pairs.length >= 2) {
    const kicker = Math.max(singles[0] || 0, pairs[2] || 0);
    return pack(2, pairs[0], pairs[1], kicker);
  }
  if (pairs.length === 1) return pack(1, pairs[0], singles[0], singles[1], singles[2]);
  return pack(0, singles[0], singles[1], singles[2], singles[3], singles[4]);
}

function quadsOrBoat(pack) {
  let quad = 0;
  let trip = 0;
  let pair = 0;
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quad = r;
    else if (counts[r] === 3) { if (!trip) trip = r; else if (!pair) pair = r; }
    else if (counts[r] === 2 && !pair) pair = r;
  }
  if (quad) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) if (r !== quad && counts[r]) { kicker = r; break; }
    return pack(7, quad, kicker);
  }
  if (trip && pair) return pack(6, trip, pair);
  return 0;
}

module.exports = { evaluate5, bestHand, compareScores, describe, CATEGORY_NAMES, score7, toInt };
