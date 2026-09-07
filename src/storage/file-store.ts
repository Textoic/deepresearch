import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchRun, RunStore } from "../types.ts";

/** Portable artifact store. Each run is self-contained and easy to archive or diff. */
export class FileRunStore implements RunStore {
  private readonly rootDirectory: string;
  constructor(rootDirectory = "runs") { this.rootDirectory = rootDirectory; }

  async save(run: ResearchRun): Promise<void> {
    const directory = join(this.rootDirectory, run.id);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "run.json"), JSON.stringify(run, null, 2), "utf8"),
      writeFile(join(directory, "report.md"), run.reportMarkdown, "utf8"),
      writeFile(join(directory, "ledger.json"), JSON.stringify(run.ledger, null, 2), "utf8"),
      writeFile(join(directory, "event.json"), JSON.stringify(run.event?.raw ?? null, null, 2), "utf8"),
      writeFile(join(directory, "retrieval.json"), JSON.stringify(run.retrieval ?? null, null, 2), "utf8"),
      writeFile(join(directory, "evidence.json"), JSON.stringify(run.sources, null, 2), "utf8"),
      writeFile(join(directory, "prompt.json"), JSON.stringify(run.promptMessages ?? [], null, 2), "utf8"),
      ...(run.arenaEvidence ? [writeFile(join(directory, "structured-evidence.json"), JSON.stringify(run.arenaEvidence, null, 2), "utf8")] : []),
      ...(run.narrativeMarkdown !== undefined ? [writeFile(join(directory, "narrative.md"), run.narrativeMarkdown, "utf8")] : []),
    ]);
  }
}
