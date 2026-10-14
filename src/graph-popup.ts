/**
 * Graph popup: a centered overlay rendering the ASCII link graph produced by
 * `toAsciiGraph`, scrollable, closed with esc/return/ctrl+c/q. Mirrors the
 * UsagePopupComponent house pattern (border/accent/dim theme tokens,
 * truncateToWidth/visibleWidth, invalidate/dispose semantics).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  ASCII_BROKEN_MARK,
  ASCII_EMPTY_GRAPH,
  ASCII_ISOLATED_MARKER,
  type AsciiGraphResult,
} from "./graph-ascii.ts";

/** Scrollable content rows (maxHeight 20 ⇒ top + stats + 14 + scroll + hint + bottom). */
const CONTENT_CAPACITY = 14;
const BOX_TITLE = " OKF link graph ";
const HINT = " esc close · ↑↓ scroll ";

export class GraphPopupComponent implements Component {
  private readonly result: AsciiGraphResult;
  private readonly theme: Theme;
  private readonly done: () => void;
  private scroll = 0;

  constructor(result: AsciiGraphResult, theme: Theme, done: () => void) {
    this.result = result;
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

    // Fixed stats header: total/shown nodes, link count, broken count.
    const stats = ` nodes ${this.result.shownNodes}/${this.result.totalNodes}` +
      ` · links ${this.result.stats.edges} · broken ${this.result.stats.broken} `;
    lines.push(this.padded(th.fg("dim", stats), innerW));

    const capacity = Math.max(1, Math.min(CONTENT_CAPACITY, this.result.lines.length));
    this.clampScroll(capacity);
    for (const line of this.result.lines.slice(this.scroll, this.scroll + capacity)) {
      lines.push(this.bodyLine(line, innerW));
    }
    if (this.result.lines.length > capacity) {
      const from = this.scroll + 1;
      const to = this.scroll + capacity;
      lines.push(this.padded(th.fg("dim", ` ↑/↓ ${from}-${to} of ${this.result.lines.length} `), innerW));
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

  private bodyLine(line: string, innerW: number): string {
    return this.padded(this.theme.fg(this.styleFor(line), line), innerW);
  }

  /**
   * Whole-line styling from the pure layout's exact markers — no re-parsing:
   * structural link lines and node names get accent; broken marks, the
   * isolated marker, and the empty-graph line get dim.
   */
  private styleFor(line: string): "accent" | "dim" {
    if (
      line === ASCII_EMPTY_GRAPH ||
      line === ASCII_ISOLATED_MARKER ||
      line.includes(ASCII_BROKEN_MARK)
    ) {
      return "dim";
    }
    return "accent";
  }

  /** Pad (or truncate) a styled line to the inner width so borders align. */
  private padded(line: string, innerW: number): string {
    return this.theme.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + this.theme.fg("border", "│");
  }

  private clampScroll(capacity: number): void {
    const max = Math.max(0, this.result.lines.length - capacity);
    if (this.scroll > max) this.scroll = max;
    if (this.scroll < 0) this.scroll = 0;
  }
}
