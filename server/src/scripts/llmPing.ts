import { z } from 'zod';
import { toToolJsonSchema } from '@purchasing/shared';
import { createLLM } from '../agent/llm.js';
import { config } from '../config.js';

/** One minimal tool-calling round trip through LLMClient: proves key, model name and function calling. */
const llm = createLLM();
console.log(`Pinging ${llm.provider}/${llm.model} (thinking=${config.llm.thinkingLevel || 'default'}) ...`);
const started = Date.now();
try {
  const res = await llm.generate({
    system: 'You are a test harness. Always answer by calling the provided tool.',
    messages: [{ role: 'user', text: 'Report that the system is healthy with code 200.' }],
    tools: [
      {
        name: 'report_status',
        description: 'Report system status',
        parameters: toToolJsonSchema(z.object({ healthy: z.boolean(), code: z.number().int() })),
      },
    ],
  });
  console.log(`LLM PING OK in ${Date.now() - started}ms → ${JSON.stringify(res.toolCalls)}`);
} catch (e) {
  console.error('LLM PING FAILED:', (e as Error).message);
  process.exitCode = 1;
}
