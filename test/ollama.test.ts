import assert from "node:assert/strict";
import test from "node:test";
import { OllamaProvider } from "../src/providers/ollama.ts";

test("Ollama controls thinking and retains finish reason without treating thinking as a report", async () => {
  const provider = new OllamaProvider("qwen3.8:27b", undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, 4096);
    assert.equal(body.options.num_ctx, 32768);
    return Response.json({ message: { content: "", thinking: "internal work" }, done_reason: "length", eval_count: 4096 });
  });
  const result = await provider.complete({ messages: [], maxInputTokens: 24000, maxOutputTokens: 4096, thinking: false });
  assert.equal(result.content, "");
  assert.equal(result.finishReason, "length");
  assert.equal(result.usage.outputTokens, 4096);
});
