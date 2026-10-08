import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  itemWeight,
  pick,
  recencyScores,
  validateSettings,
  weighCandidates,
  weightedDraw,
  type Candidate,
  type Rng,
} from '../src/weighting.js';

/** mulberry32: small deterministic PRNG for reproducible tests. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const s = DEFAULT_SETTINGS;
const items = (n: number, categoryId = 'c1'): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${categoryId}-i${i}`, categoryId }));

describe('weights (defaults λ=0.7, k=4, floor=0.03)', () => {
  it('never picked → 1', () => {
    expect(itemWeight('a', [], s)).toBe(1);
    expect(itemWeight('a', ['b', 'c'], s)).toBe(1);
  });

  it('picked last time → 0.20', () => {
    expect(itemWeight('a', ['a'], s)).toBeCloseTo(0.2, 10);
  });

  it('picked last two times → ~0.13', () => {
    // score = 1 + 0.7 = 1.7 → 1 / 7.8
    expect(itemWeight('a', ['a', 'a'], s)).toBeCloseTo(1 / 7.8, 10);
    expect(itemWeight('a', ['a', 'a'], s)).toBeCloseTo(0.13, 2);
  });

  it('3 picks ago (r=2) → ~0.34', () => {
    // score = 0.49 → 1 / 2.96
    expect(itemWeight('a', ['x', 'y', 'a'], s)).toBeCloseTo(0.338, 3);
  });

  it('6 picks ago follows the formula', () => {
    // r=5: score = 0.7^5 = 0.16807 → 1 / 1.67228 ≈ 0.598
    // (BUILD.md's table says "about 0.70", which matches r=6: 1 / 1.4706 ≈ 0.68.)
    expect(itemWeight('a', ['1', '2', '3', '4', '5', 'a'], s)).toBeCloseTo(
      1 / (1 + 4 * 0.7 ** 5),
      10,
    );
    expect(itemWeight('a', ['1', '2', '3', '4', '5', '6', 'a'], s)).toBeCloseTo(0.68, 2);
  });

  it('scores sum across repeated appearances', () => {
    const scores = recencyScores(['a', 'b', 'a', 'a'], 0.5);
    expect(scores.get('a')).toBeCloseTo(1 + 0.25 + 0.125, 10);
    expect(scores.get('b')).toBeCloseTo(0.5, 10);
  });

  it('respects the floor', () => {
    const hot = Array(50).fill('a');
    expect(itemWeight('a', hot, s)).toBeCloseTo(1 / (1 + 4 / 0.3), 6); // 50-term sum ≈ 1/(1-λ)
    expect(itemWeight('a', hot, { ...s, k: 1000 })).toBe(0.03);
  });

  it('k=0 disables recency weighting', () => {
    expect(itemWeight('a', ['a', 'a'], { ...s, k: 0 })).toBe(1);
  });
});

describe('weightedDraw', () => {
  it('returns null for no entries', () => {
    expect(weightedDraw([], () => 1)).toBeNull();
  });

  it('walks cumulative weights', () => {
    const entries = [
      { id: 'a', w: 1 },
      { id: 'b', w: 3 },
    ];
    expect(
      weightedDraw(
        entries,
        (e) => e.w,
        () => 0,
      )?.id,
    ).toBe('a');
    expect(
      weightedDraw(
        entries,
        (e) => e.w,
        () => 0.24,
      )?.id,
    ).toBe('a');
    expect(
      weightedDraw(
        entries,
        (e) => e.w,
        () => 0.26,
      )?.id,
    ).toBe('b');
  });

  it('falls back to the last entry if rounding walks off the end', () => {
    const entries = [{ w: 0.1 }, { w: 0.2 }, { w: 0.3 }];
    // rng() returning 1 (outside [0,1)) simulates the worst rounding case.
    expect(
      weightedDraw(
        entries,
        (e) => e.w,
        () => 1,
      ),
    ).toBe(entries[2]);
  });
});

describe('pick', () => {
  it('zero candidates → null', () => {
    expect(pick([], [], s).item).toBeNull();
    expect(pick([], [], { ...s, categoryFirst: true }).item).toBeNull();
  });

  it('one candidate is always returned, even at the floor', () => {
    const [only] = items(1);
    const recent = Array(50).fill(only!.id);
    for (const mode of [false, true]) {
      const r = pick([only!], recent, { ...s, k: 1000, categoryFirst: mode }, () => 0.999);
      expect(r.item?.id).toBe(only!.id);
      expect(r.item?.weight).toBe(0.03);
      expect(r.item?.probability).toBe(1);
    }
  });

  it('equal weights → uniform', () => {
    const c = items(4);
    const w = weighCandidates(c, [], s);
    expect(w.map((x) => x.probability)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(pick(c, [], s, () => 0.0).item?.id).toBe(c[0]!.id);
    expect(pick(c, [], s, () => 0.3).item?.id).toBe(c[1]!.id);
    expect(pick(c, [], s, () => 0.6).item?.id).toBe(c[2]!.id);
    expect(pick(c, [], s, () => 0.99).item?.id).toBe(c[3]!.id);
  });

  it('is deterministic for a seeded rng', () => {
    const c = items(10);
    const run = () => {
      const rng = seeded(42);
      return Array.from({ length: 50 }, () => pick(c, ['c1-i3', 'c1-i7'], s, rng).item?.id);
    };
    expect(run()).toEqual(run());
  });

  it('probabilities sum to 1 in both modes', () => {
    const c = [...items(3, 'a'), ...items(7, 'b')];
    for (const categoryFirst of [false, true]) {
      const w = weighCandidates(c, ['a-i0', 'b-i2', 'a-i0'], { ...s, categoryFirst });
      expect(w.reduce((sum, x) => sum + x.probability, 0)).toBeCloseTo(1, 10);
    }
  });

  it('category-first uses the mean item weight per category', () => {
    const c = [...items(1, 'a'), ...items(2, 'b')];
    // a-i0 picked last → weight 0.2; category a mean 0.2, b mean 1.
    const w = weighCandidates(c, ['a-i0'], { ...s, categoryFirst: true });
    const pa = w.find((x) => x.id === 'a-i0')!.probability;
    expect(pa).toBeCloseTo(0.2 / 1.2, 10);
  });
});

describe('simulation', () => {
  /** Run N accepted picks, feeding each back into the recent-picks window. */
  function simulate(candidates: Candidate[], n: number, settings = s, seed = 7) {
    const rng = seeded(seed);
    const recent: string[] = [];
    const counts = new Map<string, number>();
    const catCounts = new Map<string, number>();
    let streak = 0;
    let maxStreak = 0;
    let last: string | undefined;
    for (let i = 0; i < n; i++) {
      const { item } = pick(candidates, recent, settings, rng);
      const id = item!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      catCounts.set(item!.categoryId, (catCounts.get(item!.categoryId) ?? 0) + 1);
      streak = id === last ? streak + 1 : 1;
      maxStreak = Math.max(maxStreak, streak);
      last = id;
      recent.unshift(id);
      if (recent.length > 50) recent.pop();
    }
    return { counts, catCounts, maxStreak };
  }

  it('6 equal items over 10,000 picks: no long streaks, near-uniform shares', () => {
    const c = items(6);
    const { counts, maxStreak } = simulate(c, 10_000);
    expect(maxStreak).toBeLessThanOrEqual(3);
    for (const item of c) {
      const share = (counts.get(item.id) ?? 0) / 10_000;
      expect(share).toBeGreaterThan(1 / 6 - 0.02);
      expect(share).toBeLessThan(1 / 6 + 0.02);
    }
  });

  it('recency weighting reduces repeats versus pure random', () => {
    const c = items(6);
    const rng = seeded(1);
    const recent: string[] = [];
    let repeats = 0;
    for (let i = 0; i < 10_000; i++) {
      const id = pick(c, recent, s, rng).item!.id;
      if (recent[0] === id) repeats++;
      recent.unshift(id);
      if (recent.length > 50) recent.pop();
    }
    // Pure random would repeat ~1/6 (16.7%) of the time.
    expect(repeats / 10_000).toBeLessThan(0.08);
  });

  it('category-first: a 1-item category roughly matches a 20-item category', () => {
    const c = [...items(1, 'small'), ...items(20, 'big')];
    const settings = { ...s, categoryFirst: true };

    // With no recency (k=0) it's an exact coin flip between categories.
    const flat = simulate(c, 10_000, { ...settings, k: 0 });
    const flatShare = (flat.catCounts.get('small') ?? 0) / 10_000;
    expect(flatShare).toBeGreaterThan(0.47);
    expect(flatShare).toBeLessThan(0.53);

    // With recency, the lone item cools down when picked, so its category gets
    // somewhat less than half, but still vastly more than its 1/21 item share.
    const real = simulate(c, 10_000, settings);
    const share = (real.catCounts.get('small') ?? 0) / 10_000;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.55);
  });
});

describe('validateSettings', () => {
  it('accepts defaults', () => expect(validateSettings(s)).toBeNull());
  it.each([{ lambda: 0 }, { lambda: 1 }, { k: -1 }, { floor: 0 }, { floor: 1.5 }])(
    'rejects %o',
    (patch) => {
      expect(validateSettings({ ...s, ...patch })).not.toBeNull();
    },
  );
});
