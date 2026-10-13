import { describe, expect, it } from "vitest";
import { emptyStats, parseEventStream, type PiRunStats } from "../lib/usage.ts";

/**
 * Test streams mirror the verified `--mode json` contract:
 * - docs/json.md: session header first; message_end carries the authoritative
 *   final message; message_update is delta-only with cumulative top-level
 *   usage (never summed); strict LF JSONL framing with optional CR.
 * - docs/message-types.md: AssistantMessage usage/stopReason/content blocks.
 */
function assistantMessage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Final answer." }],
    api: "openai-completions",
    provider: "zai",
    model: "glm",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: {} },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function multiRoundStream(): string {
  const assistant1 = assistantMessage({
    content: [
      { type: "text", text: "Let me check the docs." },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "docs/a.md" } },
    ],
    usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, totalTokens: 117, cost: {} },
    stopReason: "toolUse",
  });
  const assistant2 = assistantMessage({
    content: [
      { type: "thinking", thinking: "found it" },
      { type: "text", text: "The throughput is 42 ms." },
      { type: "text", text: "ANSWER: 42 ms" },
    ],
    usage: { input: 40, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: {} },
    stopReason: "stop",
  });
  return [
    line({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/f" }),
    line({ type: "agent_start" }),
    line({ type: "turn_start" }),
    line({ type: "message_start", message: { role: "user", content: "q", timestamp: 0 } }),
    line({ type: "message_end", message: { role: "user", content: "q", timestamp: 0 } }),
    line({ type: "message_start", message: { ...assistant1, stopReason: "pending" } }),
    // Cumulative top-level usage on message_update must NOT be summed.
    line({
      type: "message_update",
      usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, totalTokens: 117, cost: {} },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Let" },
    }),
    line({ type: "message_end", message: assistant1 }),
    line({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: {} }),
    line({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: {},
      isError: false,
      durationMs: 3,
    }),
    line({ type: "turn_end", message: assistant1, toolResults: [] }),
    line({ type: "turn_start" }),
    line({ type: "message_end", message: assistant2 }),
    line({ type: "turn_end", message: assistant2, toolResults: [] }),
    line({ type: "agent_end", messages: [assistant2], willRetry: false }),
    line({ type: "agent_settled", aborted: false }),
  ].join("");
}

describe("parseEventStream", () => {
  it("sums usage across all assistant messages and keeps the last text", () => {
    const stats = parseEventStream(multiRoundStream());
    expect(stats.inputTokens).toBe(140);
    expect(stats.outputTokens).toBe(40);
    expect(stats.cacheReadTokens).toBe(5);
    expect(stats.cacheWriteTokens).toBe(2);
    expect(stats.totalTokens).toBe(187);
    expect(stats.modelCalls).toBe(2);
    expect(stats.rounds).toBe(2);
    expect(stats.stopReason).toBe("stop");
  });

  it("finalText is the concatenated text blocks of the LAST assistant message only", () => {
    const stats = parseEventStream(multiRoundStream());
    expect(stats.finalText).toBe("The throughput is 42 ms.\nANSWER: 42 ms");
  });

  it("tolerates missing usage fields and missing usage objects as zeros", () => {
    const stream = [
      line({
        type: "message_end",
        message: assistantMessage({
          usage: { input: 5, totalTokens: 5 },
          stopReason: "stop",
        }),
      }),
      line({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }),
    ].join("");
    const stats = parseEventStream(stream);
    expect(stats.inputTokens).toBe(5);
    expect(stats.outputTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.cacheWriteTokens).toBe(0);
    expect(stats.totalTokens).toBe(5); // 5 reported + 0 recomputed for the second message
    expect(stats.modelCalls).toBe(2);
    expect(stats.finalText).toBe("");
  });

  it("recomputes totalTokens when a message omits it", () => {
    const stream = line({
      type: "message_end",
      message: assistantMessage({
        usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
      }),
    });
    expect(parseEventStream(stream).totalTokens).toBe(18);
  });

  it("ignores malformed lines, non-object records, and unknown event types", () => {
    const stream = [
      "this is not json\n",
      "[]\n",
      line({ type: "some_future_event", payload: { nested: true } }),
      line({ type: "message_end", message: assistantMessage({}) }),
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\"\n", // truncated JSON
    ].join("");
    const stats = parseEventStream(stream);
    expect(stats.modelCalls).toBe(1);
    expect(stats.inputTokens).toBe(10);
    expect(stats.rounds).toBe(0);
  });

  it("ignores a truncated final line without trailing newline", () => {
    const good = line({ type: "message_end", message: assistantMessage({}) });
    const truncated = `{"type":"message_end","message":{"role":"assistant","usage":{"input":99`;
    const stats = parseEventStream(good + truncated);
    expect(stats.modelCalls).toBe(1);
    expect(stats.inputTokens).toBe(10);
  });

  it("strips optional CR before LF per the framing contract", () => {
    const stream = `${JSON.stringify({
      type: "message_end",
      message: assistantMessage({ content: [{ type: "text", text: "hi" }] }),
    })}\r\n`;
    const stats = parseEventStream(stream);
    expect(stats.modelCalls).toBe(1);
    expect(stats.finalText).toBe("hi");
  });

  it("returns all zeros for empty, whitespace-only, or garbage stdout", () => {
    const expected: PiRunStats = emptyStats();
    for (const input of ["", "\n\n", "garbage\n\n{" ]) {
      expect(parseEventStream(input)).toEqual(expected);
    }
  });

  it("does not count user or toolResult message_end events as model calls", () => {
    const stream = [
      line({ type: "message_end", message: { role: "user", content: "q", timestamp: 0 } }),
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
          timestamp: 1,
        },
      }),
      line({ type: "message_end", message: assistantMessage({}) }),
    ].join("");
    const stats = parseEventStream(stream);
    expect(stats.modelCalls).toBe(1);
    expect(stats.rounds).toBe(0);
    expect(stats.stopReason).toBe("stop");
  });
});
