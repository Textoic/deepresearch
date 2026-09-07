import type { ChatRequest, ChatResult, CostEstimate, InferenceProvider } from "../types.ts";

export class OllamaProvider implements InferenceProvider {
  readonly kind = "ollama" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  constructor(model: string, baseUrl = "http://127.0.0.1:11434", fetchFn: typeof fetch = fetch) {
    this.model = model; this.baseUrl = baseUrl; this.fetchFn = fetchFn;
  }

  async estimateCost(request: ChatRequest): Promise<CostEstimate> {
    return { usd: 0, inputTokens: estimateTokens(request.messages.map((m) => m.content).join("\n")), outputTokens: request.maxOutputTokens, known: true };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const response = await this.fetchFn(new URL("/api/chat", this.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15 * 60 * 1000),
      body: JSON.stringify({ model: this.model, messages: request.messages, think: request.thinking, stream: false, options: { num_ctx: 32768, num_predict: request.maxOutputTokens, temperature: request.temperature ?? 0.2 } }),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const body = await response.json() as Record<string, unknown>;
    const message = body.message as Record<string, unknown> | undefined;
    if (!message || typeof message.content !== "string") throw new Error("Ollama response had no message content.");
    return { content: message.content, finishReason: typeof body.done_reason === "string" ? body.done_reason : undefined, model: this.model, provider: this.kind, usage: { inputTokens: numberValue(body.prompt_eval_count), outputTokens: numberValue(body.eval_count) }, costUsd: 0 };
  }
}

function numberValue(value: unknown): number { return typeof value === "number" ? value : 0; }
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
