import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ActivityJournal } from "./ActivityJournal.js";

describe("ActivityJournal", () => {
  it("projects started and terminal events without caller arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-"));
    const path = join(root, "activity.jsonl");
    const journal = new ActivityJournal(path);
    const startedAt = "2026-10-14T00:00:00.000Z";
    const finishedAt = "2026-10-14T00:00:01.250Z";

    const id = journal.start("binary_overview", startedAt);
    journal.finish({
      activityId: id,
      status: "completed",
      startedAt,
      at: finishedAt,
    });

    await expect(journal.read()).resolves.toEqual([
      {
        activity_id: id,
        tool: "binary_overview",
        status: "completed",
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: 1250,
      },
    ]);
    await expect(readFile(path, "utf8")).resolves.not.toContain("target/path");
  });

  it("keeps an unfinished operation explicitly running", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-activity-"));
    const journal = new ActivityJournal(join(root, "activity.jsonl"));

    journal.start("analyze_javascript_application", "2026-10-14T00:00:00.000Z");

    await expect(journal.read()).resolves.toMatchObject([
      { tool: "analyze_javascript_application", status: "running" },
    ]);
  });
});
