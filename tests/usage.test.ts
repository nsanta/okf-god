import { describe, expect, it } from "vitest";
import { UsageRegistry, type UsageEvent } from "../src/usage.ts";

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

describe("UsageRegistry", () => {
  it("records events newest first", () => {
    const registry = new UsageRegistry();
    registry.record(event({ name: "first", ts: 1 }));
    registry.record(event({ name: "second", ts: 2 }));
    registry.record(event({ name: "third", ts: 3 }));
    expect(registry.events().map((entry) => entry.name)).toEqual(["third", "second", "first"]);
  });

  it("counts distinct resources per kind", () => {
    const registry = new UsageRegistry();
    registry.record(event({ kind: "skill", name: "a" }));
    registry.record(event({ kind: "skill", name: "a" })); // duplicate -> still one distinct
    registry.record(event({ kind: "skill", name: "b" }));
    registry.record(event({ kind: "doc", name: "guide" }));
    registry.record(event({ kind: "agent", name: "reviewer", source: "agent_spawn" }));
    expect(registry.counts()).toEqual({ skill: 2, doc: 1, agent: 1 });
  });

  it("round-trips through serialize/deserialize", () => {
    const registry = new UsageRegistry();
    registry.record(event({ kind: "skill", name: "a", ts: 1 }));
    registry.record(event({ kind: "agent", name: "reviewer", source: "agent_spawn", ts: 2 }));

    const restored = UsageRegistry.deserialize(registry.serialize());
    expect(restored.events()).toEqual(registry.events());
    expect(restored.counts()).toEqual(registry.counts());
  });

  it("deserializes invalid payloads defensively", () => {
    expect(UsageRegistry.deserialize("not json").events()).toEqual([]);
    expect(UsageRegistry.deserialize("[{}]").events()).toEqual([]);
    expect(UsageRegistry.deserialize("42").events()).toEqual([]);
  });
});
