import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixture, type FixtureSpec } from "../lib/fixtures.ts";
import {
  ANSWER_INSTRUCTION,
  buildTasks,
  FACT_QA_PROMPT_TEMPLATE,
  MULTI_HOP_PROMPT_TEMPLATE,
  WORKSPACE_INSTRUCTION,
} from "../lib/tasks.ts";

const ROOT = mkdtempSync(join(tmpdir(), "okf-bench-tasks-"));
let counter = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function specFor(seed: number): FixtureSpec {
  return generateFixture({ size: "S", seed, dir: join(ROOT, `gen-${counter++}`) });
}

describe("buildTasks", () => {
  it("selects k tasks per suite deterministically", () => {
    const spec = specFor(42);
    const a = buildTasks(spec, { kPerSuite: 4 });
    const b = buildTasks(spec, { kPerSuite: 4 });
    expect(a.factQa).toHaveLength(4);
    expect(a.multiHop).toHaveLength(4);
    expect(a).toEqual(b);
    for (const task of [...a.factQa, ...a.multiHop]) {
      expect(task.suite === "fact-qa" || task.suite === "multi-hop").toBe(true);
      expect(task.prompt).toContain("ANSWER: <value>");
      expect(task.gold.length).toBeGreaterThan(0);
    }
  });

  it("caps at the available pool and keeps ids unique", () => {
    const spec = specFor(42);
    const huge = buildTasks(spec, { kPerSuite: 10_000 });
    expect(huge.factQa.length).toBeLessThanOrEqual(spec.concepts.length * 2);
    expect(huge.multiHop.length).toBe(spec.chains.length);
    const ids = [...huge.factQa, ...huge.multiHop].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fact-qa golds are unique among selected tasks", () => {
    const spec = specFor(42);
    const { factQa } = buildTasks(spec, { kPerSuite: 8 });
    const golds = factQa.map((t) => t.gold.trim().toLowerCase());
    expect(new Set(golds).size).toBe(golds.length);
  });

  it("multi-hop prompts name only concept A and never B or C", () => {
    const spec = specFor(42);
    const { multiHop } = buildTasks(spec, { kPerSuite: 4 });
    expect(multiHop).toHaveLength(4);
    for (const task of multiHop) {
      const chain = spec.chains.find((c) => task.id === `multi-hop-${c.id}`)!;
      expect(task.prompt).toContain(chain.aTitle);
      expect(task.prompt).not.toContain(chain.bTitle);
      expect(task.prompt).not.toContain(chain.cTitle);
      expect(task.gold).toBe(chain.value);
      // The asked (metric, entity) is exactly the chain gold's question space.
      expect(task.prompt).toContain(`What is the ${chain.metric} of ${chain.entity}?`);
    }
  });

  it("fact-qa tasks never use chain facts (single hop only)", () => {
    const spec = specFor(42);
    const { factQa } = buildTasks(spec, { kPerSuite: 8 });
    const chainKeys = new Set(
      spec.facts.filter((f) => f.kind === "chain").map((f) => `${f.metric}|${f.entity}`),
    );
    for (const task of factQa) {
      const fact = spec.facts.find((f) => task.id === `fact-qa-${f.conceptSlug}-${f.metric}`)!;
      expect(fact.kind).toBe("base");
      expect(chainKeys.has(`${fact.metric}|${fact.entity}`)).toBe(false);
      expect(task.prompt).toContain(`The ${fact.metric} of ${fact.entity}?`);
    }
  });

  it("shares identical base instructions across both suite templates", () => {
    expect(FACT_QA_PROMPT_TEMPLATE).toContain(WORKSPACE_INSTRUCTION);
    expect(FACT_QA_PROMPT_TEMPLATE).toContain(ANSWER_INSTRUCTION);
    expect(MULTI_HOP_PROMPT_TEMPLATE).toContain(WORKSPACE_INSTRUCTION);
    expect(MULTI_HOP_PROMPT_TEMPLATE).toContain(ANSWER_INSTRUCTION);
    expect(FACT_QA_PROMPT_TEMPLATE.startsWith(WORKSPACE_INSTRUCTION)).toBe(true);
    expect(MULTI_HOP_PROMPT_TEMPLATE.startsWith(WORKSPACE_INSTRUCTION)).toBe(true);
    expect(FACT_QA_PROMPT_TEMPLATE.endsWith(ANSWER_INSTRUCTION)).toBe(true);
    expect(MULTI_HOP_PROMPT_TEMPLATE.endsWith(ANSWER_INSTRUCTION)).toBe(true);
  });

  it("selection depends on the fixture seed", () => {
    const a = buildTasks(specFor(1), { kPerSuite: 4 });
    const b = buildTasks(specFor(2), { kPerSuite: 4 });
    const idsA = a.factQa.map((t) => t.id).join(",");
    const idsB = b.factQa.map((t) => t.id).join(",");
    expect(idsA).not.toBe(idsB);
  });
});
