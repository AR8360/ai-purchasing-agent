import type { Action, EngineDecision, EscalationOption } from '@purchasing/shared';
import { computeNeed, projectedStockAt, type NeedResult, type OpenPo } from './calculator.js';
import { roundUpToPack, storageFreeAt } from './constraints.js';
import { POLICY_LIMITS } from './policy.js';
import { rankSuppliers, weightsFor, type SupplierCandidate } from './supplierScore.js';

/** Scenario 2 decision rule: a supplier confirmed less than the PO asked for. Pure. */

export interface TermsLite {
  supplierId: string;
  name?: string;
  leadTimeDays: number;
  moq: number;
  packSize: number;
  unitCost: number;
  backfillLeadDays: number;
  onTimeRate: number;
  avgLeadDelta: number;
}

export interface ShortfallInput {
  sku: string;
  node: string;
  category: string;
  po: { poId: string; supplierId: string; qty: number; confirmedQty: number; unitCost: number; inDays: number };
  onHand: number;
  dailyMean: number;
  dailyStdDev: number;
  /** Other open POs for this SKU/node (excluding the short PO). */
  otherOpenPos: OpenPo[];
  terms: TermsLite[];
  budgetRemaining: number;
  storage: { capacityUnits: number; usedUnits: number; reservedInboundUnits: number };
}

export interface CandidateDetail extends SupplierCandidate {
  name?: string;
  kind: 'BACKFILL' | 'ALTERNATE';
  moq: number;
  unitCost: number;
  totalCost: number;
  beforeStockout: boolean;
  budgetOk: boolean;
  storageOk: boolean;
  feasible: boolean;
  score?: number;
}

export interface ShortfallAssessment {
  engine: EngineDecision;
  need: NeedResult;
  shortfallQty: number;
  stockoutDay: number | null;
  budgetAfterAmend: number;
  candidates: CandidateDetail[];
}

