/** Supplier ranking for re-sourcing. Pure; weights are configurable per category. */

export interface ScoreWeights {
  cost: number;
  speed: number;
  reliability: number;
}

export const CATEGORY_WEIGHTS: Record<string, ScoreWeights> = {
  // Fresh/chilled: arriving before the stockout matters most.
  dairy: { cost: 0.3, speed: 0.4, reliability: 0.3 },
  default: { cost: 0.5, speed: 0.2, reliability: 0.3 },
};

export const weightsFor = (category: string) => CATEGORY_WEIGHTS[category] ?? CATEGORY_WEIGHTS.default!;

export interface SupplierCandidate {
  supplierId: string;
  /** Cost premium vs the original supplier, e.g. 0.05 = +5%. */
  costDelta: number;
  arrivalDays: number;
  onTimeRate: number;
  qty: number;
  neededQty: number;
}

export interface ScoredCandidate<T extends SupplierCandidate> {
  candidate: T;
  score: number;
  parts: { costFit: number; speedFit: number; reliability: number; overbuyPenalty: number };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function scoreSupplier(c: SupplierCandidate, stockoutDay: number | null, w: ScoreWeights) {
  const costFit = 1 - clamp01(c.costDelta);
  const speedFit = stockoutDay == null || stockoutDay <= 0 ? 1 : clamp01((stockoutDay - c.arrivalDays) / stockoutDay);
  const overbuy = c.neededQty > 0 ? Math.max(0, (c.qty - c.neededQty) / c.neededQty) : 0;
  const overbuyPenalty = 0.1 * Math.min(1, overbuy);
  const score = w.cost * costFit + w.speed * speedFit + w.reliability * c.onTimeRate - overbuyPenalty;
  return { score: r3(score), parts: { costFit: r3(costFit), speedFit: r3(speedFit), reliability: c.onTimeRate, overbuyPenalty: r3(overbuyPenalty) } };
}

export function rankSuppliers<T extends SupplierCandidate>(cands: T[], stockoutDay: number | null, w: ScoreWeights): ScoredCandidate<T>[] {
  return cands
    .map((candidate) => ({ candidate, ...scoreSupplier(candidate, stockoutDay, w) }))
    .sort((a, b) => b.score - a.score || a.candidate.supplierId.localeCompare(b.candidate.supplierId));
}
