/**
 * Seeded random numbers, so that a game can be replayed exactly from its seed.
 *
 * The seed itself must come from a secure random source on the server.
 * These generators only spread that seed into a deterministic shuffle.
 * ES5-safe: uses only 32-bit integer arithmetic.
 */

/** Hash a string into four 32-bit seeds (cyrb128). */
function cyrb128(str: string): number[] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ imul(h1 ^ k, 597399067);
    h2 = h3 ^ imul(h2 ^ k, 2869860233);
    h3 = h4 ^ imul(h3 ^ k, 951274213);
    h4 = h1 ^ imul(h4 ^ k, 2716044179);
  }
  h1 = imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** 32-bit integer multiply. Math.imul is ES2015, so this is the ES5 fallback. */
function imul(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff;
  const al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff;
  const bl = b & 0xffff;
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

/** A random-number function in [0, 1) seeded from a string (sfc32). */
export function seededRandom(seed: string): () => number {
  const s = cyrb128(seed);
  let a = s[0];
  let b = s[1];
  let c = s[2];
  let d = s[3];
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle in place. */
export function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
  return items;
}
