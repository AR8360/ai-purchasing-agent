import { z, type ZodTypeAny } from 'zod';
import { SubmitDecisionSchema, toToolJsonSchema, type DecisionDoc, type Trigger } from '@purchasing/shared';
import { computeNeed, projectedStockAt } from '../engine/calculator.js';
import { resolveConstraints, storageFreeAt } from '../engine/constraints.js';
import { decideRecommendation } from '../engine/recommendation.js';
import { assessShortfall, type ShortfallInput } from '../engine/shortfall.js';
import { recommendationFacts, shortfallFacts } from '../engine/facts.js';
import { checkDataTrust } from '../engine/trust.js';
import type { ToolDeclaration } from '../agent/llm.js';
import {
  getAlternates,
  getBackfill,
  getBudget,
  getForecast,
  getInventory,
  getOpenPos,
  getPo,
  getSku,
  getStorage,
  getTerms,
  orNull,
  toOpenPo,
} from './data.js';
import type { CallContext } from './http.js';

export interface ToolContext extends CallContext {
  decision: DecisionDoc;
}

export interface Tool<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const SkuNode = z.object({ sku: z.string(), node: z.string() });

/** Typed at definition, erased for the registry (handlers re-validate their input with Zod). */
function tool<S extends ZodTypeAny>(t: Tool<S>): Tool {
  return t as unknown as Tool;
}

function requireTrigger<T extends Trigger['type']>(ctx: ToolContext, type: T) {
  if (ctx.decision.trigger.type !== type) throw new Error(`This tool only applies to ${type} decisions`);
  return ctx.decision.trigger as Extract<Trigger, { type: T }>;
}

// ---------------------------------------------------------------------------------
// Read tools: evidence from the external systems
// ---------------------------------------------------------------------------------

const readTools = [
  tool({
    name: 'get_inventory',
    description: 'On-hand and available stock for a SKU at a node, plus its category, storage zone and pack size.',
    input: SkuNode,
    handler: ({ sku, node }, ctx) => getInventory(ctx, sku, node),
  }),
  tool({
    name: 'get_demand_forecast',
    description: 'Daily demand forecast (mean and standard deviation) for a SKU at a node, with its age in hours.',
    input: SkuNode,
    handler: ({ sku, node }, ctx) => getForecast(ctx, sku, node),
  }),
  tool({
    name: 'get_open_purchase_orders',
    description: 'Open purchase orders for a SKU at a node: quantity, supplier, status and days until expected arrival.',
    input: SkuNode,
    handler: async ({ sku, node }, ctx) =>
      (await getOpenPos(ctx, sku, node)).map((p) => ({
        poId: p.poId,
        supplierId: p.supplierId,
        qty: p.qty,
        pendingQty: p.pendingQty,
        confirmedQty: p.confirmedQty,
        status: p.status,
        expectedInDays: p.expectedInDays,
      })),
  }),
  tool({
    name: 'get_purchase_order',
    description: 'Full details of one purchase order, including any supplier-confirmed quantity.',
    input: z.object({ poId: z.string() }),
    handler: async ({ poId }, ctx) => {
      const { history, ...po } = await getPo(ctx, poId);
      return { ...po, lastEvents: history.slice(-3) };
    },
  }),
  tool({
    name: 'get_supplier_terms',
    description: "A supplier's terms for a SKU: lead time, MOQ, pack size, unit cost, reliability, and earliest backfill.",
    input: z.object({ supplierId: z.string(), sku: z.string() }),
    handler: async ({ supplierId, sku }, ctx) => {
      const [terms, backfill] = await Promise.all([getTerms(ctx, supplierId, sku), getBackfill(ctx, supplierId, sku)]);
      return { ...terms, backfillEarliestInDays: backfill.earliestInDays };
    },
  }),
  tool({
    name: 'list_alternate_suppliers',
    description: 'Other suppliers that sell this SKU, with their terms and reliability.',
    input: z.object({ sku: z.string(), excludeSupplierId: z.string().optional() }),
    handler: ({ sku, excludeSupplierId }, ctx) => getAlternates(ctx, sku, excludeSupplierId),
  }),
  tool({
    name: 'get_budget',
    description: "Purchasing budget for the SKU's category at a node: total, reserved, spent and remaining.",
    input: SkuNode,
    handler: async ({ sku, node }, ctx) => getBudget(ctx, node, (await getSku(ctx, sku)).category),
  }),
  tool({
    name: 'get_storage_capacity',
    description: "Capacity and current use of the SKU's storage zone at a node, including space booked for other deliveries.",
    input: SkuNode,
    handler: async ({ sku, node }, ctx) => getStorage(ctx, node, (await getSku(ctx, sku)).zone),
  }),
];

