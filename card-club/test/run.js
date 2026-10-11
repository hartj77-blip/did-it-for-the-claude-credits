// Engine tests: hand evaluation, meld finding, and long bot-vs-bot simulations
// that check every game runs to completion and chips are conserved.
const assert = require('assert');
const { bestHand, compareScores, describe } = require('../server/handeval');
const holdem = require('../server/games/holdem');
const spades = require('../server/games/spades');
const gin = require('../server/games/ginrummy');
const blackjack = require('../server/games/blackjack');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n`, e); process.exitCode = 1; }
}

function makeCtx(chips) {
  return {
    getChips: (id) => chips[id] || 0,
    setChips: (id, v) => { chips[id] = v; },
    addChips: (id, d) => { chips[id] = (chips[id] || 0) + d; },
    log: () => {},
  };
}

const score = (cards) => bestHand(cards.split(' ')).score;

console.log('Hand evaluation');
test('categories', () => {
  assert.strictEqual(describe(score('AS KS QS JS TS 2D 3C')), 'Royal Flush');
  assert.strictEqual(score('5S 4S 3S 2S AS KD KC')[0], 8);
  assert.strictEqual(score('9S 9H 9D 9C 2S 3D 4C')[0], 7);
  assert.strictEqual(score('9S 9H 9D 4C 4S 3D 2C')[0], 6);
  assert.strictEqual(score('2H 7H 9H JH KH 3D 4C')[0], 5);
  assert.strictEqual(score('AS 2D 3C 4H 5S KD KC')[0], 4);
  assert.strictEqual(score('AS 2D 3C 4H 5S KD KC')[1], 5);
  assert.strictEqual(score('7S 7D 7C 2H 9S KD QC')[0], 3);
  assert.strictEqual(score('7S 7D 9C 9H 2S KD QC')[0], 2);
  assert.strictEqual(score('7S 7D 9C 3H 2S KD QC')[0], 1);
  assert.strictEqual(score('7S 4D 9C 3H 2S KD QC')[0], 0);
});
test('tiebreaks', () => {
  assert(compareScores(score('AS AD KC 7H 2S 3D 4C'), score('AS AD QC 7H 2S 3D 4C')) > 0);
  assert(compareScores(score('6S 5D 4C 3H 2S 9D 9C'), score('AS 2D 3C 4H 5S 9D 9C')) > 0);
  assert.strictEqual(compareScores(score('AS KD 7C 7H 2S 3D 4C'), score('AH KC 7D 7S 2D 3H 4S')), 0);
  assert(compareScores(score('KS KD 4C 4H 2S 2D AC'), score('KS KD 4C 4H 3S 3D QC')) > 0);
});

console.log('Gin melds');
test('finds sets and runs', () => {
  const b = gin.bestMelds(['AS', '2S', '3S', '7H', '7D', '7C', 'KD', 'QD', 'JD', '5C']);
  assert.strictEqual(b.deadwood, 5);
  assert.strictEqual(b.melds.length, 3);
});
test('shares a card between a set and a run optimally', () => {
  // 7S can go in the 7-set or the 5-6-7 run; best is set of 7s (H,D,C) + run 5S6S7S.
  const b = gin.bestMelds(['5S', '6S', '7S', '7H', '7D', '7C', '2C', '3D', '4H', '9C']);
  assert.strictEqual(b.deadwood, 18);
});
test('lay off extends runs and sets', () => {
  const r = gin.layOff([['4H', '5H', '6H'], ['9S', '9D', '9C']], ['3H', '7H', '9H', 'KC']);
  assert.deepStrictEqual(r.remaining, ['KC']);
});

// Drive a game with autoAction until it waits on nobody (or the step limit).
function drive(mod, state, ids, ctx, steps, onIdle) {
  for (let i = 0; i < steps; i++) {
    const waiting = mod.waitingOn(state);
    if (!waiting.length) { if (!onIdle(state)) return i; continue; }
    const id = waiting[0];
    const a = mod.autoAction(state, id, true, ctx);
    assert(a, `no auto action for ${id}`);
    mod.act(state, id, a, ctx);
  }
  return steps;
}

console.log('Simulations');
test("hold'em: 3000 hands, chips conserved, side pots settle", () => {
  for (let table = 0; table < 30; table++) {
    const n = 2 + (table % 8);
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const chips = {};
    ids.forEach((id, i) => { chips[id] = 200 + i * 150; });
    const total = Object.values(chips).reduce((a, b) => a + b, 0);
    const ctx = makeCtx(chips);
    const s = holdem.create(ids.map((id) => ({ id, name: id })), { smallBlind: 5, bigBlind: 10 }, ctx);
    let hands = 0;
    drive(holdem, s, ids, ctx, 200000, (st) => {
      assert.strictEqual(Object.values(chips).reduce((a, b) => a + b, 0), total, 'chips not conserved');
      if (st.hand.phase === 'waiting' || hands++ >= 100) return false;
      holdem.act(st, ids[0], { type: 'next' }, ctx);
      return true;
    });
    for (const v of Object.values(chips)) assert(v >= 0);
    holdem.view(s, ids[0], ctx);
  }
});
test("hold'em: min raise and turn enforcement", () => {
  const chips = { a: 1000, b: 1000, c: 1000 };
  const ctx = makeCtx(chips);
  const s = holdem.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }], { smallBlind: 10, bigBlind: 20 }, ctx);
  const first = holdem.waitingOn(s)[0];
  const other = ['a', 'b', 'c'].find((x) => x !== first);
  assert.throws(() => holdem.act(s, other, { type: 'call' }, ctx), /not your turn/);
  assert.throws(() => holdem.act(s, first, { type: 'check' }, ctx), /call or fold/);
  assert.throws(() => holdem.act(s, first, { type: 'raise', amount: 30 }, ctx), /Minimum raise/);
  holdem.act(s, first, { type: 'raise', amount: 40 }, ctx);
  assert.strictEqual(s.hand.currentBet, 40);
});
test("hold'em bots: win estimates match known odds", () => {
  const avg = (hole, board, opp) => { let t = 0; for (let i = 0; i < 8; i++) t += holdem.estimateEquity(hole, board, opp); return t / 8; };
  const near = (v, want) => assert(Math.abs(v - want) < 0.04, `got ${v.toFixed(3)}, expected ~${want}`);
  near(avg(['AS', 'AH'], [], 1), 0.85);
  near(avg(['7S', '2H'], [], 1), 0.35);
  near(avg(['AS', 'AH'], [], 3), 0.64);
});
test("hold'em bots: never shove a deep stack with a below-average hand", () => {
  const ids = ['a', 'b', 'c', 'd'];
  const chips = {};
  const ctx = makeCtx(chips);
  const reset = () => ids.forEach((i) => { chips[i] = 1000; });
  reset();
  const s = holdem.create(ids.map((id) => ({ id, name: id })), { smallBlind: 10, bigBlind: 20 }, ctx);
  let hands = 0;
  let shoves = 0;
  while (hands < 300) {
    const w = holdem.waitingOn(s);
    if (!w.length) {
      hands++;
      if (ids.filter((i) => chips[i] > 0).length < 2 || s.hand.phase === 'waiting') reset();
      holdem.act(s, 'a', { type: 'next' }, ctx);
      continue;
    }
    const h = s.hand;
    const p = h.players[h.toAct];
    const opp = h.players.filter((x) => !x.folded).length - 1;
    const deep = p.stack + p.bet >= 15 * s.options.bigBlind;
    const a = holdem.autoAction(s, w[0], true, ctx);
    const before = p.allIn;
    holdem.act(s, w[0], a, ctx);
    if (!before && p.allIn && deep && a.type === 'raise') {
      shoves++;
      assert(holdem.estimateEquity(p.hole, h.board, opp) > 1 / (opp + 1), 'bot shoved a weak hand');
    }
  }
  assert(shoves < 60, `too many shoves: ${shoves}`);
});
test('spades: 40 full games to completion', () => {
  for (let g = 0; g < 40; g++) {
    const ids = ['a', 'b', 'c', 'd'];
    const ctx = makeCtx({});
    const s = spades.create(ids.map((id) => ({ id, name: id })), { target: 300 }, ctx);
    drive(spades, s, ids, ctx, 100000, (st) => {
      if (st.over) return false;
      spades.act(st, 'a', { type: 'next' }, ctx);
      return true;
    });
    assert(s.over, 'game did not finish');
    assert.strictEqual(s.over.winners.length, 2);
    for (const r of s.history) assert.strictEqual(r.tricks.reduce((a, b) => a + b, 0), 13);
  }
});
test('spades: must follow suit and cannot lead unbroken spades', () => {
  const ctx = makeCtx({});
  const s = spades.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 500 }, ctx);
  s.round.hands = [['AS', '2H'], ['3H', 'KS'], ['4H', '5D'], ['6H', '7C']];
  s.round.phase = 'playing';
  s.round.turn = 0;
  assert.deepStrictEqual(spades.legalCards(s, 0), ['2H']);
  spades.act(s, 'a', { type: 'play', card: '2H' }, ctx);
  assert.throws(() => spades.act(s, 'b', { type: 'play', card: 'KS' }, ctx), /can't play/);
});
test('gin rummy: 60 full games to completion', () => {
  for (let g = 0; g < 60; g++) {
    const ctx = makeCtx({});
    const s = gin.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { target: 100 }, ctx);
    drive(gin, s, ['a', 'b'], ctx, 200000, (st) => {
      if (st.over) return false;
      const r = st.round;
      if (r.result && r.result.type === 'biggin') assert.strictEqual(r.hands[r.result.knocker].length, 11);
      else for (const h of r.hands) assert.strictEqual(h.length, 10);
      gin.act(st, 'a', { type: 'next' }, ctx);
      return true;
    });
    assert(s.over);
    gin.view(s, 'a');
  }
});
test('blackjack: 2000 rounds, payouts sane', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const chips = {};
  ids.forEach((id) => { chips[id] = 100000; });
  const ctx = makeCtx(chips);
  const s = blackjack.create(ids.map((id) => ({ id, name: id })), { minBet: 10, maxBet: 500, decks: 2 }, ctx);
  let rounds = 0;
  drive(blackjack, s, ids, ctx, 400000, (st) => {
    if (rounds++ >= 2000) return false;
    assert.strictEqual(st.phase, 'settled');
    for (const id of ids) blackjack.view(st, id, ctx);
    blackjack.act(st, 'a', { type: 'next' }, ctx);
    return true;
  });
  assert(rounds >= 2000);
  const { handTotal } = blackjack;
  assert.deepStrictEqual(handTotal(['AS', 'AD', '9C']), { total: 21, soft: true });
  assert.deepStrictEqual(handTotal(['KS', 'QD', '5C']), { total: 25, soft: false });
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
