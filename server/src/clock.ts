import { config } from './config.js';

/**
 * Injected simulation clock. The demo world (seeds, mocks, agent) runs on a fixed
 * "now" so that data freshness, lead times and recorded LLM fixtures are
 * reproducible. Nothing else in the server reads the wall clock for business logic.
 */
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

let current = new Date(config.simNow);

export const clock = {
  now(): Date {
    return new Date(current.getTime());
  },
  iso(): string {
    return current.toISOString();
  },
  set(d: Date | string) {
    current = new Date(d);
  },
  reset() {
    current = new Date(config.simNow);
  },
  /** Wall-clock time, used only for audit timestamps in the decision trace (never for business logic). */
  wallIso(): string {
    return new Date().toISOString();
  },
};

export const addDays = (days: number, from: Date = clock.now()) => new Date(from.getTime() + days * DAY_MS);
export const addHours = (hours: number, from: Date = clock.now()) => new Date(from.getTime() + hours * HOUR_MS);
export const daysUntil = (d: Date | string, from: Date = clock.now()) =>
  (new Date(d).getTime() - from.getTime()) / DAY_MS;
