import { FunctionCallingConfigMode, GoogleGenAI, type Content, type Part } from '@google/genai';
import { config } from '../config.js';

/**
 * Provider-agnostic LLM interface. Only this file imports the Gemini SDK; the agent
 * loop and the eval cache depend on LLMClient alone, so another provider is one adapter.
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'user'; text: string }
  /** The model's turn, kept as the provider returned it (it can carry opaque fields, e.g. thought signatures). */
  | { role: 'model'; content: unknown }
  | { role: 'tool'; results: { id: string; name: string; response: Record<string, unknown> }[] };

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: ToolDeclaration[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LLMResponse {
  toolCalls: ToolCall[];
  text?: string;
  message: LLMMessage;
  cached?: boolean;
  usage?: unknown;
}

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------------

const SYNTHETIC = 'synthetic:';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build the neutral response from a Gemini content object (also used when replaying fixtures). */
export function responseFromGeminiContent(content: Content, usage?: unknown): LLMResponse {
  const parts = content.parts ?? [];
  const toolCalls: ToolCall[] = [];
  parts.forEach((p, i) => {
    if (p.functionCall?.name) {
      toolCalls.push({
        id: p.functionCall.id ?? `${SYNTHETIC}${p.functionCall.name}-${i}`,
        name: p.functionCall.name,
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  });
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('\n')
    .trim();
  return { toolCalls, text: text || undefined, message: { role: 'model', content }, usage };
}

export function toGeminiContents(messages: LLMMessage[]): Content[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'model') return m.content as Content;
    const parts: Part[] = m.results.map((r) => ({
      functionResponse: {
        ...(r.id.startsWith(SYNTHETIC) ? {} : { id: r.id }),
        name: r.name,
        response: r.response,
      },
    }));
    return { role: 'user', parts };
  });
}

function retryDelayMs(err: any, attempt: number): number {
  // The API sometimes reports "retryDelay": "23s" in the error details.
  const m = String(err?.message ?? '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]) * 1000) + 500;
  return Math.min(60_000, 2000 * 2 ** attempt);
}

export class GeminiClient implements LLMClient {
  readonly provider = 'gemini';
  private ai: GoogleGenAI;
  private lastCallAt = 0;
  private useThinking: boolean;

  constructor(
    readonly model: string,
    private opts: { apiKey: string; minIntervalMs: number; thinkingLevel: string; timeoutMs: number; maxRetries?: number },
  ) {
    if (!opts.apiKey) throw new Error('GEMINI_API_KEY is not set');
    if (!model) throw new Error('MODEL is not set');
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: opts.timeoutMs } });
    this.useThinking = !!opts.thinkingLevel;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const maxRetries = this.opts.maxRetries ?? 5;
    const contents = toGeminiContents(req.messages);
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCallAt + this.opts.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      try {
        const res = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: req.system,
            tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
            // The agent must always act through a tool (submit_decision is a tool too).
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
            ...(this.useThinking ? { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel as any } } : {}),
          },
        });
        const content = res.candidates?.[0]?.content;
        if (!content?.parts?.length) {
          if (attempt < maxRetries) continue;
          throw new Error(`Gemini returned no content (finishReason=${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
        }
        return responseFromGeminiContent(content, res.usageMetadata);
      } catch (err: any) {
        const status = Number(err?.status ?? err?.code);
        if (status === 400 && /thinking/i.test(String(err?.message)) && this.useThinking) {
          // This model does not support the configured thinking level: fall back to its default.
          this.useThinking = false;
          continue;
        }
        if ((RETRYABLE.has(status) || /fetch failed|timeout|ECONNRESET/i.test(String(err?.message))) && attempt < maxRetries) {
          const delay = retryDelayMs(err, attempt);
          if (delay > MAX_RETRY_WAIT_MS) {
            // e.g. a daily free-tier quota: waiting hours is never the right move for an agent.
            throw new Error(
              `Gemini quota exhausted for ${this.model} (retry suggested in ${Math.round(delay / 60000)} min). Use another model or wait. ${String(err?.message).slice(0, 200)}`,
            );
          }
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
  }
}

export function createLLM(): LLMClient {
  if (config.llm.provider !== 'gemini') throw new Error(`Unsupported LLM_PROVIDER "${config.llm.provider}"`);
  return new GeminiClient(config.llm.model, {
    apiKey: config.llm.apiKey,
    minIntervalMs: config.llm.minIntervalMs,
    thinkingLevel: config.llm.thinkingLevel,
    timeoutMs: config.llm.requestTimeoutMs,
  });
}
