import { Router, type Request, type Response } from 'express';
import type { PurchaseOrder } from '@purchasing/shared';
import { addDays, clock, daysUntil } from '../clock.js';
import {
  BudgetModel,
  ForecastModel,
  InventoryModel,
  PoEventModel,
  PurchaseOrderModel,
  SkuModel,
  StorageModel,
  SupplierModel,
  SupplierTermsModel,
} from '../models/index.js';
import { takeFault } from './fault.js';

/**
 * Mock "external systems": WMS (inventory, storage), demand planning (forecast),
 * ERP (purchase orders, budget) and the supplier portal. The agent only reaches
 * them over HTTP, so swapping a mock for a real system is a URL change.
 */
export const mockRouter = Router();

const NO_ID = { _id: 0 } as const;
const OPEN_STATUSES = ['CREATED', 'CONFIRMED', 'SHIPPED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response) => {
  fn(req, res).catch((e) => res.status(500).json({ code: 'INTERNAL', message: (e as Error).message }));
};

function notFound(res: Response, what: string) {
  return res.status(404).json({ code: 'NOT_FOUND', message: `${what} not found` });
}

async function budgetFor(node: string, sku: string) {
  const s = await SkuModel.findOne({ sku }, NO_ID).lean();
  if (!s) return null;
  return BudgetModel.findOne({ node, category: s.category });
}

const remainingOf = (b: { total: number; reserved: number; spent: number }) => b.total - b.reserved - b.spent;

function poView(po: PurchaseOrder) {
  return {
    ...po,
    effectiveQty: po.pendingQty ?? po.qty,
    expectedInDays: Number(daysUntil(po.expectedDate).toFixed(2)),
  };
}

// --- Master data ---------------------------------------------------------------

mockRouter.get(
  '/skus/:sku',
  h(async (req, res) => {
    const s = await SkuModel.findOne({ sku: req.params.sku }, NO_ID).lean();
    return s ? res.json(s) : notFound(res, 'SKU');
  }),
);

// --- WMS -----------------------------------------------------------------------

mockRouter.get(
  '/inventory',
  h(async (req, res) => {
    const { sku, node } = req.query as Record<string, string>;
    const inv = await InventoryModel.findOne({ sku, node }, NO_ID).lean();
    if (!inv) return notFound(res, 'Inventory record');
    const s = await SkuModel.findOne({ sku }, NO_ID).lean();
    return res.json({ ...inv, available: inv.onHand - inv.reserved, category: s?.category, zone: s?.zone, packSize: s?.packSize });
  }),
);

mockRouter.get(
  '/storage',
  h(async (req, res) => {
    const { node, zone } = req.query as Record<string, string>;
    const st = await StorageModel.findOne({ node, zone }, NO_ID).lean();
    if (!st) return notFound(res, 'Storage zone');
    return res.json({ ...st, freeUnits: st.capacityUnits - st.usedUnits - st.reservedInboundUnits });
  }),
);

// --- Demand planning -------------------------------------------------------------

mockRouter.get(
  '/forecast',
  h(async (req, res) => {
    const { sku, node } = req.query as Record<string, string>;
    const f = await ForecastModel.findOne({ sku, node }, NO_ID).lean();
    if (!f) return notFound(res, 'Forecast');
    const ageHours = (clock.now().getTime() - new Date(f.generatedAt).getTime()) / 3_600_000;
    return res.json({ ...f, ageHours: Number(ageHours.toFixed(1)) });
  }),
);

// --- Supplier portal ------------------------------------------------------------

mockRouter.get(
  '/suppliers/terms',
  h(async (req, res) => {
    const { supplierId, sku } = req.query as Record<string, string>;
    const t = await SupplierTermsModel.findOne({ supplierId, sku }, NO_ID).lean();
    if (!t) return notFound(res, 'Supplier terms');
    const s = await SupplierModel.findOne({ supplierId }, NO_ID).lean();
    return res.json({ ...t, name: s?.name, reliability: s?.reliability });
  }),
);

