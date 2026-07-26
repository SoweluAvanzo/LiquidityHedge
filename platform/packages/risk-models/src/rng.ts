/**
 * Deterministic RNG for simulations. Mulberry32 uniform + Box-Muller
 * gaussian with the spare-value cache. Same seed ⇒ bit-identical paths
 * (FR-S4 reproducibility), so every model MUST draw exclusively from an
 * injected Rng and never from Math.random.
 */

export interface Rng {
  uniform(): number;
  gaussian(): number;
}

export function makeRng(seed: number): Rng {
  let state = seed | 0;
  let spare: number | null = null;

  const uniform = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const gaussian = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = Math.max(uniform(), 1e-12);
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };

  return { uniform, gaussian };
}
