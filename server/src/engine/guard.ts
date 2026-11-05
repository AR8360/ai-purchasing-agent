import type { EngineDecision, SubmittedDecision } from '@purchasing/shared';

/**
 * Decision guard: the LLM proposes, the engine verifies. A submission that
 * disagrees with the deterministic engine is rejected with the reasons, and the
 * model must reconsider. This keeps money-moving numbers out of the model's hands.
 */
export function checkSubmission(sub: SubmittedDecision, engine: EngineDecision): string[] {
  const problems: string[] = [];
  if (sub.decision !== engine.decision) {
    problems.push(`decision is ${sub.decision} but the engine result is ${engine.decision} (rule ${engine.rule}: ${engine.summary})`);
  }
  if (engine.quantity !== undefined && engine.decision !== 'REJECT' && sub.quantity !== engine.quantity) {
    problems.push(`quantity is ${sub.quantity ?? 'missing'} but the engine computed ${engine.quantity}`);
  }
  if (sub.strategy && sub.strategy !== engine.strategy) {
    problems.push(`strategy is ${sub.strategy} but the engine chose ${engine.strategy}`);
  }
  if (sub.actions.length !== engine.actions.length) {
    problems.push(`${sub.actions.length} actions submitted but the engine plan has ${engine.actions.length}`);
  } else {
    engine.actions.forEach((e, idx) => {
      const s = sub.actions[idx]!;
      if (s.type !== e.type) problems.push(`action ${idx} type ${s.type} ≠ ${e.type}`);
      if (s.supplierId !== e.supplierId) problems.push(`action ${idx} supplier ${s.supplierId} ≠ ${e.supplierId}`);
      if (s.qty !== e.qty) problems.push(`action ${idx} qty ${s.qty} ≠ ${e.qty}`);
      if (e.poId && s.poId !== e.poId) problems.push(`action ${idx} poId ${s.poId ?? 'missing'} ≠ ${e.poId}`);
    });
  }
  if (sub.decision === 'INVESTIGATE' && !sub.missingInformation?.length) {
    problems.push('INVESTIGATE requires missingInformation');
  }
  if (engine.facts?.length) {
    const evidence = [...engine.facts, engine.summary, JSON.stringify(engine.actions)].join(' ');
    const ungrounded = ungroundedNumbers(sub.reasoning, evidence);
    if (ungrounded.length) {
      problems.push(
        `reasoning cites numbers that are not in engineDecision.facts: ${ungrounded.join(', ')}. Rewrite those bullets using only figures from the facts, with their labels.`,
      );
    }
  }
  return problems;
}

/** Numbers of 10 or more (ignoring commas and ₹) that appear in the text. */
export function numbersIn(text: string): number[] {
  return (text.replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => n >= 10);
}

/**
 * Reasoning grounding: every number of 10 or more the model writes must appear in the
 * evidence. Small integers (days, pack counts) are too ambiguous to check usefully.
 */
export function ungroundedNumbers(reasoning: string[], evidence: string): number[] {
  const allowed = new Set(numbersIn(evidence));
  return [...new Set(reasoning.flatMap(numbersIn))].filter((n) => !allowed.has(n));
}
