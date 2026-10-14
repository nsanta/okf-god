/**
 * What triggered a usage record. `agent_read` covers native reads of agent
 * files, `doc_read` native reads of docs, and `bash_read` cataloged files
 * referenced by a bash command. Legacy sources must keep validating (session
 * replay of pre-existing events).
 */
export type UsageSource =
  | "okf_read"
  | "skill_read"
  | "agent_read"
  | "agent_spawn"
  | "doc_read"
  | "bash_read";

export interface UsageEvent {
  kind: "skill" | "doc" | "agent";
  name: string;
  path: string;
  source: UsageSource;
  ts: number;
}

const KINDS: readonly UsageEvent["kind"][] = ["skill", "doc", "agent"];
const SOURCES: readonly UsageSource[] = [
  "okf_read",
  "skill_read",
  "agent_read",
  "agent_spawn",
  "doc_read",
  "bash_read",
];

export interface UsageCounts {
  skill: number;
  doc: number;
  agent: number;
}

/** Defensive validation shared by deserialize and session reconstruction. */
export function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["kind"] === "string" &&
    (KINDS as readonly string[]).includes(candidate["kind"]) &&
    typeof candidate["name"] === "string" &&
    candidate["name"].length > 0 &&
    typeof candidate["path"] === "string" &&
    typeof candidate["source"] === "string" &&
    (SOURCES as readonly string[]).includes(candidate["source"]) &&
    typeof candidate["ts"] === "number" &&
    Number.isFinite(candidate["ts"])
  );
}

/**
 * Tracks which OKF resources the agent used this session. Events are kept
 * newest first; counts are distinct resources per kind.
 */
export class UsageRegistry {
  private eventsList: UsageEvent[] = [];

  record(event: UsageEvent): void {
    if (!isUsageEvent(event)) return;
    this.eventsList.push(event);
    this.sortNewestFirst();
  }

  /** All events, newest first. */
  events(): UsageEvent[] {
    return [...this.eventsList];
  }

  /** Distinct resources used per kind. */
  counts(): UsageCounts {
    const seen = new Set<string>();
    const counts: UsageCounts = { skill: 0, doc: 0, agent: 0 };
    for (const event of this.eventsList) {
      const key = `${event.kind}:${event.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[event.kind] += 1;
    }
    return counts;
  }

  totalEvents(): number {
    return this.eventsList.length;
  }

  serialize(): string {
    return JSON.stringify(this.eventsList);
  }

  static deserialize(json: string): UsageRegistry {
    const registry = new UsageRegistry();
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) return registry;
      for (const item of parsed) {
        if (isUsageEvent(item)) registry.eventsList.push(item);
      }
    } catch {
      // defensive: invalid payloads deserialize to an empty registry
    }
    registry.sortNewestFirst();
    return registry;
  }

  private sortNewestFirst(): void {
    this.eventsList.sort((a, b) => b.ts - a.ts);
  }
}
