import type { ChatResult, CostEstimate, RunLedger } from "./types.ts";

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class BudgetGuard {
  readonly ledger: RunLedger;

  constructor(hardCapUsd: number, startedAt = new Date().toISOString()) {
    if (!Number.isFinite(hardCapUsd) || hardCapUsd < 0) {
      throw new Error("budgetUsd must be a non-negative finite number");
    }
    this.ledger = { hardCapUsd, spentUsd: 0, reservedUsd: 0, calls: [], startedAt };
  }

  reserve(estimate: CostEstimate): number {
    if (!estimate.known) throw new BudgetExceededError("Provider cannot estimate this request's cost.");
    if (estimate.usd < 0 || !Number.isFinite(estimate.usd)) throw new Error("Invalid cost estimate.");
    if (this.ledger.spentUsd + this.ledger.reservedUsd + estimate.usd > this.ledger.hardCapUsd + 1e-9) {
      throw new BudgetExceededError(`Call reservation ($${estimate.usd.toFixed(6)}) exceeds remaining budget.`);
    }
    this.ledger.reservedUsd += estimate.usd;
    return estimate.usd;
  }

  settle(stage: string, reservedUsd: number, result: ChatResult, fallbackCostUsd: number): void {
    this.ledger.reservedUsd = Math.max(0, this.ledger.reservedUsd - reservedUsd);
    const actualUsd = result.costUsd ?? fallbackCostUsd;
    this.ledger.spentUsd += actualUsd;
    this.ledger.calls.push({
      stage,
      provider: result.provider,
      model: result.model,
      estimatedUsd: reservedUsd,
      actualUsd,
      usage: result.usage,
    });
  }

  finish(): RunLedger {
    this.ledger.finishedAt = new Date().toISOString();
    return this.ledger;
  }
}
