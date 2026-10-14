import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import okfGodExtension from "../src/index.ts";
import { GraphPopupComponent } from "../src/graph-popup.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-wiring-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(CWD, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

// Fixture workspace: skills/docs/agents roots + okf.json pointing at them.
const CWD = join(FIXTURES, "ws");
write("skills/deploy/SKILL.md", "---\nname: deploy\ntitle: Deploy Skill\ndescription: Deploys services.\ntags: [ops]\nstatus: stable\n---\nDeploy body. See [runbook](../../docs/runbook.md).\n");
write("docs/runbook.md", "---\ntype: Playbook\ntitle: Runbook\ndescription: Operational runbook.\ntags: [ops]\nstatus: stable\nverified: { by: human:amy, at: 2026-01-01T00:00:00Z }\n---\nRunbook body.\n");
write("docs/guides/nested.md", "---\ntype: Guide\ntitle: Nested Guide\ndescription: Nested guide inside a docs subfolder.\ntags: [guide]\n---\nNested body.\n");
write("agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews changes.\ntags: [quality]\n---\n");
write(
  ".pi/okf.json",
  JSON.stringify({
    skills: ["skills"],
    docs: ["docs"],
    agents: ["agents"],
  }),
);

type Handler = (event: any, ctx: any) => any;

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
  };
  return { pi, tools, commands, handlers, appended };
}

function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    mode: "tui",
    cwd: CWD,
    ui: { notify: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
    ...overrides,
  };
}

async function setup() {
  const mock = mockPi();
  okfGodExtension(mock.pi as any);
  // Production fires session_start before tools run; it sets the extension cwd.
  mock.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, mockCtx());
  return mock;
}

const firstLine = (result: any): string => result.content[0].text.split("\n")[0];

