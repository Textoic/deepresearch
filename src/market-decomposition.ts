import { BudgetExceededError } from "./budget.ts";
import { linkSourceReferences } from "./citations.ts";
import { fetchRaceOdds, parseSenateRoster } from "./senate-evidence.ts";
import { candidateName, eligibleMarket, evidenceForWriter } from "./market-policy.ts";
import { candidateUnit, dependencyQueries, discoveryQueries, namedUnit, parseUnits } from "./market-units.ts";
import { auditMessages, discoveryMessages, dossierMessages, renderSources, type Lead } from "./decomposition-prompts.ts";
import { DecompositionSession, DISCOVERY_TOKENS, DOSSIER_TOKENS, TruncatedOutputError, type Decomposition, type DecompositionOptions } from "./decomposition-session.ts";
import { OPERATIONAL_PREFIX } from "./run-assembly.ts";
import type { ChatMessage, PolymarketMarket, ResearchDossier, ResearchUnit } from "./types.ts";

export type { DecompositionOptions };

const NO_ROSTER = "No complete official Senate roster parsed; provide a captured Senate table to establish the seat baseline.";
const INCOMPLETE_UNITS = "Not every planned unit was researched; see unit roster and dossiers.";
const EXCLUDED_QUOTE = "Structured quote excluded by evidence cutoff policy";
const UNVERIFIED_HOLDER = "Current holder not verified from official roster.";
const PARTIAL_COVERAGE_NOTE = "[Coverage of this subject stops here; the remaining retrieved evidence for it was not summarised.]";

const MAX_UNLISTED = 5;
const MAX_DEPENDENCIES = 6;
const MAX_LEADS = 90;
const LEAD_PREFIX_CHARACTERS = 250;
const LEAD_MENTION = /press secretary|contender|successor|replace/i;
const CITED_SOURCE = /Source \d+/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UnitContext { numbers: number[]; promptMessages: ChatMessage[]; }

function sameName(market: PolymarketMarket, name: string): boolean {
  return candidateName(market).toLowerCase() === name.toLowerCase();
}

function auditQueries(title: string): string[] {
  return [`${title} communications director additional names considered -odds -betting`, `${title} unexpected candidate shortlist -odds -betting`];
}

class MarketDecomposer extends DecompositionSession {
  private readonly candidateMode: boolean;

  constructor(options: DecompositionOptions) {
    super(options);
    this.candidateMode = this.result.units.some(unit => unit.kind === "candidate");
  }

  async run(): Promise<Decomposition> {
    this.prepareRoster();
    await this.discover();
    await this.researchUnits();
    const researched = this.result.dossiers.filter(dossier => dossier.unit.kind !== "discovery").length;
    if (researched < this.result.units.length) this.result.limitations.push(INCOMPLETE_UNITS);
    this.result.limitations = [...new Set(this.result.limitations)];
    return this.result;
  }

  private prepareRoster(): void {
    if (!this.result.units.some(unit => unit.kind === "race")) return;
    this.result.raceOdds = [];
    this.result.senateRoster = parseSenateRoster(this.sources);
    if (!this.result.senateRoster) this.result.limitations.push(NO_ROSTER);
  }

  private evidenceFor(numbers: number[], question = this.event.title): string {
    return renderSources(this.sources, this.event, numbers, question);
  }

  private unitRoster(): string {
    return this.result.units.map(unit => unit.name).join(", ");
  }

  private async discover(): Promise<void> {
    try {
      const numbers = this.accept(await this.search(discoveryQueries(this.event)));
      if (!this.candidateMode && this.result.units.length > 0) return;
      const promptMessages = discoveryMessages({ asOf: this.asOf, event: this.event, roster: this.unitRoster(), candidateMode: this.candidateMode, evidence: this.evidenceFor(numbers) });
      const planText = await this.call("dependency_discovery", promptMessages, DISCOVERY_TOKENS);
      const unit: ResearchUnit = { name: "Discovery plan", kind: "discovery", question: "Discover unlisted candidates or causal dependencies", queries: discoveryQueries(this.event) };
      this.result.dossiers.push({ unit, reportMarkdown: planText, sourceNumbers: numbers, status: "complete", promptMessages });
      const limit = this.candidateMode ? MAX_UNLISTED : MAX_DEPENDENCIES;
      for (const value of parseUnits(planText, "Discovery returned no units array").slice(0, limit)) this.addDiscoveredUnit(value);
    } catch (error) {
      this.result.limitations.push(`Discovery incomplete: ${describe(error)}`);
    }
  }

  private hasUnit(name: string): boolean {
    return this.result.units.some(unit => unit.name.toLowerCase() === name.toLowerCase());
  }

  private rawMarkets(): PolymarketMarket[] {
    return (this.event.raw as { markets?: PolymarketMarket[] } | null)?.markets ?? [];
  }

  private isRetiredRosterName(name: string): boolean {
    return this.rawMarkets().some(market => !eligibleMarket(market) && sameName(market, name));
  }

  private isListedName(name: string): boolean {
    return (this.event.markets ?? []).some(market => sameName(market, name));
  }

  private addDiscoveredUnit(value: unknown): void {
    const named = namedUnit(value);
    if (!named || this.hasUnit(named.name)) return;
    if (this.isRetiredRosterName(named.name) && !this.isListedName(named.name)) return;
    if (this.candidateMode) { this.result.units.push(candidateUnit(this.event, named.name, true)); return; }
    const queries = dependencyQueries(named.queries);
    if (queries) this.result.units.push({ name: named.name, question: named.question, kind: "dependency", queries });
  }

