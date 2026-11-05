# AI Purchasing Agent

An agent for a quick-commerce buyer that **makes, executes and validates purchasing decisions**. It reviews replenishment recommendations (Scenario 1) and responds to supplier shortfalls (Scenario 2). It gathers evidence through tools, lets a deterministic engine compute every quantity, routes risky actions to a human, places and amends purchase orders, reads every write back, and recovers when the result is not what it expected. It retries, adjusts, compensates or escalates as needed.

> "The goal is not to build a chatbot that answers purchasing questions. The goal is to demonstrate a system capable of making, executing, and validating purchasing decisions."

![Feedback loop: MOQ rejected → adjust → re-execute → validated](docs/images/feedback-loop.png)

## Demo

▶ **[Demo video](https://www.loom.com/share/8f2f0f2f149e4313873dfa5973ce5843)** — a live run of Scenario 1 (modify, then human approval) and Scenario 2 (re-source, adjust after a rejected order, compensate after a second failure), then the evaluation tab.

🌐 **[Live app](https://ai-purchasing-agent-tl1s.onrender.com)** — pick a scenario under Simulate and click **Seed world & run agent**. It runs on Render's free plan, so the first load after a quiet period can take about a minute. Recorded scenarios replay from saved model responses, so they use no API quota; only a request that was never recorded calls Gemini.

To run it yourself you do not need a Gemini key: with the default `LLM_CACHE=record`, every demo scenario replays recorded model responses.

## Run it

Requirements: Node 20+, and a MongoDB (Atlas free tier, or `docker compose up -d` for a local one).

```bash
cp .env.example .env        # set MONGO_URI; GEMINI_API_KEY is optional (see below)
npm install
npm run dev                 # API on :4000, UI on http://localhost:5173
```

Useful commands:

| Command | What it does |
|---|---|
| `npm test` | 42 unit tests: engine and contracts. Pure, no network. |
| `npm run eval` | 15 end-to-end scenarios replayed from recorded LLM responses. Deterministic, no API key needed. |
| `npm run eval:record` | Records LLM responses the fixtures do not have yet, using the real model. |
| `npm run eval:live` | Calls the model for every turn and refreshes the fixtures. |
| `npm run seed -- s1-b` | Resets the world to a scenario (`npm run seed -- --list` lists them). |
| `npm run llm:ping` / `npm run db:ping` | Checks the Gemini key, model and function calling, or the database connection. |
| `npm run show -- <decisionId>` | Prints a decision trace in the terminal. |

**API key and quota.** You do not need a Gemini key to try it. With the default `LLM_CACHE=record`, the 15 demo scenarios replay from recorded model responses, so running them in the UI and `npm run eval` use no quota. A key is only used for a request that was never recorded, or when you choose `LLM_CACHE=off` or `npm run eval:live`. That is about 2 model calls per scenario run (about 30 for a full live evaluation), well within the Gemini free tier. Calls are spaced by `LLM_MIN_INTERVAL_MS`, 429s are retried with backoff, and a daily-quota error fails fast with a clear message instead of hanging.

## Deploy (optional)

`render.yaml` deploys the API, the mock systems and the built UI as one free Render web service. It runs with `LLM_CACHE=record`: recorded scenarios replay at no quota cost, and only unrecorded requests call Gemini (without a `GEMINI_API_KEY` it behaves like replay). Set `MONGO_URI`, and optionally `GEMINI_API_KEY`, in the Render dashboard (use a separate database name, for example `/purchasing_demo`), and allow Render in Atlas Network Access. The free plan sleeps when idle, so the first request can take about a minute.

## Demo script (UI)

Use **Simulate → pick a scenario → Seed world & run agent**. Each run re-seeds the database and fires that scenario's trigger and faults.

1. **`s1-b`, MODIFY.** The system recommends 800. The agent finds PO-1041 (400) already inbound, computes a true need of 334, and sees storage caps the order at 250. It orders 250, reads PO-1042 back and validates it.
2. **`s1-e`, human in the loop.** The recommendation of 200 is too low, and the agent wants 350 (+75%), so policy stops at **NEEDS APPROVAL**. Click **Approve & execute**.
3. **`s2-c`, re-source.** DairyCo confirms 250 of 500, and its backfill (day 14) lands after the projected stockout (day 11.17). FreshFarms delivers on day 3 at +5%, so the agent amends PO-2001 to 250 and creates PO-2002.
4. **`s2-e`, ADJUST.** FreshFarms rejects 250 because its MOQ is now 300. The agent re-checks budget and storage, adjusts to 300 on a new idempotency key, re-executes and validates.
5. **`s2-f`, COMPENSATE.** The adjusted order then fails on budget. The agent reverts the PO-2001 amendment and escalates with priced options and a clean state.
6. **`s1-f` / `s1-g` / `s1-h`, retry, read-back and mismatch.** A timeout after the write is retried with the same key (no duplicate PO). A PO that is not readable yet is re-read. A silently changed quantity that breaks storage is cancelled and escalated.
7. **`s1-i`, REJECT.** The system again recommends 800, but 600 on hand plus PO-1041 (400) already cover the 884 needed. The agent rejects the recommendation and orders nothing (NO ACTION).
8. **Evaluation tab → Run all cases (replay).** 15/15, each with an **Open trace** link.

## How it works (one paragraph)

The **LLM plans; code decides.** Gemini is given read tools, two engine tools (`check_constraints`, `assess_shortfall`) and `submit_decision`. In its first turn it gathers all the evidence in parallel. In the second it submits a decision with reasoning written from the engine's labelled **evidence facts**. A **decision guard** rejects any submission that disagrees with the deterministic engine, or whose reasoning cites a number not in those facts, so neither the quantities nor the explanation can drift from the evidence. A **policy table** decides whether a human must approve. **Execution** runs the engine's plan (amend before create), with **idempotency keys** on every write. **Validation** reads every record back and checks the whole outcome: budget, storage on each delivery day, and coverage restored. On any mismatch, the **reconciler** picks exactly one of RETRY / ADJUST / COMPENSATE / ESCALATE. Every step is appended to one MongoDB document per decision, and that document is the audit log, the UI and the evaluation evidence.

## How the agent's decisions are validated

Validation happens at four points, and each one is recorded in the decision trace:

1. **Before acting: the decision guard.** The model's `submit_decision` is checked against the deterministic engine (decision, quantity, strategy and every action), and every number in its reasoning is checked against the engine's evidence facts. A mismatch is rejected and the model must resubmit.
2. **Before money moves: the policy gate.** Rules in `server/src/engine/policy.ts` send large orders, large increases over the recommendation, expensive supplier switches and risky re-executions to a human (NEEDS APPROVAL).
3. **After every write: read-back.** Each created or amended purchase order is read back and compared field by field with what was expected: quantity, supplier, status, cost and any pending amendment.
4. **After all writes: outcome checks.** The budget stays within its total, storage fits on every delivery day, and in Scenario 2 the originally ordered quantity is covered again.

When a check fails, the reconciler chooses one move: RETRY (same idempotency key, so no duplicate orders), ADJUST (for example a new MOQ, re-checked against budget and storage), COMPENSATE (undo the completed steps) or ESCALATE (a clean state plus priced options for the buyer). Details are in [docs/approach.md](docs/approach.md#the-feedback-loop), and the 15 cases in [docs/evaluation.md](docs/evaluation.md) prove each path.

## How this covers the brief

| The brief asks | Where it is answered |
|---|---|
| The recommendation should not be assumed correct | The engine computes its own need from inventory, demand, open POs and terms: `s1-b` (800 → 250), `s1-e` (200 → 350), `s1-i` (800 → reject) |
| Multiple factors and constraints | Lead time, MOQ, pack size, budget, and storage on the delivery day (`engine/constraints.ts`); conflicts in `s1-b`, `s1-c`, `s2-d`, `s2-f` |
| **Scenario 1:** accept, modify, reject or investigate | `s1-a` ACCEPT, `s1-b` MODIFY, `s1-i` REJECT, `s1-d` INVESTIGATE (stale forecast); `s1-c` ESCALATE when no quantity fits |
| Scenario 1: explain the important factors | The buyer note: the quantity chain plus labelled evidence facts, checked by the guard |
| **Scenario 2:** what happens next, and what information is needed | `get_purchase_order`, terms, alternates, inventory, forecast, budget and storage, then `assess_shortfall`. Outcomes: existing stock is enough (`s2-a`), additional PO from the same supplier (`s2-b`), another supplier (`s2-c`), escalate (`s2-d`) |
| Scenario 3: demand change | Not built end-to-end (the brief requires at least one scenario). It reuses the Scenario 1 path plus an evidence step; see the roadmap in [docs/approach.md](docs/approach.md#roadmap-each-item-plugs-into-the-same-loop) |
| Scenario 4: a constraint blocks the purchase | Handled inside Scenarios 1 and 2: cap to the feasible quantity (`s1-b`), escalate with options (`s1-c`, `s2-d`), adjust or compensate (`s2-e`, `s2-f`) |
| Agent behaviour: information, tools, data, decisions, allowed actions, approval, validation | [docs/architecture.md](docs/architecture.md) (tools, data model, state machine) and [docs/approach.md](docs/approach.md) (principles, policy). The model can only read and compute; writes run in code after the guard and policy |
| Feedback and validation | Read-back, outcome checks and the reconciler (above); cases `s1-f`, `s1-g`, `s1-h`, `s2-e`, `s2-f` |
| Evaluation | [docs/evaluation.md](docs/evaluation.md): 15 cases mapped to the brief's six questions |
| Optional buyer problems | Shown: alternate-supplier scoring (`engine/supplierScore.ts`), safety stock (`engine/calculator.ts`), open POs counted in the need, data freshness (stale forecast). Roadmap: supplier reliability write-back, forecast anomalies, promotions, seasonality, replenishment sweep |
| Submission: code, README, architecture diagram, approach, evaluation, mocks and data, validation, working demo, `.env.example`, no secrets | This repo: `server/src/mock/` and `server/src/seed/` for mocks and data, the demo video and live app above, `.env.example` with no values |

## Documents

- [docs/architecture.md](docs/architecture.md): components, state machine, data model, tools
- [docs/approach.md](docs/approach.md): the problem, design principles, the feedback loop, policy, trade-offs, roadmap
- [docs/evaluation.md](docs/evaluation.md): the 15 cases, what each proves, and the results
- [docs/implementation-plan.md](docs/implementation-plan.md): the plan this was built from

## Repository layout

```
shared/   Zod contracts shared by server and client (decision schema, triggers, domain types)
server/   Express API, mock external systems, deterministic engine, tools, agent loop, eval
  src/engine/   pure functions: calculator, constraints, trust, policy, recommendation,
                shortfall, supplierScore, stateMachine, validator, reconciler, guard
  src/tools/    HTTP client to the mock systems, LLM tool registry, write tools
  src/agent/    LLM adapter (Gemini), record/replay cache, loop, execute, reconcile, explain
  src/mock/     the "external systems" with fault injection (x-fault header)
  src/seed/     15 scenario worlds
client/   React + Vite + TanStack Query: inbox, decision trace, approvals, simulate, evaluation
eval/     scenarios/*.json (cases), fixtures/*.json (recorded LLM responses)
docs/     architecture, approach, evaluation, plan, screenshots
```

## Notes

- **Stack:** TypeScript end to end (Node, Express, React), MongoDB with Mongoose, Google Gemini via `@google/genai` (free tier), Zod and Vitest. No agent framework: the loop is about 100 lines in `server/src/agent/loop.ts`.
- **Model:** the fixtures were recorded with `gemini-3.5-flash-lite`. The free tier of larger models can be as low as 20 requests per day, which is too few for evaluation. Replay always uses the model recorded in `eval/fixtures/_manifest.json`.
- **Simulated time:** the world runs on a fixed clock (`SIM_NOW`), so data freshness, lead times and recorded fixtures are reproducible.
- **AI assistance:** this project was built with AI coding assistance, which the assignment allows. Every design decision is documented in `docs/approach.md`.