const MIN_RELIABILITY = 0.8;
const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function assessShortfall(i: ShortfallInput): ShortfallAssessment {
  const orig = i.terms.find((t) => t.supplierId === i.po.supplierId);
  if (!orig) throw new Error(`No terms for original supplier ${i.po.supplierId}`);

  const shortPo: OpenPo = { poId: i.po.poId, qty: i.po.confirmedQty, inDays: i.po.inDays };
  const openPos = [...i.otherOpenPos, shortPo];
  const need = computeNeed({
    onHand: i.onHand,
    dailyMean: i.dailyMean,
    dailyStdDev: i.dailyStdDev,
    leadTimeDays: orig.leadTimeDays,
    avgLeadDelta: orig.avgLeadDelta,
    openPos,
  });
  const stockoutDay = need.daysToStockout;
  const shortfallQty = i.po.qty - i.po.confirmedQty;
  const budgetAfterAmend = i.budgetRemaining + shortfallQty * i.po.unitCost;

  const amend: Action = {
    type: 'AMEND_PO',
    poId: i.po.poId,
    sku: i.sku,
    node: i.node,
    supplierId: i.po.supplierId,
    qty: i.po.confirmedQty,
    reason: `Supplier confirmed ${i.po.confirmedQty} of ${i.po.qty}`,
  };

  const candidate = (t: TermsLite, kind: CandidateDetail['kind']): CandidateDetail => {
    const arrivalDays = kind === 'BACKFILL' ? t.backfillLeadDays : t.leadTimeDays + t.avgLeadDelta;
    const qty = roundUpToPack(Math.max(shortfallQty, t.moq), t.packSize);
    const totalCost = qty * t.unitCost;
    const stockAtArrival = projectedStockAt(arrivalDays, i.onHand, i.dailyMean, openPos);
    const free = storageFreeAt({ ...i.storage, ourOnHand: i.onHand, ourProjectedStock: stockAtArrival });
    const beforeStockout = stockoutDay == null || arrivalDays < stockoutDay;
    const budgetOk = totalCost <= budgetAfterAmend;
    const storageOk = qty <= free;
    return {
      supplierId: t.supplierId,
      name: t.name,
      kind,
      costDelta: Math.round(((t.unitCost - i.po.unitCost) / i.po.unitCost) * 1000) / 1000,
      arrivalDays,
      onTimeRate: t.onTimeRate,
      qty,
      neededQty: shortfallQty,
      moq: t.moq,
      unitCost: t.unitCost,
      totalCost,
      beforeStockout,
      budgetOk,
      storageOk,
      feasible: budgetOk && storageOk,
    };
  };

  const backfill = candidate(orig, 'BACKFILL');
  const ranked = rankSuppliers(
    i.terms.filter((t) => t.supplierId !== i.po.supplierId).map((t) => candidate(t, 'ALTERNATE')),
    stockoutDay,
    weightsFor(i.category),
  );
  const alternates = ranked.map((r) => ({ ...r.candidate, score: r.score }));
  const candidates = [backfill, ...alternates];

  const base = { need, shortfallQty, stockoutDay, budgetAfterAmend, candidates };
  const createFor = (c: CandidateDetail, reason: string): Action => ({
    type: 'CREATE_PO',
    sku: i.sku,
    node: i.node,
    supplierId: c.supplierId,
    qty: c.qty,
    expectedInDays: c.arrivalDays,
    reason,
  });

  // 1. The shortfall does not matter: on hand + what is still coming covers the horizon.
  if (need.trueNeed <= 0) {
    return {
      ...base,
      engine: {
        decision: 'ACCEPT',
        strategy: 'ACCEPT_PARTIAL',
        quantity: i.po.confirmedQty,
        supplierId: i.po.supplierId,
        actions: [amend],
        constraintsHit: [],
        rule: 'SHORTFALL_COVERED',
        summary: `Even with only ${i.po.confirmedQty} arriving, stock covers the ${need.coverageNeeded} needed over ${need.horizon} days`,
      },
    };
  }

  // 2. Same supplier can send the rest before we run out.
  if (backfill.beforeStockout && backfill.feasible) {
    return {
      ...base,
      engine: {
        decision: 'MODIFY',
        strategy: 'SPLIT',
        quantity: backfill.qty,
        supplierId: backfill.supplierId,
        actions: [amend, createFor(backfill, `Backfill of the ${shortfallQty} short from ${i.po.poId}`)],
        constraintsHit: [],
        rule: 'BACKFILL_IN_TIME',
        summary: `${i.po.supplierId} can backfill ${backfill.qty} on day ${backfill.arrivalDays}, before the projected stockout on day ${stockoutDay}`,
      },
    };
  }

  // 3. Best-scoring alternate that arrives in time, fits budget/storage, at an acceptable premium.
  const best = alternates.find((c) => c.beforeStockout && c.feasible);
  if (best && best.costDelta <= POLICY_LIMITS.maxSupplierCostPremium && best.onTimeRate >= MIN_RELIABILITY) {
    return {
      ...base,
      engine: {
        decision: 'MODIFY',
        strategy: 'RESOURCE',
        quantity: best.qty,
        supplierId: best.supplierId,
        actions: [amend, createFor(best, `Re-source the ${shortfallQty} short from ${i.po.poId}`)],
        constraintsHit: best.qty > shortfallQty ? ['MOQ'] : [],
        rule: 'RESOURCE_ALTERNATE',
        summary: `${i.po.supplierId} backfill (day ${backfill.arrivalDays}) is after the day-${stockoutDay} stockout; ${best.supplierId} delivers ${best.qty} on day ${best.arrivalDays} at +${Math.round(best.costDelta * 100)}%`,
      },
    };
  }

  // 4. Nothing safe to do automatically: escalate with priced options.
  const options: EscalationOption[] = [
    ...alternates
      .filter((c) => c.beforeStockout)
      .map((c) => ({
        label: `Re-source ${c.qty} from ${c.name ?? c.supplierId}`,
        detail: `${fmt(c.totalCost)} (+${Math.round(c.costDelta * 100)}%), arrives day ${c.arrivalDays}, on-time ${Math.round(c.onTimeRate * 100)}%${c.feasible ? '' : ', breaks budget/storage'}`,
      })),
    {
      label: `Wait for ${i.po.supplierId} backfill`,
      detail: `${backfill.qty} on day ${backfill.arrivalDays}; stockout from day ${stockoutDay}`,
    },
    { label: 'Accept the shortfall', detail: `Amend ${i.po.poId} to ${i.po.confirmedQty} and accept stockout risk from day ${stockoutDay}` },
  ];
  const noneInTime = !alternates.some((c) => c.beforeStockout);
  return {
    ...base,
    engine: {
      decision: 'ESCALATE',
      strategy: 'STANDARD',
      actions: [],
      constraintsHit: best ? [] : ['BUDGET'],
      rule: noneInTime ? 'STOCKOUT_UNAVOIDABLE' : 'ALTERNATE_TOO_EXPENSIVE',
      summary: noneInTime
        ? `No supplier can deliver before the projected stockout on day ${stockoutDay}`
        : `Timely alternates exceed the ${POLICY_LIMITS.maxSupplierCostPremium * 100}% premium or reliability limits`,
      escalation: {
        summary: `${i.po.supplierId} is short ${shortfallQty} on ${i.po.poId}; projected stockout on day ${stockoutDay}. No automatic option is within policy.`,
        options,
      },
    },
  };
}
