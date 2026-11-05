# Approach

## The problem

Quick-commerce buyers decide what to buy, when and how much, across many SKUs, suppliers and nodes. Before acting they cross-check inventory, forecasts, open purchase orders, supplier terms, budget and storage. The assignment asks for a system that **makes, executes and validates** those decisions. That means not answering questions about purchasing, and not trusting the incoming recommendation.

## Scope

Both scenarios are built end to end, including failure handling.

- **Scenario 1, purchase recommendation review.** Accept, modify, reject, investigate or escalate a recommended order. It exercises the full data model and the full decide, execute, validate path.
- **Scenario 2, supplier cannot fulfil.** A PO the system already placed comes back short. This is a mid-flight failure of an earlier action, so it forces multi-step execution (amend, then create), supplier comparison, compensation and re-planning. In other words, it *is* the feedback loop.
- **Scenario 3 (demand change)** is Scenario 1 plus an evidence step, and **Scenario 4 (constraints)** is a mode inside both. Both are in the roadmap; Scenario 4's constraint conflicts are already exercised by cases s1-b, s1-c, s1-h, s2-d and s2-f.

## Design principles

1. **The LLM plans; code decides.** The model chooses tools, reads results and explains. Every quantity, cap, state transition and validation is a pure, unit-tested TypeScript function. The prompt contains no formulas.
2. **The model proposes, the engine verifies.** `submit_decision` is checked by a guard against the deterministic engine result: decision, quantity, strategy and every action. The engine also returns labelled evidence facts (for example "₹90,000 is available for a replacement order"); the model writes its reasoning from them, and the guard rejects reasoning that cites a number not in the facts. A rejection lists the problems, and the model resubmits.
3. **Never trust a write.** Every action is read back and compared field by field. Then the whole outcome is checked: budget, storage on each delivery day, and coverage restored.
4. **Bounded, idempotent recovery.** A retry reuses the same idempotency key, so a server that already wrote returns the original record. An adjustment changes the request and gets a new key. Retries are capped at 3 and adjustments at 1.
5. **Half-done is worse than undone.** Amendments are *soft* (`pendingQty`) until the whole decision validates, so compensation is a safe revert.
6. **Humans gate risk, not volume.** A policy table, held as data, decides what needs approval. Buying less than recommended is automatic; buying a lot more is not.
7. **Everything is traced.** One MongoDB document per decision holds every tool call, engine result, rejected submission, action, validation, reconciliation and transition. It serves as the audit log, the UI and the evaluation evidence.

## The numbers (Scenario 1, case B)

| Step | Value |
|---|---|
| Horizon = lead time 7 + review 7 | 14 days |
| Demand over horizon = 60/day × 14 | 840 |
| Safety stock = 1.65 × σ10 × √7 | 44 |
| Coverage needed | 884 |
| Projected position = 150 on hand + PO-1041 400 (day 2) | 550 |
| **True need** | **334** (the recommendation of 800 ignored PO-1041) |
| MOQ 200, pack 50, requested | 350 |
| Budget cap = ₹1,00,000 ÷ ₹240, rounded down to packs | 400 |
| Storage cap = 650 capacity − 240 booked by other deliveries − 130 projected stock on day 7 = 280, in packs | **250** (binding) |
| Decision | **MODIFY 800 → 250**, with a follow-up note that 84 units of need remain uncovered |

The order of operations is never circular: horizon, then incoming POs that land within the horizon, then position, then need. The stockout day is simulated separately (continuous depletion with step arrivals) and only used to assess risk.

## Scenario 2 rule

With the shortfall applied, the engine recomputes need and the stockout day (11.17 for case C), then:

1. Need is 0 → **ACCEPT_PARTIAL**: amend the PO to the confirmed quantity.
2. The same supplier can backfill before the stockout, within budget and storage → **SPLIT**.
3. The best-scoring alternate arrives before the stockout, fits budget (including the budget released by the amendment) and storage, costs at most +10% and is at least 80% on time → **RESOURCE**.
4. Otherwise → **ESCALATE**, with every option priced and its arrival day.

Suppliers are scored on cost fit, speed (how far ahead of the stockout they arrive) and reliability, with weights per category (for dairy, speed is weighted most) and a penalty for buying more than needed.

## The feedback loop

**Three levels of validation**

| Level | When | Implemented as |
|---|---|---|
| L1, immediate | right after each write | Read the PO back and compare qty, supplier, pending qty, status and cost |
| L1+, outcome | after all writes | Budget within total; storage fits on each delivery day; Scenario 2 coverage restored |
| L2, supplier confirmation | when the supplier answers | The shortfall webhook: a confirmation that differs from the PO starts Scenario 2 |
| L3, outcome over time | after lead time | Roadmap: compare actual arrivals and stock-outs, and feed supplier reliability |

**Four reconciliation moves.** Exactly one is chosen per failure by `engine/reconciler.ts`.

