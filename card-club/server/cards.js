// Cards are two-character strings: rank + suit, e.g. "AS", "TD", "9H".
const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'SHDC';

function newDeck(decks = 1) {
  const out = [];
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) for (const r of RANKS) out.push(r + s);
  }
  return out;
}

// Fisher-Yates with a CSPRNG so nobody can predict the deal.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 2..14 (ace high)
const rankOf = (c) => RANKS.indexOf(c[0]) + 2;
const suitOf = (c) => c[1];

function removeCard(hand, card) {
  const i = hand.indexOf(card);
  if (i === -1) return false;
  hand.splice(i, 1);
  return true;
}

module.exports = { RANKS, SUITS, newDeck, shuffle, rankOf, suitOf, removeCard };
