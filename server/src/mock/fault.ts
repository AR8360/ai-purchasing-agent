import type { Request } from 'express';
import type { Fault } from '@purchasing/shared';

/**
 * Fault injection for the mock external systems.
 *
 * The agent forwards `x-fault: a,b` and `x-fault-key: <decisionId>` on every call.
 * Each fault fires at most ONCE per key, at the first endpoint that can apply it,
 * in the order listed. That is what makes recovery testable: the first attempt
 * fails, a correct retry or adjustment succeeds.
 */
const consumed = new Map<string, Set<string>>();

export function takeFault(req: Request, applicable: Fault[]): Fault | null {
  const header = String(req.header('x-fault') ?? '').trim();
  if (!header) return null;
  const key = String(req.header('x-fault-key') ?? 'global');
  const used = consumed.get(key) ?? new Set<string>();
  const requested = header.split(',').map((s) => s.trim()).filter(Boolean) as Fault[];
  for (const f of requested) {
    if (used.has(f)) continue;
    if (!applicable.includes(f)) continue;
    used.add(f);
    consumed.set(key, used);
    return f;
  }
  return null;
}

export function resetFaults() {
  consumed.clear();
}
