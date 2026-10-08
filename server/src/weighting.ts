// Pure weighting + selection logic. No I/O: data in, weights/choices out.

export interface WeightSettings {
  lambda: number;
  k: number;
  floor: number;
  categoryFirst: boolean;
}

export interface Candidate {
  id: string;
  categoryId: string;
}

export type Weighted<T> = T & {
  weight: number;
  /** Probability this candidate is chosen on the next draw under the active mode. */
  probability: number;
};

export type Rng = () => number;

export const DEFAULT_SETTINGS: WeightSettings = {
  lambda: 0.7,
  k: 4,
  floor: 0.03,
  categoryFirst: false,
};

/** How many recent accepted picks feed the recency score. */
export const RECENT_PICKS_LIMIT = 50;

/**
 * score(item) = Σ lambda^r over every position r where recentPicks[r] == item
 * (r = 0 is the most recent pick).
 */
export function recencyScores(recentPicks: readonly string[], lambda: number): Map<string, number> {
  const scores = new Map<string, number>();
  recentPicks.forEach((id, r) => {
    scores.set(id, (scores.get(id) ?? 0) + lambda ** r);
  });
  return scores;
}

/** weight = max(floor, 1 / (1 + k * score)) */
export function weightFromScore(
  score: number,
  settings: Pick<WeightSettings, 'k' | 'floor'>,
): number {
  return Math.max(settings.floor, 1 / (1 + settings.k * score));
}

export function itemWeight(
  itemId: string,
  recentPicks: readonly string[],
  settings: WeightSettings,
): number {
  return weightFromScore(recencyScores(recentPicks, settings.lambda).get(itemId) ?? 0, settings);
}

/**
 * Weighted random draw: sum the weights, draw rng() * total and walk the list.
 * Falls back to the last entry if floating-point rounding walks off the end.
 */
export function weightedDraw<T>(
  entries: readonly T[],
  weightOf: (entry: T) => number,
  rng: Rng = Math.random,
): T | null {
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, e) => sum + weightOf(e), 0);
  let target = rng() * total;
  for (const entry of entries) {
    target -= weightOf(entry);
    if (target < 0) return entry;
  }
  return entries[entries.length - 1] ?? null;
}

interface CategoryGroup<T> {
  categoryId: string;
  items: Weighted<T>[];
  weight: number;
}

function groupByCategory<T extends Candidate>(weighted: Weighted<T>[]): CategoryGroup<T>[] {
  const groups = new Map<string, Weighted<T>[]>();
  for (const c of weighted) {
    const list = groups.get(c.categoryId);
    if (list) list.push(c);
    else groups.set(c.categoryId, [c]);
  }
  return [...groups].map(([categoryId, items]) => ({
    categoryId,
    items,
    // Category weight is the MEAN of its items' weights so size doesn't dominate.
    weight: items.reduce((s, i) => s + i.weight, 0) / items.length,
  }));
}

/** Attach weights and selection probabilities to each candidate. */
export function weighCandidates<T extends Candidate>(
  candidates: readonly T[],
  recentPicks: readonly string[],
  settings: WeightSettings,
): Weighted<T>[] {
  const scores = recencyScores(recentPicks, settings.lambda);
  const weighted: Weighted<T>[] = candidates.map((c) => ({
    ...c,
    weight: weightFromScore(scores.get(c.id) ?? 0, settings),
    probability: 0,
  }));
  if (weighted.length === 0) return weighted;

  if (settings.categoryFirst) {
    const groups = groupByCategory(weighted);
    const catTotal = groups.reduce((s, g) => s + g.weight, 0);
    for (const g of groups) {
      const itemTotal = g.items.reduce((s, i) => s + i.weight, 0);
      for (const item of g.items) {
        item.probability = (g.weight / catTotal) * (item.weight / itemTotal);
      }
    }
  } else {
    const total = weighted.reduce((s, c) => s + c.weight, 0);
    for (const c of weighted) c.probability = c.weight / total;
  }
  return weighted;
}

export interface PickResult<T> {
  item: Weighted<T> | null;
  candidates: Weighted<T>[];
}

/** Choose one candidate according to the settings. Returns item=null when there are none. */
export function pick<T extends Candidate>(
  candidates: readonly T[],
  recentPicks: readonly string[],
  settings: WeightSettings,
  rng: Rng = Math.random,
): PickResult<T> {
  const weighted = weighCandidates(candidates, recentPicks, settings);
  if (weighted.length === 0) return { item: null, candidates: weighted };

  let item: Weighted<T> | null;
  if (settings.categoryFirst) {
    const group = weightedDraw(groupByCategory(weighted), (g) => g.weight, rng);
    item = group ? weightedDraw(group.items, (i) => i.weight, rng) : null;
  } else {
    item = weightedDraw(weighted, (c) => c.weight, rng);
  }
  return { item, candidates: weighted };
}

/** Validation rules shared by the API: 0<lambda<1, k>=0, 0<floor<=1. */
export function validateSettings(s: WeightSettings): string | null {
  if (!(s.lambda > 0 && s.lambda < 1)) return 'lambda must be between 0 and 1 (exclusive)';
  if (!(s.k >= 0) || !Number.isFinite(s.k)) return 'k must be >= 0';
  if (!(s.floor > 0 && s.floor <= 1)) return 'floor must be in (0, 1]';
  return null;
}
