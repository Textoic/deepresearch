import type { ChatRequest, ChatResult, CostEstimate, InferenceProvider } from "../types.ts";

interface Price { prompt: number; completion: number; }

export class OpenRouterProvider implements InferenceProvider {
  readonly kind = "openrouter" as const;
  private price?: Price;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  constructor(model: string, apiKey: string, fetchFn: typeof fetch = fetch, baseUrl = "https://openrouter.ai/api/v1") {
    this.model = model; this.apiKey = apiKey; this.fetchFn = fetchFn; this.baseUrl = baseUrl;
    if (!apiKey) throw new Error("OpenRouter API key is required.");
  }

  async estimateCost(request: ChatRequest): Promise<CostEstimate> {
    const price = await this.getPrice();
    const inputTokens = Math.ceil(request.messages.map((m) => m.content).join("\n").length / 4);
    return { usd: inputTokens * price.prompt + request.maxOutputTokens * price.completion, inputTokens, outputTokens: request.maxOutputTokens, known: true };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const response = await this.fetchFn(new URL("/chat/completions", this.baseUrl), {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, messages: request.messages, max_tokens: request.maxOutputTokens, temperature: request.temperature ?? 0.2 }),
    });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
    const body = await response.json() as Record<string, unknown>;
    const choices = body.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    if (!message || typeof message.content !== "string") throw new Error("OpenRouter response had no message content.");
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const price = await this.getPrice();
    const inputTokens = numberValue(usage.prompt_tokens); const outputTokens = numberValue(usage.completion_tokens);
    return { content: message.content, model: typeof body.model === "string" ? body.model : this.model, provider: this.kind,
      usage: { inputTokens, outputTokens, reasoningTokens: numberValue(usage.reasoning_tokens), cachedTokens: numberValue(usage.cached_tokens) },
      costUsd: typeof usage.cost === "number" ? usage.cost : inputTokens * price.prompt + outputTokens * price.completion, raw: body };
  }

  private async getPrice(): Promise<Price> {
    if (this.price) return this.price;
    const response = await this.fetchFn(new URL(`/model/${this.model}`, this.baseUrl), { headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" } });
    if (!response.ok) throw new Error(`Cannot get OpenRouter model pricing (${response.status}).`);
    const json = await response.json() as { data?: { pricing?: { prompt?: string; completion?: string } } };
    const prompt = Number(json.data?.pricing?.prompt); const completion = Number(json.data?.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) throw new Error("OpenRouter returned invalid model pricing.");
    this.price = { prompt, completion }; return this.price;
  }
}

function numberValue(value: unknown): number { return typeof value === "number" ? value : 0; }