// ---------------------------------------------------------------------------------
// Engine tools: deterministic computation. The LLM never does the arithmetic.
// ---------------------------------------------------------------------------------

const engineTools = [
  tool({
    name: 'compute_need',
    description:
      'Deterministic replenishment need: coverage required over lead time + review period (with safety stock), stock already on hand and incoming, true need and days to stockout. Optionally override the quantity an open PO will deliver.',
    input: z.object({
      sku: z.string(),
      node: z.string(),
      supplierId: z.string(),
      overrideIncoming: z.object({ poId: z.string(), qty: z.number().int().nonnegative() }).optional(),
    }),
    handler: async ({ sku, node, supplierId, overrideIncoming }, ctx) => {
      const [inv, fc, pos, terms] = await Promise.all([
        getInventory(ctx, sku, node),
        getForecast(ctx, sku, node),
        getOpenPos(ctx, sku, node),
        getTerms(ctx, supplierId, sku),
      ]);
      const openPos = pos.map(toOpenPo).map((p) => (overrideIncoming && p.poId === overrideIncoming.poId ? { ...p, qty: overrideIncoming.qty } : p));
      const need = computeNeed({
        onHand: inv.onHand,
        dailyMean: fc.dailyMean,
        dailyStdDev: fc.dailyStdDev,
        leadTimeDays: terms.leadTimeDays,
        avgLeadDelta: terms.reliability?.avgLeadDelta ?? 0,
        openPos,
      });
      ctx.decision.computed.need = need;
      return need;
    },
  }),
  tool({
    name: 'check_constraints',
    description:
      'Scenario 1 engine. Applies data-trust checks, MOQ/pack rounding, budget and storage caps to the computed need and returns the deterministic engine decision (decision, quantity, actions) for the recommendation under review.',
    input: z.object({ sku: z.string(), node: z.string(), supplierId: z.string(), recommendedQty: z.number().int() }),
    handler: async (args, ctx) => {
      const t = requireTrigger(ctx, 'RECOMMENDATION');
      if (args.sku !== t.sku || args.node !== t.node || args.supplierId !== t.supplierId || args.recommendedQty !== t.qty) {
        throw new Error(`Arguments must match the recommendation under review: ${t.sku} @ ${t.node}, ${t.supplierId}, qty ${t.qty}`);
      }
      const sku = await getSku(ctx, t.sku);
      const [inv, fc, pos, terms, budget, storage] = await Promise.all([
        orNull(getInventory(ctx, t.sku, t.node)),
        orNull(getForecast(ctx, t.sku, t.node)),
        getOpenPos(ctx, t.sku, t.node),
        orNull(getTerms(ctx, t.supplierId, t.sku)),
        getBudget(ctx, t.node, sku.category),
        getStorage(ctx, t.node, sku.zone),
      ]);
      const trustIssues = checkDataTrust({
        forecastAgeHours: fc?.ageHours ?? null,
        onHand: inv?.onHand,
        openPos: pos.map((p) => ({ poId: p.poId, expectedDate: p.expectedDate })),
        hasTerms: !!terms,
      });
      if (!inv || !fc || !terms) {
        const engine = decideRecommendation({
          sku: t.sku, node: t.node, supplierId: t.supplierId, recommendedQty: t.qty, moq: 0, packSize: 1, unitCost: 1,
          need: computeNeed({ onHand: 0, dailyMean: 0, dailyStdDev: 0, leadTimeDays: 0, openPos: [] }),
          constraints: resolveConstraints({ trueNeed: 0, moq: 0, packSize: 1, unitCost: 1, budgetRemaining: 0, storageFreeAtDelivery: 0 }),
          trustIssues,
        });
        engine.facts = trustIssues.map((x) => `Data problem: ${x.message}.`);
        ctx.decision.engine = engine;
        return { trustIssues, engineDecision: engine };
      }
      const openPos = pos.map(toOpenPo);
      const leadDelta = terms.reliability?.avgLeadDelta ?? 0;
      const need = computeNeed({
        onHand: inv.onHand,
        dailyMean: fc.dailyMean,
        dailyStdDev: fc.dailyStdDev,
        leadTimeDays: terms.leadTimeDays,
        avgLeadDelta: leadDelta,
        openPos,
      });
      const deliveryDay = terms.leadTimeDays + leadDelta;
      const stockAtDelivery = projectedStockAt(deliveryDay, inv.onHand, fc.dailyMean, openPos);
      const storageFree = storageFreeAt({ ...storage, ourOnHand: inv.onHand, ourProjectedStock: stockAtDelivery });
      const constraints = resolveConstraints({
        trueNeed: need.trueNeed,
        moq: terms.moq,
        packSize: terms.packSize,
        unitCost: terms.unitCost,
        budgetRemaining: budget.remaining,
        storageFreeAtDelivery: storageFree,
      });
      const engine = decideRecommendation({
        sku: t.sku,
        node: t.node,
        supplierId: t.supplierId,
        recommendedQty: t.qty,
        moq: terms.moq,
        packSize: terms.packSize,
        unitCost: terms.unitCost,
        need,
        constraints,
        trustIssues,
      });
      engine.facts = recommendationFacts({
        sku: t.sku,
        node: t.node,
        supplierId: t.supplierId,
        recommendedQty: t.qty,
        onHand: inv.onHand,
        dailyMean: fc.dailyMean,
        dailyStdDev: fc.dailyStdDev,
        leadTimeDays: terms.leadTimeDays,
        moq: terms.moq,
        packSize: terms.packSize,
        unitCost: terms.unitCost,
        budgetRemaining: budget.remaining,
        budget,
        deliveryDay,
        storageFreeAtDelivery: storageFree,
        storage,
        stockAtDelivery,
        need,
        constraints,
        trustIssues,
      });
      ctx.decision.computed = {
        ...ctx.decision.computed,
        need,
        constraints,
        trustIssues,
        storage: { deliveryDay, stockAtDelivery, storageFreeAtDelivery: storageFree },
        supplier: { moq: terms.moq, packSize: terms.packSize, unitCost: terms.unitCost, leadTimeDays: terms.leadTimeDays },
        budgetRemaining: budget.remaining,
      };
      ctx.decision.engine = engine;
      return {
        need: {
          horizonDays: need.horizon,
          coverageNeeded: need.coverageNeeded,
          safetyStock: need.safetyStock,
          projectedPosition: need.projectedPosition,
          incomingCounted: need.incomingCounted,
          trueNeed: need.trueNeed,
          daysToStockout: need.daysToStockout,
        },
        storage: { deliveryDay, stockAtDelivery, storageFreeAtDelivery: storageFree },
        constraints,
        trustIssues,
        engineDecision: engine,
      };
    },
  }),
  tool({
    name: 'assess_shortfall',
    description:
      'Scenario 2 engine. For a PO the supplier cannot fully confirm: whether the gap causes a stockout, whether the same supplier can backfill in time, ranked alternate suppliers with cost/budget/storage checks, and the deterministic engine decision (decision, strategy, actions).',
    input: z.object({ poId: z.string() }),
    handler: async ({ poId }, ctx) => {
      const t = requireTrigger(ctx, 'SUPPLIER_SHORTFALL');
      if (poId !== t.poId) throw new Error(`This decision is about ${t.poId}`);
      const po = await getPo(ctx, poId);
      const sku = await getSku(ctx, po.sku);
      const [inv, fc, pos, all, budget, storage] = await Promise.all([
        getInventory(ctx, po.sku, po.node),
        getForecast(ctx, po.sku, po.node),
        getOpenPos(ctx, po.sku, po.node),
        getAlternates(ctx, po.sku),
        getBudget(ctx, po.node, sku.category),
        getStorage(ctx, po.node, sku.zone),
      ]);
      const input: ShortfallInput = {
        sku: po.sku,
        node: po.node,
        category: sku.category,
        po: { poId, supplierId: po.supplierId, qty: po.qty, confirmedQty: t.confirmedQty, unitCost: po.unitCost, inDays: po.expectedInDays },
        onHand: inv.onHand,
        dailyMean: fc.dailyMean,
        dailyStdDev: fc.dailyStdDev,
        otherOpenPos: pos.filter((p) => p.poId !== poId).map(toOpenPo),
        terms: all.map((x) => ({
          supplierId: x.supplierId,
          name: x.name,
          leadTimeDays: x.leadTimeDays,
          moq: x.moq,
          packSize: x.packSize,
          unitCost: x.unitCost,
          backfillLeadDays: x.backfillLeadDays,
          onTimeRate: x.reliability?.onTimeRate ?? 0,
          avgLeadDelta: x.reliability?.avgLeadDelta ?? 0,
        })),
        budgetRemaining: budget.remaining,
        storage,
      };
      const a = assessShortfall(input);
      a.engine.facts = shortfallFacts(input, a);
      ctx.decision.computed = {
        ...ctx.decision.computed,
        need: a.need,
        shortfall: {
          poId,
          orderedQty: po.qty,
          confirmedQty: t.confirmedQty,
          shortfallQty: a.shortfallQty,
          stockoutDay: a.stockoutDay,
          budgetRemaining: budget.remaining,
          budgetAfterAmend: a.budgetAfterAmend,
          originalSupplierId: po.supplierId,
          originalUnitCost: po.unitCost,
          candidates: a.candidates,
        },
      };
      ctx.decision.engine = a.engine;
      return {
        shortfallQty: a.shortfallQty,
        trueNeedWithShortfall: a.need.trueNeed,
        stockoutDay: a.stockoutDay,
        budgetAfterAmend: a.budgetAfterAmend,
        candidates: a.candidates,
        engineDecision: a.engine,
      };
    },
  }),
];

