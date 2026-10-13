/**
 * Deterministic benchmark task suites built from a fixture ground truth.
 *
 * - fact-qa: single-concept questions over base facts only (never chain facts,
 *   which would require multi-hop retrieval).
 * - multi-hop: questions that name ONLY the chain's A concept (by title) and
 *   ask for the value recorded along its documented reference chain; the gold
 *   answer is C's value. B and C are never named in the prompt.
 *
 * Both suites share the same base instructions via the exported constants, so
 * both benchmark arms see byte-identical prompt scaffolding.
 */
import type { ChainSpec, FactSpec, FixtureSpec } from "./fixtures.ts";
import { createRng } from "./rng.ts";

export type Suite = "fact-qa" | "multi-hop";

export interface TaskSpec {
  id: string;
  suite: Suite;
  prompt: string;
  gold: string;
}

/** Shared opening instruction (identical for both suites, both arms). */
export const WORKSPACE_INSTRUCTION =
  "Using the documentation in this workspace, answer the question.";

/** Shared closing instruction (identical for both suites, both arms). */
export const ANSWER_INSTRUCTION =
  "End your reply with a final line exactly of the form: ANSWER: <value>";

export const FACT_QA_PROMPT_TEMPLATE = `${WORKSPACE_INSTRUCTION} Question: {question} ${ANSWER_INSTRUCTION}`;

export const MULTI_HOP_PROMPT_TEMPLATE = `${WORKSPACE_INSTRUCTION} Question: {question} Follow the documented reference links from the named concept. ${ANSWER_INSTRUCTION}`;

function render(template: string, question: string): string {
  return template.replace("{question}", question);
}

export function factQaQuestion(fact: FactSpec): string {
  return `The ${fact.metric} of ${fact.entity}?`;
}

export function multiHopQuestion(chain: ChainSpec): string {
  return `Start from the concept titled "${chain.aTitle}" and follow its reference links to wherever the authoritative value is recorded. What is the ${chain.metric} of ${chain.entity}?`;
}

/**
 * Build up to `opts.kPerSuite` tasks per suite. Selection is deterministic
 * (seeded by the fixture seed) and skips duplicate question keys and duplicate
 * gold values when the pool allows, so each selected task has a unique,
 * unambiguous answer. k is capped at the available pool size.
 */
export function buildTasks(
  spec: FixtureSpec,
  opts: { kPerSuite: number },
): { factQa: TaskSpec[]; multiHop: TaskSpec[] } {
  const k = Math.max(0, Math.floor(opts.kPerSuite));

  const factRng = createRng(spec.seed ^ 0x9e3779b9);
  const factOrder = factRng.shuffle(spec.facts.filter((fact) => fact.kind === "base"));
  const factQa: TaskSpec[] = [];
  const seenQuestionKeys = new Set<string>();
  const seenGolds = new Set<string>();
  for (const fact of factOrder) {
    if (factQa.length >= k) break;
    const questionKey = `${fact.metric}|${fact.entity}`;
    const goldKey = fact.value.trim().toLowerCase();
    if (seenQuestionKeys.has(questionKey) || seenGolds.has(goldKey)) continue;
    seenQuestionKeys.add(questionKey);
    seenGolds.add(goldKey);
    factQa.push({
      id: `fact-qa-${fact.conceptSlug}-${fact.metric}`,
      suite: "fact-qa",
      prompt: render(FACT_QA_PROMPT_TEMPLATE, factQaQuestion(fact)),
      gold: fact.value,
    });
  }

  const chainRng = createRng(spec.seed ^ 0x85ebca6b);
  const chainOrder = chainRng.shuffle(spec.chains);
  const multiHop = chainOrder.slice(0, Math.min(k, chainOrder.length)).map((chain) => ({
    id: `multi-hop-${chain.id}`,
    suite: "multi-hop" as const,
    prompt: render(MULTI_HOP_PROMPT_TEMPLATE, multiHopQuestion(chain)),
    gold: chain.value,
  }));

  return { factQa, multiHop };
}
