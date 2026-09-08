import { renderSenateEvidence } from "./senate-report.ts";
import type { ResearchRun } from "./types.ts";

type Decomposition = NonNullable<ResearchRun["decomposition"]>;

const MAX_DOSSIER_CHARACTERS = 5000;
const FULL_COVERAGE = "full coverage";
const PARTIAL_COVERAGE = "partial coverage";
const SYNTHESIS_CHARACTER_BUDGET = 47000;

const SYNTHESIS_PREAMBLE = "Use these separately researched component dossiers as fallible intermediate evidence. Keep their GLOBAL citation numbers/URLs. Do not claim gaps were verified. Full dossiers are appended by the application, so synthesize rather than duplicate every paragraph.\n";
const SYNTHESIS_GUIDANCE = "\nFor Senate control: the application renders ALL 35 race quotes, current holders, and verified seat arithmetic separately. Do not regenerate that large table or invent different counts. Explain concrete Democratic flip and Republican hold paths using that structured context below. Highlight Texas and Ohio. Explain correlated national swings, independents, and runoffs without inferring state law from market boilerplate. Do not compute target-control probabilities. For candidate selection: compare candidate-specific strengths and obstacles, distinguish actual consideration from biography, and separately discuss EVERY evidence-backed unlisted candidate and remaining discovery gaps. Do not label people high-probability, favorites, lower-tier or long-shots: organize by evidence type (direct consideration, role/access, denials, unknown). Excluded roster entries are not evidence of missing candidates. Do not infer completeness or missing probability mass from market prices.\n";

function boundedMarkdown(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const boundary = text.lastIndexOf("\n", cap);
  return boundary > 0 ? text.slice(0, boundary) : text;
}

function coverageOf(dossier: Decomposition["dossiers"][number]): string {
  return dossier.status === "complete" ? FULL_COVERAGE : PARTIAL_COVERAGE;
}

function researchedDossiers(decomposition: Decomposition) {
  return decomposition.dossiers.filter(dossier => dossier.unit.kind !== "discovery");
}

export function synthesisContext(decomposition: Decomposition): string {
  const dossiers = researchedDossiers(decomposition);
  const cap = Math.min(MAX_DOSSIER_CHARACTERS, Math.floor(SYNTHESIS_CHARACTER_BUDGET / Math.max(1, dossiers.length)));
  const condensed = dossiers.map(dossier => {
    const suffix = dossier.reportMarkdown.length > cap ? "\n[Condensed for synthesis; full dossier in appendix.]" : "";
    return `## ${dossier.unit.name} (${dossier.unit.kind}; ${coverageOf(dossier)})\n${boundedMarkdown(dossier.reportMarkdown, cap)}${suffix}`;
  }).join("\n\n");
  return SYNTHESIS_PREAMBLE + condensed + SYNTHESIS_GUIDANCE + renderSenateEvidence(decomposition.raceOdds ?? [], decomposition.senateRoster);
}

export function renderDossiers(decomposition: Decomposition): string {
  const sections = researchedDossiers(decomposition).map(dossier => {
    const lead = dossier.unit.kind === "unlisted_candidate" ? " — unlisted research lead" : "";
    return `## ${dossier.unit.name}${lead}\n\nCoverage: ${coverageOf(dossier)}\n\n${dossier.reportMarkdown}`;
  });
  return `\n\n# Component research dossiers\n\n${sections.join("\n\n")}`;
}
