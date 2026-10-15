import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ActivityRecord {
  readonly activity_id: string;
  readonly tool: string;
  readonly status: ActivityStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
  readonly evidence_id?: string;
}

interface ActivityCompletion {
  readonly activityId: string;
  readonly status: Exclude<ActivityStatus, "running">;
  readonly startedAt: string;
  readonly at?: string;
  readonly evidenceId?: string;
}

type ActivityEvent =
  | {
      readonly kind: "started";
      readonly activity_id: string;
      readonly tool: string;
      readonly at: string;
    }
  | {
      readonly kind: "finished";
      readonly activity_id: string;
      readonly status: Exclude<ActivityStatus, "running">;
      readonly at: string;
      readonly duration_ms: number;
      readonly evidence_id?: string;
    };

const MAX_EVENTS = 200;
const MAX_BYTES = 1024 * 1024;

export const activityLogPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configured = environment.REA_ACTIVITY_LOG_PATH;
  if (configured !== undefined && configured.length > 0) return configured;
  const base =
    process.platform === "win32"
      ? (environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  return join(base, "rea", "activity.jsonl");
};

const parseEvents = (text: string): ActivityEvent[] =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== "object" ||
          value === null ||
          typeof Reflect.get(value, "kind") !== "string" ||
          typeof Reflect.get(value, "activity_id") !== "string"
        )
          return [];
        return [value as ActivityEvent];
      } catch {
        return [];
      }
    });

const projectRecords = (events: readonly ActivityEvent[]): ActivityRecord[] => {
  const records = new Map<string, ActivityRecord>();
  for (const event of events) {
    if (event.kind === "started") {
      records.set(event.activity_id, {
        activity_id: event.activity_id,
        tool: event.tool,
        status: "running",
        started_at: event.at,
      });
      continue;
    }
    const current = records.get(event.activity_id);
    if (current === undefined) continue;
    records.set(event.activity_id, {
      ...current,
      status: event.status,
      finished_at: event.at,
      duration_ms: event.duration_ms,
      ...(event.evidence_id === undefined
        ? {}
        : { evidence_id: event.evidence_id }),
    });
  }
  return [...records.values()].sort((left, right) =>
    right.started_at.localeCompare(left.started_at),
  );
};

/** Best-effort, bounded local activity journal; activity must not affect tool truth. */
export class ActivityJournal {
  #write: Promise<void> = Promise.resolve();
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  path(): string {
    return this.#path;
  }

  start(tool: string, at = new Date().toISOString()): string {
    const activityId = randomUUID();
    void this.#append({
      kind: "started",
      activity_id: activityId,
      tool,
      at,
    });
    return activityId;
  }

  finish({
    activityId,
    status,
    startedAt,
    at = new Date().toISOString(),
    evidenceId,
  }: ActivityCompletion): void {
    const duration = Math.max(
      0,
      new Date(at).getTime() - new Date(startedAt).getTime(),
    );
    void this.#append({
      kind: "finished",
      activity_id: activityId,
      status,
      at,
      duration_ms: duration,
      ...(evidenceId === undefined ? {} : { evidence_id: evidenceId }),
    });
  }

  async read(limit = MAX_EVENTS): Promise<ActivityRecord[]> {
    await this.#write;
    try {
      const text = await readFile(this.#path, "utf8");
      return projectRecords(parseEvents(text)).slice(0, limit);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  async #append(event: ActivityEvent): Promise<void> {
    this.#write = this.#write
      .then(async () => {
        try {
          await mkdir(dirname(this.#path), { recursive: true });
          await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
          const current = await stat(this.#path);
          if (current.size <= MAX_BYTES) return;
          const text = await readFile(this.#path, "utf8");
          const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
          await writeFile(
            this.#path,
            `${lines.slice(-MAX_EVENTS * 2).join("\n")}\n`,
            "utf8",
          );
        } catch {
          // Observability is deliberately best-effort and cannot change analysis truth.
        }
      })
      .catch(() => undefined);
    await this.#write;
  }
}

export const createActivityJournal = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ActivityJournal => new ActivityJournal(activityLogPath(environment));
