/**
 * Usage popup: a centered overlay listing the OKF resources (skills, docs,
 * agents) used this session, one row per distinct resource, newest first.
 */
import { relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { UsageEvent } from "./usage.ts";

export interface UsageRow {
  kind: UsageEvent["kind"];
  name: string;
  title: string;
  relativePath: string;
  source: UsageEvent["source"];
  ts: number;
}

export interface BuildUsageRowsOptions {
  cwd: string;
  titleFor?: (event: UsageEvent) => string | undefined;
}

/** Content rows before scrolling kicks in (maxHeight 20 ⇒ ~15 rows). */
const CONTENT_CAPACITY = 15;
const KIND_TAG_WIDTH = 5;
const BOX_TITLE = " OKF usage (this session) ";
const HINT = " esc close · ↑↓ scroll ";

/** Dedupe by `kind:name` (most recent wins), sort newest first, map to rows. */
export function buildUsageRows(events: UsageEvent[], opts: BuildUsageRowsOptions): UsageRow[] {
  const byKey = new Map<string, UsageEvent>();
  for (const event of events) {
    const key = `${event.kind}:${event.name}`;
    const current = byKey.get(key);
    if (!current || event.ts > current.ts) byKey.set(key, event);
  }
  return [...byKey.values()].sort(compareNewestFirst).map((event) => ({
    kind: event.kind,
    name: event.name,
    title: opts.titleFor?.(event) || event.name,
    relativePath: toDisplayPath(opts.cwd, event.path),
    source: event.source,
    ts: event.ts,
  }));
}

function compareNewestFirst(a: UsageEvent, b: UsageEvent): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

/** Relative to cwd; "." for cwd itself; absolute when it lives outside cwd. */
function toDisplayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === "") return ".";
  if (rel.startsWith("..")) return path;
  return rel;
}

export class UsagePopupComponent implements Component {
  private readonly rows: UsageRow[];
  private readonly theme: Theme;
  private readonly done: () => void;
  private scroll = 0;

  constructor(rows: UsageRow[], theme: Theme, done: () => void) {
    this.rows = rows;
    this.theme = theme;
    this.done = done;
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // Top border with centered title, same style as the overlay examples.
    const titleStr = truncateToWidth(BOX_TITLE, innerW);
    const titleW = visibleWidth(titleStr);
    const left = "─".repeat(Math.floor((innerW - titleW) / 2));
    const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
    lines.push(th.fg("border", `╭${left}`) + th.fg("accent", titleStr) + th.fg("border", `${right}╮`));

    const capacity = Math.max(1, Math.min(CONTENT_CAPACITY, this.rows.length));
    this.clampScroll(capacity);
    for (const row of this.rows.slice(this.scroll, this.scroll + capacity)) {
      lines.push(this.rowLine(row, innerW));
    }
    if (this.rows.length > capacity) {
      const from = this.scroll + 1;
      const to = this.scroll + capacity;
      lines.push(this.padded(th.fg("dim", ` ↑/↓ ${from}-${to} of ${this.rows.length} `), innerW));
    }
    lines.push(this.padded(th.fg("dim", HINT), innerW));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "return") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    ) {
      this.done();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.clampScroll(CONTENT_CAPACITY);
      this.scroll = Math.max(0, this.scroll - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.clampScroll(CONTENT_CAPACITY);
      this.scroll += 1;
    }
  }

  invalidate(): void {}

  dispose(): void {}

  private rowLine(row: UsageRow, innerW: number): string {
    const tag = row.kind.slice(0, KIND_TAG_WIDTH).padEnd(KIND_TAG_WIDTH);
    const line = ` ${tag}${this.theme.fg("accent", row.title)} · ${this.theme.fg("dim", row.relativePath)}`;
    const body = truncateToWidth(line, innerW, "...", true);
    return this.theme.fg("border", "│") + body + this.theme.fg("border", "│");
  }

  /** Pad (or truncate) a styled line to the inner width so borders align. */
  private padded(line: string, innerW: number): string {
    return this.theme.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + this.theme.fg("border", "│");
  }

  private clampScroll(capacity: number): void {
    const max = Math.max(0, this.rows.length - capacity);
    if (this.scroll > max) this.scroll = max;
    if (this.scroll < 0) this.scroll = 0;
  }
}
