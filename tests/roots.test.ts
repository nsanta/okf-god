import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultRoots } from "../src/roots.ts";

describe("defaultRoots", () => {
  it("uses pi-native skill roots (project .pi/skills, user .pi/agent/skills, Agent Skills spec dirs)", () => {
    const cwd = "/proj";
    const roots = defaultRoots(cwd);
    expect(roots.skill).toEqual([
      "/proj/.pi/skills",
      "/proj/.agents/skills",
      `${homedir()}/.pi/agent/skills`,
      `${homedir()}/.agents/skills`,
    ]);
    expect(roots.skill.some((p) => p.includes(".opencode"))).toBe(false);
  });

  it("keeps docs at <cwd>/docs and uses pi-subagents agent roots", () => {
    const cwd = "/proj";
    const roots = defaultRoots(cwd);
    expect(roots.doc).toEqual(["/proj/docs"]);
    expect(roots.agent).toEqual([
      "/proj/.pi/agents",
      `${homedir()}/.pi/agent/agents`,
      `${homedir()}/.agents`,
    ]);
  });
});
