// Browser stand-in for the bits of Node's `crypto` the engine uses.
function randomInt(max) {
  // Rejection sampling so every value is equally likely.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % max;
}

function randomBytes(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return {
    toString(enc) {
      if (enc !== 'hex') throw new Error('only hex supported');
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
}

module.exports = { randomInt, randomBytes };
