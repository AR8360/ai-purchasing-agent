# CLAUDE.md — project rules for the AI Purchasing Agent

`docs/implementation-plan.md` is the plan this was built from; §0 lists where the build intentionally differs. `docs/architecture.md` and `docs/approach.md` describe the system as built. Read them before changing behaviour.

## Non-negotiable design rules

1. **LLM plans, code decides.** The model chooses tools and writes `reasoning[]`. Every quantity, constraint check, state transition and validation lives in `server/src/engine/` as pure TypeScript. The system prompt must never contain formulas or thresholds.
2. **The guard enforces it.** `submit_decision` is accepted only if it matches the engine result (`engine/guard.ts`), all required tools succeeded (`REQUIRED_TOOLS`), and every number of 10 or more in `reasoning` appears in `engine.facts` (`engine/facts.ts`).
3. **Engine is pure.** Nothing under `engine/` performs I/O, imports Mongoose, reads the clock or calls the LLM. Every engine change needs a unit test in `engine/engine.test.ts`.
4. **Tools never call the LLM.** Tool handlers call `/mock/*` over HTTP and log to the decision trace.
5. **Write tools are not model tools** and refuse to run outside their state: create/amend only while EXECUTING, commit while VALIDATING, revert/cancel while RECONCILING.
6. **Every write is idempotent.** `idempotencyKey = ${decisionId}:${actionIndex}:${type}:${attempt}`. RETRY keeps the key; ADJUST increments the attempt.
7. **Never trust a write.** After every action, read the record back (`validatePo`), then check the outcome.
8. **Amendments are soft** (`pendingQty`) until the decision reaches VALIDATED, so COMPENSATE can revert safely.
9. **Faults are consumed once per `decisionId`** so recovery can legitimately succeed.
10. **Injected clock.** Business time comes from `clock.now()` (simulated, `SIM_NOW`). Audit timestamps use `clock.wallIso()`. Never call `Date.now()` for business logic.
11. **Deterministic tool output.** List results must be sorted; anything sent to the model must not contain wall-clock time or random ids (the eval cache keys on the full request).
12. **Trace before next step.** Every tool call, transition, action and validation is persisted before proceeding.

## Stack

- Node 20+, Express, TypeScript strict. React + Vite + TS + TanStack Query. MongoDB + Mongoose. Zod in `shared/`. Vitest.
- Google Gemini via `@google/genai`, only imported in `server/src/agent/llm.ts` behind `LLMClient`. Do not add other LLM SDKs or agent frameworks.
- Env: `LLM_PROVIDER`, `GEMINI_API_KEY`, `MODEL`, `LLM_MIN_INTERVAL_MS`, `LLM_THINKING_LEVEL`, `LLM_CACHE`, `MONGO_URI`, `PORT`, `SIM_NOW`. Never read, print or commit `.env`.

## Commands

- `npm run dev`: API :4000 + UI :5173
- `npm test`: unit tests (engine, shared)
- `npm run eval` / `eval:record` / `eval:live`, plus `-- --case <name>` for one case
- `npm run seed -- <variant>` (`-- --list` lists the variants)
- `npm run llm:ping`, `npm run db:ping`, `npm run show -- <decisionId>`
- `npm run typecheck`

## Workflow

- Change prompts or tool outputs, then run `npm run eval:record` and commit the new fixtures in `eval/fixtures/`.
- Do not commit unless explicitly told. Never squash or rewrite history.

## Key references

- Scenario 1 case B must stay: trueNeed 334, requested 350, budget cap 400, storage cap 250, MODIFY 250, binding STORAGE.
- Scenario 2 case C: stockout day 11.17, budget after amend ₹90,000, RESOURCE to FreshFarms 250 on day 3.