| Move | When | Example in the eval |
|---|---|---|
| RETRY | transient error, or a write not yet visible | s1-f: a timeout after the PO was written; the same key returns the original PO with no duplicate. s1-g: a 404 on read-back, re-read. |
| ADJUST | the system said what would work, or produced a different result | s2-e: MOQ rose to 300, so re-check budget and storage, order 300 on a new key |
| COMPENSATE | a later step failed after earlier ones succeeded, or an adjustment does not fit | s2-f: another buyer takes part of the budget between the agent's check and its write, so the adjusted order fails; revert PO-2001. s1-h: the PO was silently rounded to 300, beyond storage, so cancel it |
| ESCALATE | nothing safe left | always after COMPENSATE, with a clean state and priced options |

## Human approval policy (`engine/policy.ts`)

| Rule | Fires when |
|---|---|
| PO_VALUE | any new PO above ₹1,00,000 |
| UPWARD_DEVIATION | ordering more than 20% *above* the recommendation (buying less is automatic) |
| SUPPLIER_SWITCH_PREMIUM | switching supplier at more than a 10% premium |
| AFTER_FAILURE | re-executing after a failure, unless it is an ADJUST that grows the order by at most 20% |

REJECT, INVESTIGATE and ESCALATE never need approval, because no money moves.

## Trade-offs

Each entry gives what was chosen, what it costs, and when I would change it.

1. **LLM plans, code decides, guard enforces**, rather than end-to-end LLM reasoning. *Cost:* the model cannot improvise a calculation nobody wrote. *Why:* money moves, and answers must be reproducible and testable. *Change when:* every decision has a human reviewer anyway and the agent only drafts.
2. **Hand-written loop**, rather than LangChain or an agent framework. *Cost:* no built-in tracing, parallelism or memory. *Why:* I can explain and modify every line live, and the trace is domain-specific. *Change when:* the loop stabilises and observability across many agents matters.
3. **Auto-execute within policy**, rather than always asking. *Cost:* some risk on automatic cases. *Why:* full approval saves the buyer no time. The limits are the dial; they start tight.
4. **Read-back validation**, rather than trusting the write response. *Cost:* an extra call per write. *Why:* an accepted write is not the same as the expected end state (s1-g, s1-h prove it).
5. **Compensate, then escalate**, rather than forward-fixing or leaving a half-done state. *Cost:* a revert can confuse a supplier who already saw the change. *Why:* amendments stay soft until the decision validates, so the revert is internal. *Change when:* the supplier is notified immediately; then escalate instead of reverting.
6. **MongoDB**, rather than Postgres. *Cost:* weaker multi-document transactions and ledger integrity for budget reservations. *Why:* the decision trace is naturally one document, and it is my most fluent stack. *Change when:* in production, money-moving writes would use transactions or a relational ledger.
7. **Mocks in-process over HTTP**, rather than separate services. *Cost:* no real latency, auth or partitions. *Why:* the HTTP boundary keeps a swap to real systems a URL change, and fault injection gives the failure realism that matters.
8. **Depth on Scenarios 1 and 2**, rather than all four. *Cost:* Scenario 3's evidence reasoning is not demonstrated. *Why:* the brief values depth, and Scenario 2 exercises the feedback loop.
9. **Recorded LLM fixtures in the eval**, rather than live calls every time. *Cost:* replay tests the pipeline against known model behaviour, not today's model. *Why:* deterministic, offline and free, and the free tier is rate-limited. `eval:live` checks for drift. The key hashes the full request, so a prompt change produces a miss, never a stale pass.
10. **Gemini free tier behind `LLMClient`**, rather than a paid frontier model. *Cost:* rate limits, and plainer prose: Flash-Lite tends to copy the evidence facts rather than summarise them. *Why:* it is free, and correctness comes from the engine. Grounded facts plus the number check keep the explanation accurate even with a small model. Swapping providers means writing one adapter. *Change when:* explanation quality matters; then use a stronger model for the summary.
11. **Simulated clock**, rather than wall time. *Cost:* the world does not move by itself. *Why:* freshness rules, lead times and fixtures are reproducible. Audit timestamps still use wall time.

## Roadmap (each item plugs into the same loop)

| Problem | What plugs in | Effort |
|---|---|---|
| Supplier reliability (L3) | Write actual vs promised lead time and fill rate back to `suppliers.reliability` on receipt; the calculator already uses `avgLeadDelta` and scoring uses `onTimeRate` | 1–2h |
| Forecast anomalies (Scenario 3) | A `demandAnomaly` trigger, a `get_sales_history` tool, and an evidence rule on spike duration and breadth before re-forecasting | 2h |
| Replenishment sweep | A scheduled trigger over all SKU-nodes into the Scenario 1 path, with no external recommendation | 1h |
| Promotional and seasonal buying | Promotions and a seasonality overlay in the forecast tool; post-promo overstock check | 1.5h |
| Open-PO hygiene | A late-PO trigger reusing Scenario 2 logic; duplicate-PO detection | 1h |
| Budget reallocation | A `propose_budget_transfer` action gated by approval, turning "no budget" escalations into a one-click decision | 1h |
| Production hardening | Transactions for budget reservations, outbox for supplier notifications, auth, metrics | n/a |