mockRouter.get(
  '/suppliers/alternates',
  h(async (req, res) => {
    const { sku, exclude } = req.query as Record<string, string>;
    const terms = await SupplierTermsModel.find({ sku, ...(exclude ? { supplierId: { $ne: exclude } } : {}) }, NO_ID)
      .sort({ supplierId: 1 })
      .lean();
    const sups = await SupplierModel.find({ supplierId: { $in: terms.map((t) => t.supplierId) } }, NO_ID).lean();
    const byId = new Map(sups.map((s) => [s.supplierId, s]));
    return res.json(
      terms.map((t) => ({ ...t, name: byId.get(t.supplierId)?.name, reliability: byId.get(t.supplierId)?.reliability })),
    );
  }),
);

mockRouter.get(
  '/suppliers/:id/backfill',
  h(async (req, res) => {
    const t = await SupplierTermsModel.findOne({ supplierId: req.params.id, sku: String(req.query.sku) }, NO_ID).lean();
    if (!t) return notFound(res, 'Supplier terms');
    return res.json({
      supplierId: t.supplierId,
      sku: t.sku,
      earliestInDays: t.backfillLeadDays,
      earliestDate: addDays(t.backfillLeadDays).toISOString(),
    });
  }),
);

// --- ERP: budget -----------------------------------------------------------------

mockRouter.get(
  '/budget',
  h(async (req, res) => {
    const { node, category } = req.query as Record<string, string>;
    const b = await BudgetModel.findOne({ node, category }, NO_ID).lean();
    if (!b) return notFound(res, 'Budget');
    return res.json({ ...b, remaining: remainingOf(b) });
  }),
);

// --- ERP: purchase orders --------------------------------------------------------

mockRouter.get(
  '/po',
  h(async (req, res) => {
    const { sku, node, status } = req.query as Record<string, string>;
    const q: Record<string, unknown> = {};
    if (sku) q.sku = sku;
    if (node) q.node = node;
    if (status === 'open') q.status = { $in: OPEN_STATUSES };
    const pos = await PurchaseOrderModel.find(q, NO_ID).sort({ poId: 1 }).lean(); // stable order: deterministic tool results
    return res.json(pos.map((p) => poView(p as PurchaseOrder)));
  }),
);

mockRouter.get(
  '/po/:id',
  h(async (req, res) => {
    if (takeFault(req, ['not_found'])) return notFound(res, `PO ${req.params.id} (read replica lag)`);
    const po = await PurchaseOrderModel.findOne({ poId: req.params.id }, NO_ID).lean();
    return po ? res.json(poView(po as PurchaseOrder)) : notFound(res, `PO ${req.params.id}`);
  }),
);

async function nextPoId() {
  const all = await PurchaseOrderModel.find({}, { poId: 1, _id: 0 }).lean();
  const nums = all.map((p) => Number(String(p.poId).replace(/\D/g, ''))).filter(Number.isFinite);
  const max = nums.length ? Math.max(...nums) : 1000;
  // PO numbers are grouped per series (10xx, 20xx); continue the highest series.
  return `PO-${max + 1}`;
}

