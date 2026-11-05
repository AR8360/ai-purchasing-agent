import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { FAULTS, RecommendationTriggerSchema } from '@purchasing/shared';
import { approveDecision, DecisionStateError, getLlm, rejectDecision, startDecision, waitFor } from '../agent/orchestrator.js';
import { loadDecision } from '../agent/store.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { listCases, readLatestResults, runEval } from '../eval/runner.js';
import { resetFaults } from '../mock/fault.js';
import { DecisionModel, PurchaseOrderModel } from '../models/index.js';
import { getVariant, listVariants, seed } from '../seed/seed.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const Faults = z.array(z.enum(FAULTS)).default([]);

export const api = Router();

api.get('/health', (_req, res) => {
  let model = config.llm.model;
  try {
    model = getLlm().model; // in replay mode: the model the fixtures were recorded with
  } catch {
    /* no API key configured: still healthy */
  }
  res.json({ ok: true, simNow: clock.iso(), model, llmCache: config.llm.cacheMode });
});

// --- Decisions -----------------------------------------------------------------------

api.get(
  '/decisions',
  h(async (req, res) => {
    const q = req.query.state ? { state: String(req.query.state) } : {};
    const docs = await DecisionModel.find(q, {
      _id: 0,
      decisionId: 1,
      trigger: 1,
      state: 1,
      faults: 1,
      'decision.decision': 1,
      'decision.strategy': 1,
      'decision.quantity': 1,
      'approval.required': 1,
      createdAt: 1,
      updatedAt: 1,
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(docs);
  }),
);

api.get(
  '/decisions/:id',
  h(async (req, res) => {
    const d = await loadDecision(req.params.id!);
    if (!d) return res.status(404).json({ message: 'Decision not found' });
    const pos = await PurchaseOrderModel.find({}, { _id: 0 }).sort({ poId: 1 }).lean();
    res.json({ ...d, purchaseOrders: pos });
  }),
);

api.post(
  '/decisions/:id/approve',
  h(async (req, res) => {
    const { decisionId } = await approveDecision(req.params.id!, String(req.body?.by ?? 'buyer'));
    res.status(202).json({ decisionId });
  }),
);

api.post(
  '/decisions/:id/reject',
  h(async (req, res) => {
    const d = await rejectDecision(req.params.id!, String(req.body?.by ?? 'buyer'));
    res.json({ decisionId: d.decisionId, state: d.state });
  }),
);

// --- Simulation (drives the demo) -------------------------------------------------------

api.get('/simulate/variants', (_req, res) => {
  res.json(listVariants());
});

api.post(
  '/simulate/seed',
  h(async (req, res) => {
    const variant = String(req.body?.variant ?? 's1-b');
    resetFaults();
    res.json(await seed(variant, { clearDecisions: !!req.body?.clearDecisions }));
  }),
);

api.post(
  '/simulate/recommendation',
  h(async (req, res) => {
    const body = z
      .object({ sku: z.string(), node: z.string(), supplierId: z.string().default('DAIRYCO'), qty: z.number().int().positive(), faults: Faults })
      .parse(req.body ?? {});
    const trigger = RecommendationTriggerSchema.parse({ type: 'RECOMMENDATION', ...body });
    const { decisionId } = await startDecision(trigger, body.faults);
    res.status(202).json({ decisionId });
  }),
);

async function postShortfall(body: { poId: string; confirmedQty: number; message?: string; faults: string[] }) {
  // Goes through the supplier-portal webhook, exactly like a real event would.
  const r = await fetch(`${config.baseUrl}/mock/events/shortfall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as any;
  if (!r.ok) throw Object.assign(new Error(json.message ?? 'shortfall event failed'), { status: r.status });
  return json as { decisionId: string };
}

api.post(
  '/simulate/shortfall',
  h(async (req, res) => {
    const body = z
      .object({ poId: z.string(), confirmedQty: z.number().int().nonnegative(), message: z.string().optional(), faults: Faults })
      .parse(req.body ?? {});
    res.status(202).json(await postShortfall(body));
  }),
);

/** One click: seed a variant and fire its scenario (with its faults). */
api.post(
  '/simulate/run-variant',
  h(async (req, res) => {
    const v = getVariant(String(req.body?.variant));
    resetFaults();
    await seed(v.name);
    const faults = (req.body?.faults as string[] | undefined) ?? v.faults;
    if (v.trigger.type === 'RECOMMENDATION') {
      const { decisionId } = await startDecision(v.trigger, faults);
      return res.status(202).json({ decisionId, variant: v.name });
    }
    const r = await postShortfall({ poId: v.trigger.poId, confirmedQty: v.trigger.confirmedQty, message: v.trigger.message, faults });
    return res.status(202).json({ ...r, variant: v.name });
  }),
);

api.get(
  '/simulate/wait/:id',
  h(async (req, res) => {
    const d = await waitFor(req.params.id!);
    res.json(d ? { decisionId: d.decisionId, state: d.state } : null);
  }),
);

// --- Evaluation -------------------------------------------------------------------------

api.get('/eval/cases', (_req, res) => {
  res.json(listCases());
});

api.get('/eval/results', (_req, res) => {
  res.json(readLatestResults());
});

let evalRunning = false;
api.post(
  '/eval/run',
  h(async (req, res) => {
    if (evalRunning) return res.status(409).json({ message: 'An evaluation is already running' });
    evalRunning = true;
    try {
      const mode = req.body?.mode === 'record' ? 'record' : 'replay';
      res.json(await runEval({ mode, only: req.body?.case }));
    } finally {
      evalRunning = false;
    }
  }),
);

// --- Errors ------------------------------------------------------------------------------

api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ message: 'Invalid request', issues: err.issues });
  if (err instanceof DecisionStateError) return res.status(409).json({ message: err.message });
  res.status(err?.status ?? 500).json({ message: err?.message ?? 'Internal error' });
});
