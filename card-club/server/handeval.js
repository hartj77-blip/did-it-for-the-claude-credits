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

module.exports = { evaluate5, bestHand, compareScores, describe, CATEGORY_NAMES };