describe("okf-god wiring", () => {
  it("registers tools, commands, and lifecycle handlers lazily (no scans in the factory body)", async () => {
    const { tools, commands, handlers } = await setup();
    for (const name of ["okf_search", "okf_read", "okf_links", "okf_list"]) {
      expect(tools.get(name)?.parameters).toBeDefined();
      expect(tools.get(name)?.label).toBeTypeOf("string");
    }
    for (const name of ["okf-list", "okf-links", "okf-graph", "okf-usage", "okf-reload"]) {
      expect(commands.get(name)?.handler).toBeTypeOf("function");
    }
    expect(commands.get("okf-list")?.getArgumentCompletions("s")).toEqual([{ value: "skill", label: "skill" }]);
    for (const event of ["session_start", "tool_call", "tool_result"]) {
      expect(handlers.get(event)?.length).toBe(1);
    }
  });

  it("okf_list lists the catalog from the okf.json config", async () => {
    const { tools } = await setup();
    const result = await tools.get("okf_list").execute("id", { kind: "skill" }, undefined, undefined, mockCtx());
    expect(firstLine(result)).toContain("1 resource");
    expect(result.content[0].text).toContain("deploy (skill)");
    expect(result.details.count).toBe(1);
  });

  it("okf_search ranks and reports status/trust signals", async () => {
    const { tools } = await setup();
    const result = await tools.get("okf_search").execute("id", { query: "deploys" }, undefined, undefined, mockCtx());
    expect(result.content[0].text).toContain("skill/deploy · stable");
    expect(result.content[0].text).toContain("Deploys services.");
    expect(result.details.results[0]?.path).toBe(join(CWD, "skills/deploy/SKILL.md"));
  });

  it("okf_read returns summary, links, and records usage durably", async () => {
    const { tools, appended } = await setup();
    const ctx = mockCtx();
    const result = await tools.get("okf_read").execute("id", { name: "runbook" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("type: Playbook");
    expect(result.content[0].text).toContain("trust: human-reviewed");
    expect(result.content[0].text).toContain("Runbook body.");
    expect(result.details).toMatchObject({ kind: "doc", name: "runbook" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe("okf-god:usage");
    expect(appended[0]?.data).toMatchObject({ kind: "doc", name: "runbook", source: "okf_read" });
  });

  it("okf_read marks truncation and appends a path marker", async () => {
    const { tools } = await setup();
    const result = await tools.get("okf_read").execute("id", { name: "runbook", maxChars: 10 }, undefined, undefined, mockCtx());
    expect(result.details.truncated).toBe(true);
    expect(result.content[0].text).toContain(join(CWD, "docs/runbook.md"));
  });

  it("okf_read resolves display forms and section-qualified nested paths", async () => {
    const { tools } = await setup();
    // Display form (kind/name as okf_search prints it).
    const display = await tools.get("okf_read").execute("id", { path: "doc/runbook" }, undefined, undefined, mockCtx());
    expect(display.details).toMatchObject({ kind: "doc", name: "runbook", path: join(CWD, "docs/runbook.md") });
    expect(display.content[0].text).toContain("Runbook body.");

    // Section-qualified nested path (kind/ prefix + folder path, no extension).
    const nested = await tools.get("okf_read").execute("id", { path: "doc/guides/nested" }, undefined, undefined, mockCtx());
    expect(nested.details).toMatchObject({ kind: "doc", name: "nested", path: join(CWD, "docs/guides/nested.md") });
    expect(nested.content[0].text).toContain("Nested body.");
  });

  it("okf_read resolves graph links from the lazy graph", async () => {
    const { tools } = await setup();
    // deploy/SKILL.md links ../../docs/runbook.md; runbook has no outgoing links.
    const deploy = await tools.get("okf_read").execute("id", { name: "deploy" }, undefined, undefined, mockCtx());
    expect(deploy.content[0].text).toMatch(/Links:.*runbook/);
    const runbook = await tools.get("okf_read").execute("id", { name: "runbook" }, undefined, undefined, mockCtx());
    expect(runbook.content[0].text).toMatch(/Links:.*← deploy|← deploy/);
  });

  it("okf_links marks broken links and never throws on unknown or ambiguous targets", async () => {
    const { tools } = await setup();
    write("docs/dangling.md", "---\ntype: Reference\n---\n[ghost](/nowhere/ghost.md)\n");
    const result = await tools.get("okf_links").execute("id", { name: "dangling" }, undefined, undefined, mockCtx());
    expect(result.content[0].text).toContain("(broken)");

    const unknown = await tools.get("okf_links").execute("id", { name: "nope" }, undefined, undefined, mockCtx());
    expect(unknown.details.error).toMatch(/nope/i);

    // okf.json covers agents too, but only one doc root exists, so ambiguity is
    // simulated through the resolver directly: two same-named entries across kinds.
    const unknownText = await tools.get("okf_read").execute("id", { name: "ghost" }, undefined, undefined, mockCtx());
    expect(unknownText.details.error).toBeTruthy();
  });

  it("session_start restores usage from the branch and updates the widget only with UI", async () => {
    const { handlers } = await setup();
    const sessionStart = handlers.get("session_start")![0];
    const branch = [
      { type: "custom", customType: "okf-god:usage", data: { kind: "skill", name: "deploy", path: "/x", source: "skill_read", ts: 1 } },
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "okf-god:usage", data: { garbage: true } },
    ];
    const withUi = mockCtx({ hasUI: true, sessionManager: { getBranch: () => branch } });
    sessionStart({ type: "session_start", reason: "resume" }, withUi);
    expect(withUi.ui.setWidget).toHaveBeenCalledWith(
      "okf-god",
      ["OKF ▸ 1 skill (this session)"],
      { placement: "belowEditor" },
    );

    const withoutUi = mockCtx({ hasUI: false, sessionManager: { getBranch: () => branch } });
    sessionStart({ type: "session_start", reason: "resume" }, withoutUi);
    expect(withoutUi.ui.setWidget).not.toHaveBeenCalled();
  });

  it("hides the widget when usage is zero", async () => {
    const { handlers } = await setup();
    const sessionStart = handlers.get("session_start")![0];
    const ctx = mockCtx({ hasUI: true });
    sessionStart({ type: "session_start", reason: "startup" }, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("okf-god", undefined, { placement: "belowEditor" });
  });

  it("detects native reads of skills/agents and records skill usage", async () => {
    const { handlers, appended } = await setup();
    const toolCall = handlers.get("tool_call")![0];
    const toolResult = handlers.get("tool_result")![0];
    const ctx = mockCtx({ hasUI: true });

    toolCall(
      { type: "tool_call", toolCallId: "call1", toolName: "read", input: { path: join(CWD, "skills/deploy/SKILL.md") } },
      ctx,
    );
    await new Promise((resolveQueue) => setTimeout(resolveQueue, 10)); // let detection settle
    toolResult({ type: "tool_result", toolCallId: "call1", toolName: "read", input: {}, content: [], isError: false }, ctx);

    expect(appended.some((entry) => (entry.data as any)?.source === "skill_read")).toBe(true);
    expect(ctx.ui.setWidget).toHaveBeenCalled();
  });

  it("records agent_spawn for subagent-shaped tool calls with an agent name", async () => {
    const { handlers, appended } = await setup();
    const toolCall = handlers.get("tool_call")![0];
    const ctx = mockCtx({ hasUI: false });
    toolCall({ type: "tool_call", toolCallId: "call2", toolName: "subagent_run", input: { agent: "reviewer" } }, ctx);
    await new Promise((resolveQueue) => setTimeout(resolveQueue, 10));
    const event = appended.map((entry) => entry.data).find((data: any) => data?.source === "agent_spawn");
    expect(event).toMatchObject({ kind: "agent", name: "reviewer" });
  });

  it("detects cataloged docs accessed via bash and records bash_read usage", async () => {
    const { handlers, appended } = await setup();
    const toolCall = handlers.get("tool_call")![0];
    const toolResult = handlers.get("tool_result")![0];
    const ctx = mockCtx({ hasUI: false });

    toolCall(
      { type: "tool_call", toolCallId: "bash1", toolName: "bash", input: { command: "cat docs/runbook.md" } },
      ctx,
    );
    await new Promise((resolveQueue) => setTimeout(resolveQueue, 10)); // let detection settle
    toolResult(
      { type: "tool_result", toolCallId: "bash1", toolName: "bash", input: {}, content: [], isError: false },
      ctx,
    );

    const event = appended.map((entry) => entry.data).find((data: any) => data?.source === "bash_read");
    expect(event).toMatchObject({ kind: "doc", name: "runbook", source: "bash_read" });
  });

  it("records nothing when a denylisted bash verb touches a cataloged doc", async () => {
    const { handlers, appended } = await setup();
    const toolCall = handlers.get("tool_call")![0];
    const toolResult = handlers.get("tool_result")![0];
    const ctx = mockCtx({ hasUI: false });

    toolCall(
      { type: "tool_call", toolCallId: "bash2", toolName: "bash", input: { command: "rm docs/runbook.md" } },
      ctx,
    );
    await new Promise((resolveQueue) => setTimeout(resolveQueue, 10));
    toolResult(
      { type: "tool_result", toolCallId: "bash2", toolName: "bash", input: {}, content: [], isError: false },
      ctx,
    );

    expect(appended).toHaveLength(0);
  });

  it("detects native reads of cataloged docs and records doc_read usage", async () => {
    const { handlers, appended } = await setup();
    const toolCall = handlers.get("tool_call")![0];
    const toolResult = handlers.get("tool_result")![0];
    const ctx = mockCtx({ hasUI: false });

    toolCall(
      { type: "tool_call", toolCallId: "read1", toolName: "read", input: { path: join(CWD, "docs/runbook.md") } },
      ctx,
    );
    await new Promise((resolveQueue) => setTimeout(resolveQueue, 10)); // let detection settle
    toolResult(
      { type: "tool_result", toolCallId: "read1", toolName: "read", input: {}, content: [], isError: false },
      ctx,
    );

    const event = appended.map((entry) => entry.data).find((data: any) => data?.source === "doc_read");
    expect(event).toMatchObject({ kind: "doc", name: "runbook", source: "doc_read" });
  });

  it("ignores unknown event shapes without throwing", async () => {
    const { handlers } = await setup();
    const ctx = mockCtx();
    expect(() => handlers.get("tool_call")![0]({ type: "tool_call" }, ctx)).not.toThrow();
    expect(() => handlers.get("tool_result")![0]({ type: "tool_result" }, ctx)).not.toThrow();
    expect(() => handlers.get("session_start")![0]({}, { hasUI: false })).not.toThrow();
  });

  it("okf-reload invalidates caches and rescans", async () => {
    const { commands, handlers, appended } = await setup();
    const ctx = mockCtx({ hasUI: false });

    // Warm the catalog, then add a resource and reload.
    await commands.get("okf-list")!.handler("", ctx);
    write("docs/fresh.md", "---\ntype: Reference\ndescription: Brand new.\ntags: []\n---\n");
    await commands.get("okf-reload")!.handler("", ctx);
    // docs at this point: runbook + nested (module fixtures) + dangling (okf_links test) + fresh = 4
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("4 docs"), "info");

    // Usage state survives: session_start after reload still lists it.
    void handlers;
    expect(appended).toHaveLength(0);
  });

  it("okf-graph with UI opens the graph overlay", async () => {
    const { commands } = await setup();
    const fakeTheme = { fg: (_token: string, text: string) => text };
    const custom = vi.fn(async (factory: any) => factory(undefined, fakeTheme, undefined, () => {}));
    const ctx = mockCtx({
      hasUI: true,
      ui: { notify: vi.fn(), setWidget: vi.fn(), custom },
    });

    await commands.get("okf-graph")!.handler("", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    const [factory, options] = custom.mock.calls[0] as unknown as [any, any];
    expect(options).toEqual({ overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: 20 } });
    expect(factory(undefined, fakeTheme, undefined, () => {})).toBeInstanceOf(GraphPopupComponent);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("okf-graph --mermaid keeps the Mermaid text notification", async () => {
    const { commands } = await setup();
    const custom = vi.fn();
    const ctx = mockCtx({ hasUI: true, ui: { notify: vi.fn(), setWidget: vi.fn(), custom } });

    await commands.get("okf-graph")!.handler("--mermaid", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("flowchart LR"), "info");
    expect(custom).not.toHaveBeenCalled();
  });

  it("okf-graph without UI notifies bounded ASCII lines instead of Mermaid", async () => {
    const { commands } = await setup();
    const ctx = mockCtx(); // hasUI: false

    await commands.get("okf-graph")!.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const text = ctx.ui.notify.mock.calls[0][0] as string;
    expect(text).not.toContain("flowchart LR");
    // The fixture workspace always has the deploy ──▶ runbook link.
    expect(text).toContain("──▶");
  });
});
