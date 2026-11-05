import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a Zod schema to a plain, self-contained JSON Schema object that LLM
 * function-calling APIs accept: no $schema, no $ref/definitions (inlined).
 */
export function toToolJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

const DROP_KEYS = new Set(['$schema', 'definitions', '$defs', 'default']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return node;
}