mockRouter.post(
  '/po',
  h(async (req, res) => {
    const { sku, node, supplierId, qty, expectedInDays, idempotencyKey, decisionId } = req.body ?? {};
    if (!sku || !node || !supplierId || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'sku, node, supplierId and a positive integer qty are required' });
    }
    // Idempotency: a retried request with the same key returns the original PO.
    if (idempotencyKey) {
      const existing = await PurchaseOrderModel.findOne({ idempotencyKey }, NO_ID).lean();
      if (existing) return res.status(200).json({ ...poView(existing as PurchaseOrder), idempotentReplay: true });
    }
    const terms = await SupplierTermsModel.findOne({ supplierId, sku });
    if (!terms) return notFound(res, 'Supplier terms');

    const fault = takeFault(req, ['reject_moq', 'budget_exceeded', 'timeout', 'mismatch_qty']);
    if (fault === 'reject_moq') {
      // The supplier changed its terms: MOQ is now one pack above what was asked.
      const newMoq = Math.ceil((qty + 1) / terms.packSize) * terms.packSize;
      terms.moq = Math.max(terms.moq, newMoq);
      await terms.save();
    }
    if (qty < terms.moq) {
      return res.status(422).json({ code: 'MOQ_NOT_MET', message: `${supplierId} minimum order is ${terms.moq}`, moq: terms.moq, packSize: terms.packSize });
    }
    if (qty % terms.packSize !== 0) {
      return res.status(422).json({ code: 'PACK_SIZE', message: `qty must be a multiple of ${terms.packSize}`, packSize: terms.packSize });
    }
    const budget = await budgetFor(node, sku);
    if (!budget) return notFound(res, 'Budget');
    const savedQty = fault === 'mismatch_qty' ? qty + terms.packSize : qty;
    const totalCost = savedQty * terms.unitCost;
    if (fault === 'budget_exceeded') {
      // Race condition: another buyer reserves part of the same budget between the
      // agent's budget check and this write, leaving one pack's worth too little.
      const competing = Math.max(0, remainingOf(budget) - totalCost + terms.packSize * terms.unitCost);
      budget.reserved += competing;
      await budget.save();
    }
    if (totalCost > remainingOf(budget)) {
      const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
      return res.status(409).json({
        code: 'BUDGET_EXCEEDED',
        message: `Order value ${inr(totalCost)} exceeds the remaining budget ${inr(remainingOf(budget))}${fault === 'budget_exceeded' ? ' (another buyer reserved part of this budget moments ago)' : ''}`,
        remaining: remainingOf(budget),
        requested: totalCost,
      });
    }
    const days = Number.isFinite(expectedInDays) ? Number(expectedInDays) : terms.leadTimeDays;
    const now = clock.iso();
    const po = await PurchaseOrderModel.create({
      poId: await nextPoId(),
      sku,
      node,
      supplierId,
      qty: savedQty,
      pendingQty: null,
      confirmedQty: null,
      unitCost: terms.unitCost,
      totalCost,
      status: 'CREATED',
      expectedDate: addDays(days).toISOString(),
      idempotencyKey,
      decisionId,
      history: [{ at: now, event: 'CREATED', to: savedQty, reason: decisionId ? `decision ${decisionId}` : 'api' }],
      createdAt: now,
    });
    budget.reserved += totalCost;
    await budget.save();
    const view = poView(po.toObject() as PurchaseOrder);
    if (fault === 'timeout') {
      // The write succeeded but the response never made it back.
      await sleep(1500);
      return res.status(504).json({ code: 'GATEWAY_TIMEOUT', message: 'PO service did not respond in time' });
    }
    delete (view as any)._id;
    return res.status(201).json(view);
  }),
);

/** Soft amendment: sets pendingQty and adjusts the budget reservation; committed later. */
mockRouter.patch(
  '/po/:id',
  h(async (req, res) => {
    const { qty, reason } = req.body ?? {};
    const po = await PurchaseOrderModel.findOne({ poId: req.params.id });
    if (!po) return notFound(res, `PO ${req.params.id}`);
    if (!OPEN_STATUSES.includes(po.status)) return res.status(409).json({ code: 'PO_CLOSED', message: `PO is ${po.status}` });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ code: 'BAD_REQUEST', message: 'positive integer qty required' });
    const budget = await budgetFor(po.node, po.sku);
    if (!budget) return notFound(res, 'Budget');
    const current = po.pendingQty ?? po.qty;
    const delta = (qty - current) * po.unitCost;
    if (delta > 0 && delta > remainingOf(budget)) {
      return res.status(409).json({ code: 'BUDGET_EXCEEDED', message: 'Amendment exceeds remaining budget' });
    }
    budget.reserved += delta;
    await budget.save();
    po.pendingQty = qty;
    po.history.push({ at: clock.iso(), event: 'AMEND_PENDING', from: current, to: qty, reason });
    await po.save();
    return res.json(poView(po.toObject() as PurchaseOrder));
  }),
);

