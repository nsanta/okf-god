/**
 * Parser for pi `--mode json` stdout event streams (pi 1.2.0).
 *
 * Event shape verified against the installed package docs:
 * - node_modules/@earendil-works/pi-coding-agent/docs/json.md
 *   - Strict JSONL framing: one JSON object per LF-terminated record; an
 *     optional preceding CR is stripped; Unicode line/paragraph separators
 *     inside strings are NOT record boundaries.
 *   - The first record is the `session` header; `message_end` carries the
 *     authoritative final `message`.
 *   - `message_update` is delta-only and carries a top-level cumulative
 *     `usage` for the CURRENT assistant response; it must never be summed
 *     (it would double-count the completed `message_end` usage).
 * - node_modules/@earendil-works/pi-coding-agent/docs/message-types.md
 *   - AssistantMessage: role "assistant"; content blocks TextContent
 *     {type:"text", text}, ThinkingContent, ToolCall; usage
 *     {input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?,
 *     totalTokens, cost{...}} ("reasoning" is already included in output);
 *     stopReason "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|
 *     "deferred".
 *   - One assistant message is emitted per tool round, so per-run usage is
 *     the sum across ALL assistant-role `message_end` messages; the final
 *     answer text comes from the LAST assistant message.
 *
 * Defensive by contract: unknown event types, non-object lines, malformed or
 * truncated JSON lines, missing usage fields (treated as 0), and empty stdout
 * are all tolerated.
 */

export interface PiRunStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Completed assistant turns observed (`turn_end` events). */
  rounds: number;
  /** Concatenated text blocks of the LAST assistant message. */
  finalText: string;
  /** stopReason of the last completed assistant message, null if none. */
  stopReason: string | null;
  /** Completed assistant messages (`message_end` with role "assistant"). */
  modelCalls: number;
}

export function emptyStats(): PiRunStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    rounds: 0,
    finalText: "",
    stopReason: null,
    modelCalls: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an optional usage field to a non-negative integer; missing -> 0. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Concatenated text of all text blocks in an assistant content array. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.join("\n");
}

/**
 * Parse a complete `--mode json` stdout capture into per-run stats.
 * Only `message_end` assistant messages contribute usage (authoritative
 * completed messages); `message_update` cumulative usage is ignored.
 */
export function parseEventStream(stdout: string): PiRunStats {
  const stats = emptyStats();
  let lastFinalText: string | null = null;
  let lastStopReason: string | null = null;

  // Strict LF framing per docs/json.md; strip an optional preceding CR.
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // Malformed or truncated line: ignore.
    }
    if (!isObject(event)) continue;

    const type = event["type"];
    if (type === "turn_end") {
      stats.rounds += 1;
      continue;
    }
    if (type !== "message_end") continue; // Unknown/other event types tolerated.

    const message = event["message"];
    if (!isObject(message) || message["role"] !== "assistant") continue;

    stats.modelCalls += 1;

    const usage = isObject(message["usage"]) ? message["usage"] : {};
    const input = tokenCount(usage["input"]);
    const output = tokenCount(usage["output"]);
    const cacheRead = tokenCount(usage["cacheRead"]);
    const cacheWrite = tokenCount(usage["cacheWrite"]);
    const reportedTotal = usage["totalTokens"];
    const total =
      typeof reportedTotal === "number" && Number.isFinite(reportedTotal) && reportedTotal > 0
        ? Math.floor(reportedTotal)
        : input + output + cacheRead + cacheWrite;

    stats.inputTokens += input;
    stats.outputTokens += output;
    stats.cacheReadTokens += cacheRead;
    stats.cacheWriteTokens += cacheWrite;
    stats.totalTokens += total;

    lastFinalText = textOfContent(message["content"]);
    lastStopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : null;
  }

  stats.finalText = lastFinalText ?? "";
  stats.stopReason = lastStopReason;
  return stats;
}