  private async raceContext(unit: ResearchUnit, numbers: number[]): Promise<string> {
    const underlying = await fetchRaceOdds(unit, this.event);
    if (underlying.source) {
      const ids = this.accept([underlying.source]);
      underlying.snapshot.sourceNumber = ids[0];
      numbers.push(...ids);
      if (!ids.length) { underlying.snapshot.quotes = []; underlying.snapshot.limitation = EXCLUDED_QUOTE; }
    }
    this.result.raceOdds!.push(underlying.snapshot);
    const holder = this.result.senateRoster?.rows.find(row => row.contested && row.state === underlying.snapshot.state);
    const holderFacts = holder
      ? `The official Senate roster lists current holder ${holder.name}, ${holder.party}, class ${holder.senateClass}. A defeated primary incumbent still holds office until the term ends; distinguish incumbent, nominee, and retiring senator.`
      : UNVERIFIED_HOLDER;
    const quotes = underlying.snapshot.sourceNumber ? underlying.source!.text : `No structured odds available: ${underlying.snapshot.limitation}`;
    return `\nSTRUCTURED RACE FACTS: ${holderFacts}\n${quotes}\n`;
  }

  private recordDossier(unit: ResearchUnit, narrativeMarkdown: string, context: UnitContext, status: ResearchDossier["status"]): void {
    this.result.dossiers.push({ unit, narrativeMarkdown, reportMarkdown: linkSourceReferences(narrativeMarkdown, this.sources), sourceNumbers: context.numbers, status, promptMessages: context.promptMessages });
  }

  private recordTruncation(unit: ResearchUnit, error: TruncatedOutputError, context: UnitContext): boolean {
    this.result.limitations.push(`${OPERATIONAL_PREFIX}${unit.name}: dossier reached its length limit; the retained text is partial.`);
    this.recordDossier(unit, `${error.partialContent.trimEnd()}\n\n${PARTIAL_COVERAGE_NOTE}`, context, "output_truncated");
    return true;
  }

  private recordFailure(unit: ResearchUnit, error: unknown, context: UnitContext): boolean {
    if (error instanceof TruncatedOutputError) return this.recordTruncation(unit, error, context);
    const status = error instanceof BudgetExceededError ? "budget_exhausted" : "error";
    const message = `${unit.name}: ${describe(error)}`;
    this.result.limitations.push(message);
    this.result.dossiers.push({ unit, reportMarkdown: `Research incomplete: ${message}`, sourceNumbers: context.numbers, status, promptMessages: context.promptMessages });
    return status !== "budget_exhausted";
  }

  private async researchUnit(unit: ResearchUnit): Promise<boolean> {
    const context: UnitContext = { numbers: [], promptMessages: [] };
    try {
      context.numbers = [...new Set(this.accept(await this.search(unit.queries)))];
      const structuredContext = unit.kind === "race" ? await this.raceContext(unit, context.numbers) : "";
      context.promptMessages = dossierMessages({ asOf: this.asOf, event: this.event, unit, structuredContext, evidence: this.evidenceFor(context.numbers, unit.name) });
      this.recordDossier(unit, await this.call(`dossier:${unit.name}`, context.promptMessages, DOSSIER_TOKENS), context, "complete");
      return true;
    } catch (error) {
      return this.recordFailure(unit, error, context);
    }
  }

  private isLastListedCandidate(unit: ResearchUnit): boolean {
    return this.candidateMode && unit === this.result.units.filter(candidate => candidate.kind === "candidate").at(-1);
  }

  private async researchUnits(): Promise<void> {
    for (let index = 0; index < this.result.units.length; index++) {
      const unit = this.result.units[index]!;
      if (!await this.researchUnit(unit)) return;
      if (this.isLastListedCandidate(unit)) await this.auditUnlistedCandidates();
    }
  }

  private candidateLeads(): Lead[] {
    return this.sources.map((source, index) => ({ source: evidenceForWriter(source, this.event), index }))
      .filter(lead => LEAD_MENTION.test((lead.source.title ?? "") + lead.source.text.slice(0, LEAD_PREFIX_CHARACTERS)))
      .slice(-MAX_LEADS);
  }

  private addAuditedUnit(value: unknown): void {
    const named = namedUnit(value);
    if (!named || !CITED_SOURCE.test(named.question)) return;
    if (this.hasUnit(named.name) || this.isRetiredRosterName(named.name)) return;
    this.result.units.push(candidateUnit(this.event, named.name, true));
  }

  private async auditUnlistedCandidates(): Promise<void> {
    try {
      const extra = this.accept(await this.search(auditQueries(this.event.title)));
      const leads = this.candidateLeads();
      const promptMessages = auditMessages(this.event, this.unitRoster(), leads);
      const plan = await this.call("unlisted_candidate_gap_audit", promptMessages, DISCOVERY_TOKENS);
      const unit: ResearchUnit = { name: "Unlisted candidate gap audit", kind: "discovery", question: "Revisit expanded evidence for missing names", queries: [] };
      const sourceNumbers = [...new Set([...extra, ...leads.map(lead => lead.index + 1)])];
      this.result.dossiers.push({ unit, reportMarkdown: plan, sourceNumbers, status: "complete", promptMessages });
      for (const lead of parseUnits(plan, "Unlisted audit missing units array").slice(0, MAX_UNLISTED)) this.addAuditedUnit(lead);
    } catch (error) {
      this.result.limitations.push(`Discovery incomplete: final unlisted audit: ${String(error)}`);
    }
  }
}

export async function decomposeMarket(options: DecompositionOptions): Promise<Decomposition> {
  return new MarketDecomposer(options).run();
}