mockRouter.post(
  '/po/:id/commit',
  h(async (req, res) => {
    const po = await PurchaseOrderModel.findOne({ poId: req.params.id });
    if (!po) return notFound(res, `PO ${req.params.id}`);
    if (po.pendingQty != null) {
      const from = po.qty;
      po.qty = po.pendingQty;
      po.totalCost = po.qty * po.unitCost;
      po.pendingQty = null;
      po.history.push({ at: clock.iso(), event: 'AMEND_COMMITTED', from, to: po.qty, reason: req.body?.reason });
      await po.save();
    }
    return res.json(poView(po.toObject() as PurchaseOrder));
  }),
);

mockRouter.post(
  '/po/:id/revert',
  h(async (req, res) => {
    const po = await PurchaseOrderModel.findOne({ poId: req.params.id });
    if (!po) return notFound(res, `PO ${req.params.id}`);
    if (po.pendingQty != null) {
      const budget = await budgetFor(po.node, po.sku);
      if (budget) {
        budget.reserved += (po.qty - po.pendingQty) * po.unitCost;
        await budget.save();
      }
      po.history.push({ at: clock.iso(), event: 'AMEND_REVERTED', from: po.pendingQty, to: po.qty, reason: req.body?.reason });
      po.pendingQty = null;
      await po.save();
    }
    return res.json(poView(po.toObject() as PurchaseOrder));
  }),
);

mockRouter.post(
  '/po/:id/cancel',
  h(async (req, res) => {
    const po = await PurchaseOrderModel.findOne({ poId: req.params.id });
    if (!po) return notFound(res, `PO ${req.params.id}`);
    if (po.status !== 'CANCELLED') {
      const budget = await budgetFor(po.node, po.sku);
      if (budget) {
        budget.reserved -= po.totalCost;
        await budget.save();
      }
      po.history.push({ at: clock.iso(), event: 'CANCELLED', from: po.status, to: 'CANCELLED', reason: req.body?.reason });
      po.status = 'CANCELLED';
      await po.save();
    }
    return res.json(poView(po.toObject() as PurchaseOrder));
  }),
);

// --- Supplier events (webhook) ---------------------------------------------------

export type ShortfallListener = (evt: {
  poId: string;
  confirmedQty: number;
  message?: string;
  sku: string;
  node: string;
  supplierId: string;
  orderedQty: number;
  faults: string[];
}) => Promise<{ decisionId: string }>;

let shortfallListener: ShortfallListener | null = null;
export function onShortfall(listener: ShortfallListener) {
  shortfallListener = listener;
}

/** The supplier portal reports that it can only confirm part of a PO. */
mockRouter.post(
  '/events/shortfall',
  h(async (req, res) => {
    const { poId, confirmedQty, message, faults = [] } = req.body ?? {};
    const po = await PurchaseOrderModel.findOne({ poId });
    if (!po) return notFound(res, `PO ${poId}`);
    if (!Number.isInteger(confirmedQty) || confirmedQty < 0 || confirmedQty >= po.qty) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: `confirmedQty must be an integer in [0, ${po.qty})` });
    }
    po.confirmedQty = confirmedQty;
    po.history.push({ at: clock.iso(), event: 'SUPPLIER_SHORTFALL', from: po.qty, to: confirmedQty, reason: message });
    await po.save();
    const evt = await PoEventModel.create({
      poId,
      type: 'SHORTFALL',
      payload: { confirmedQty, orderedQty: po.qty, message },
      receivedAt: clock.iso(),
    });
    if (!shortfallListener) return res.status(202).json({ accepted: true, decisionId: null });
    const { decisionId } = await shortfallListener({
      poId,
      confirmedQty,
      message,
      sku: po.sku,
      node: po.node,
      supplierId: po.supplierId,
      orderedQty: po.qty,
      faults,
    });
    evt.set('decisionId', decisionId);
    await evt.save();
    return res.status(202).json({ accepted: true, decisionId });
  }),
);
