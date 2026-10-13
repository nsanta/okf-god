import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildUsageRows, UsagePopupComponent, type UsageRow } from "../src/usage-popup.ts";
import type { UsageEvent } from "../src/usage.ts";

function event(partial: Partial<UsageEvent>): UsageEvent {
  return {
    kind: "skill",
    name: "some-skill",
    path: "/tmp/skills/some-skill/SKILL.md",
    source: "okf_read",
    ts: 1700000000000,
    ...partial,
  };
}

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    kind: "skill",
    name: "some-skill",
    title: "Some Skill",
    relativePath: "skills/some-skill/SKILL.md",
    source: "okf_read",
    ts: 1700000000000,
    ...partial,
  };
}

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

describe("buildUsageRows", () => {
  it("dedupes by kind:name keeping the most recent event regardless of input order", () => {
    const rows = buildUsageRows(
      [
        event({ name: "a", path: "/p/old.md", ts: 1 }),
        event({ kind: "doc", name: "b", path: "/p/b.md", ts: 2 }),
        event({ name: "a", path: "/p/new.md", ts: 9 }),
      ],
      { cwd: "/p" },
    );
    expect(rows.map((entry) => entry.relativePath)).toEqual(["new.md", "b.md"]);
    expect(rows).toHaveLength(2);
  });

  it("sorts newest first with kind then name as the stable tiebreak", () => {
    const rows = buildUsageRows(
      [
        event({ kind: "skill", name: "z", ts: 5 }),
        event({ kind: "skill", name: "a", ts: 5 }),
        event({ kind: "doc", name: "m", ts: 5 }),
        event({ kind: "agent", name: "x", ts: 6 }),
      ],
      { cwd: "/p" },
    );
    expect(rows.map((entry) => `${entry.kind}/${entry.name}`)).toEqual([
      "agent/x",
      "doc/m",
      "skill/a",
      "skill/z",
    ]);
  });

  it("uses the title resolver and falls back to the event name", () => {
    const events = [event({ name: "with-title", ts: 2 }), event({ name: "no-title", ts: 1 })];
    const resolved = buildUsageRows(events, {
      cwd: "/p",
      titleFor: (entry) => (entry.name === "with-title" ? "With Title" : undefined),
    });
    expect(resolved.map((entry) => entry.title)).toEqual(["With Title", "no-title"]);
    const unresolved = buildUsageRows(events, { cwd: "/p" });
    expect(unresolved.map((entry) => entry.title)).toEqual(["with-title", "no-title"]);
  });

  it("derives relative paths: inside cwd, cwd itself, and outside cwd", () => {
    const rows = buildUsageRows(
      [
        event({ name: "in", path: "/p/skills/in/SKILL.md", ts: 3 }),
        event({ name: "self", path: "/p", ts: 2 }),
        event({ name: "out", path: "/elsewhere/doc.md", ts: 1 }),
      ],
      { cwd: "/p" },
    );
    expect(rows.map((entry) => entry.relativePath)).toEqual([
      "skills/in/SKILL.md",
      ".",
      "/elsewhere/doc.md",
    ]);
  });
});

describe("UsagePopupComponent", () => {
  it("renders the box title and one line per row with title and relative path", () => {
    const component = new UsagePopupComponent(
      [row({ title: "Graph Walk", relativePath: "docs/graph.md" })],
      theme,
      () => {},
    );
    const out = component.render(72).join("\n");
    expect(out).toContain("OKF usage (this session)");
    expect(out).toContain("Graph Walk");
    expect(out).toContain("docs/graph.md");
  });

  it("invokes done exactly once on escape", () => {
    let calls = 0;
    const component = new UsagePopupComponent([row()], theme, () => {
      calls += 1;
    });
    component.handleInput("\x1b");
    expect(calls).toBe(1);
  });

  it("closes on enter and q too", () => {
    for (const key of ["\r", "q"]) {
      let calls = 0;
      const component = new UsagePopupComponent([row()], theme, () => {
        calls += 1;
      });
      component.handleInput(key);
      expect(calls).toBe(1);
    }
  });

  it("scrolls with j/k and shows the range indicator when rows overflow", () => {
    const rows = Array.from({ length: 17 }, (_, index) =>
      row({ name: `s${index}`, title: `Skill ${index}` }),
    );
    const component = new UsagePopupComponent(rows, theme, () => {});
    expect(component.render(72).join("\n")).toContain(" ↑/↓ 1-15 of 17 ");
    component.handleInput("j");
    expect(component.render(72).join("\n")).toContain(" ↑/↓ 2-16 of 17 ");
    component.handleInput("k");
    expect(component.render(72).join("\n")).toContain(" ↑/↓ 1-15 of 17 ");
  });
});
