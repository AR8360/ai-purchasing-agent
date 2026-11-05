import { SubmitDecisionSchema, type DecisionDoc } from '@purchasing/shared';
import { clock } from '../clock.js';
import { checkSubmission } from '../engine/guard.js';
import { transition } from '../engine/stateMachine.js';
import { LLM_TOOLS, REQUIRED_TOOLS, TOOLS_BY_NAME, toToolDeclarations, type ToolContext } from '../tools/registry.js';
import type { LLMClient, LLMMessage } from './llm.js';
import { SYSTEM_PROMPT, triggerMessage } from './prompts.js';
import { persist } from './store.js';

export const MAX_TURNS = 15;

/** Trim large tool outputs before they go back to the model (the full output stays in the trace). */
function forModel(output: unknown): Record<string, unknown> {
  return { result: output as never };
}

/**
 * The investigation loop. The model plans which tools to call; tools run in code;
 * the loop ends only when submit_decision is accepted by the decision guard.
 * Returns true when a decision was accepted.
 */
export async function investigate(d: DecisionDoc, llm: LLMClient): Promise<boolean> {
  transition(d, 'INVESTIGATING', { at: clock.wallIso(), reason: 'Agent started gathering evidence' });
  await persist(d);

  const ctx: ToolContext = { decision: d, decisionId: d.decisionId, faults: d.faults };
  const tools = toToolDeclarations(LLM_TOOLS);
  const messages: LLMMessage[] = [{ role: 'user', text: triggerMessage(d.trigger) }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await llm.generate({ system: SYSTEM_PROMPT, messages, tools });
    d.llm.turns++;
    if (res.cached) d.llm.cacheHits++;
    messages.push(res.message);

    if (res.toolCalls.length === 0) {
      messages.push({ role: 'user', text: 'Respond only by calling tools. Continue with the next required tool, or submit_decision.' });
      continue;
    }

    const results: { id: string; name: string; response: Record<string, unknown> }[] = [];
    let accepted = false;
    for (const call of res.toolCalls) {
      const started = Date.now();
      let output: unknown;
      let ok = true;
      let error: string | undefined;
      try {
        if (call.name === 'submit_decision') {
          output = handleSubmit(d, call.args, turn);
          accepted = (output as { accepted: boolean }).accepted;
        } else {
          const tool = TOOLS_BY_NAME.get(call.name);
          if (!tool) throw new Error(`Unknown tool ${call.name}`);
          const parsed = tool.input.safeParse(call.args);
          if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
          output = await tool.handler(parsed.data, ctx);
        }
      } catch (e) {
        ok = false;
        error = (e as Error).message;
        output = { error };
      }
      d.toolCalls.push({ turn, name: call.name, input: call.args, output, ok, error, ms: Date.now() - started, at: clock.wallIso() });
      results.push({ id: call.id, name: call.name, response: forModel(output) });
    }
    await persist(d);
    if (accepted) {
      transition(d, 'DECIDED', {
        at: clock.wallIso(),
        reason: `Agent submitted ${d.decision!.decision} after ${turn} turn(s)`,
        expected: d.engine?.decision,
        observed: d.decision!.decision,
      });
      await persist(d);
      return true;
    }
    messages.push({ role: 'tool', results });
  }

  d.error = `Agent did not reach an accepted decision within ${MAX_TURNS} turns`;
  transition(d, 'ESCALATED', { at: clock.wallIso(), reason: d.error });
  d.escalation = { summary: d.error, options: [{ label: 'Review manually', detail: 'Inspect the trace and decide' }] };
  await persist(d);
  return false;
}

function handleSubmit(d: DecisionDoc, args: unknown, turn: number) {
  const parsed = SubmitDecisionSchema.safeParse(args);
  const problems: string[] = [];
  if (!parsed.success) {
    problems.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  }
  const called = new Set(d.toolCalls.filter((t) => t.ok).map((t) => t.name));
  const missing = REQUIRED_TOOLS[d.trigger.type].filter((t) => !called.has(t));
  if (missing.length) problems.push(`required tools not yet called successfully: ${missing.join(', ')}`);
  if (!d.engine) problems.push('no engine result yet: call the engine tool first');
  if (parsed.success && d.engine) problems.push(...checkSubmission(parsed.data, d.engine));

  if (problems.length || !parsed.success) {
    d.rejectedSubmissions.push({ turn, problems });
    return { accepted: false, problems, engineDecision: d.engine ?? undefined };
  }
  // Normalise: a quantity only means something when the engine produced one.
  const quantity = d.engine!.quantity === undefined ? undefined : parsed.data.quantity;
  d.decision = { ...parsed.data, quantity, strategy: parsed.data.strategy ?? d.engine!.strategy };
  return { accepted: true };
}