const submitTool = tool({
  name: 'submit_decision',
  description:
    'Submit the final decision exactly once, after the engine tool. Copy decision, strategy, quantity, supplierId and actions from the engine result; write reasoning bullets that cite the evidence.',
  input: SubmitDecisionSchema,
  // Handled by the agent loop (it validates against the engine result).
  handler: async () => ({ accepted: true }),
});

export const LLM_TOOLS: Tool[] = [...readTools, ...engineTools, submitTool];
export const TOOLS_BY_NAME = new Map(LLM_TOOLS.map((t) => [t.name, t]));

export function toToolDeclarations(tools: Tool[] = LLM_TOOLS): ToolDeclaration[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: toToolJsonSchema(t.input) }));
}

export const REQUIRED_TOOLS: Record<Trigger['type'], string[]> = {
  RECOMMENDATION: [
    'get_inventory',
    'get_demand_forecast',
    'get_open_purchase_orders',
    'get_supplier_terms',
    'get_budget',
    'get_storage_capacity',
    'compute_need',
    'check_constraints',
  ],
  SUPPLIER_SHORTFALL: [
    'get_purchase_order',
    'get_inventory',
    'get_demand_forecast',
    'get_supplier_terms',
    'list_alternate_suppliers',
    'get_budget',
    'get_storage_capacity',
    'compute_need',
    'assess_shortfall',
  ],
};
