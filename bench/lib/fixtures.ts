/**
 * Deterministic synthetic OKF v0.2 bundle generator for the benchmark.
 *
 * Same (size, seed) => byte-identical tree. No Date.now()/Math.random(): the
 * PRNG is used only to shuffle the slug pool once; every other structural
 * choice (statuses, tags, metrics, values, chain membership, link placement)
 * is index arithmetic over the shuffled order, so the output is fully
 * reproducible and auditable.
 *
 * Ground truth returned in FixtureSpec drives task building (tasks.ts) and
 * grading:
 * - every concept carries 2 "base" facts `The {metric} of {entity} is {value}.`
 *   in its `# Facts` body section; (metric, entity) keys are globally unique,
 *   so every fact-qa question has exactly one correct value in the fixture;
 * - chains carry one extra "chain" fact placed in C but phrased over A's
 *   entity, so it is reachable only by following A -> B -> C links;
 * - non-chain concepts reuse the same metric names with different values
 *   (near-miss distractors) and a few links are deliberately broken.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRng } from "./rng.ts";

export type FixtureSize = "S" | "M" | "L";

/** Concept counts per size (feature decision: S=30 default, M=120, L=500). */
export const SIZE_CONCEPTS: Record<FixtureSize, number> = { S: 30, M: 120, L: 500 };

const TAGS = ["networking", "storage", "runtime", "tooling", "observability", "syntax"] as const;
const METRICS = ["throughput", "latency", "quota", "capacity", "retries", "timeout"] as const;
const TOPICS = [
  "operations",
  "configuration",
  "troubleshooting",
  "performance",
  "security",
  "planning",
] as const;
/** Short controlled values (numbers/units/identifiers) for exact-match golds. */
const VALUES = [
  "42 ms",
  "128 ms",
  "512 GiB",
  "64 GiB",
  "v3.7",
  "v9.2",
  "8080",
  "3000",
  "99.9%",
  "97.2%",
  "7 retries",
  "12 retries",
  "30 s",
  "90 s",
  "16 shards",
  "64 shards",
] as const;

const PREFIXES = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray",
] as const;
const SUFFIXES = [
  "anchor", "basin", "beacon", "bridge", "canyon", "cavern", "cipher", "compass",
  "cove", "crest", "dock", "dune", "fjord", "forge", "garden", "gate",
  "harbor", "island", "junction", "lagoon", "meadow", "mill", "ridge", "spring",
] as const;

/** One controlled fact. `conceptSlug` is the file the sentence lives in; for
 * chain facts the `entity` belongs to the chain's A concept, not that file. */
export interface FactSpec {
  kind: "base" | "chain";
  conceptSlug: string;
  metric: string;
  entity: string;
  value: string;
  sentence: string;
}

/** A deliberate multi-hop reference chain A -> B -> C of length 3. */
export interface ChainSpec {
  id: string;
  aSlug: string;
  bSlug: string;
  cSlug: string;
  aTitle: string;
  bTitle: string;
  cTitle: string;
  /** Chain metric asked about; differs from A's and B's own base metrics. */
  metric: string;
  /** The questioned entity: A's entity (so the question names only A). */
  entity: string;
  value: string;
  goldFact: string;
}

export interface ConceptSpec {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  status: "stable" | "draft" | "deprecated";
  /** Distinctive entity this concept's base facts talk about. */
  entity: string;
  facts: FactSpec[];
  chainId: string | null;
  chainRole: "A" | "B" | "C" | null;
  body: string;
  /** Repo-relative file path inside the fixture dir, e.g. "docs/alpha-basin.md". */
  file: string;
}

export interface FixtureSpec {
  dir: string;
  size: FixtureSize;
  seed: number;
  concepts: ConceptSpec[];
  chains: ChainSpec[];
  /** All controlled facts: base facts of every concept, then chain gold facts. */
  facts: FactSpec[];
  counts: { concepts: number; chains: number; baseFacts: number; chainFacts: number };
  indexFile: string;
}

/** Multi-hop chain count for a given concept count (feature decision). */
export function chainCountFor(concepts: number): number {
  return Math.max(4, Math.floor(concepts / 8));
}

/** Fixed controlled-fact phrasing shared by fixtures, tasks, and tests. */
export function factSentence(metric: string, entity: string, value: string): string {
  return `The ${metric} of ${entity} is ${value}.`;
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function tagsFor(index: number): string[] {
  const tags = [TAGS[index % TAGS.length]!, TAGS[(index + 2) % TAGS.length]!];
  if (index % 3 === 0) tags.push(TAGS[(index + 4) % TAGS.length]!);
  return tags;
}

function statusFor(index: number): ConceptSpec["status"] {
  if (index % 9 === 3) return "draft";
  if (index % 11 === 5) return "deprecated";
  return "stable";
}

function frontmatterFor(concept: Omit<ConceptSpec, "body" | "file" | "facts" | "chainId" | "chainRole">): string {
  const tagLines = concept.tags.map((tag) => `  - ${tag}`).join("\n");
  return [
    "---",
    "type: Reference",
    `title: "${concept.title}"`,
    `description: "${concept.description}"`,
    "tags:",
    tagLines,
    `status: ${concept.status}`,
    "---",
    "",
  ].join("\n");
}

/**
 * Write the reserved `docs/index.md` (OKF §8 style: title list + one-line
 * descriptions). The file exists on disk and is readable, but `index.md` is a
 * reserved navigational filename (OKF §3.1) that the okf-god catalog never
 * lists as a concept.
 */
export function writeIndex(dir: string, concepts: ConceptSpec[]): string {
  const lines = ["# Documentation index", "", "Reference docs in this workspace:", ""];
  for (const concept of [...concepts].sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`- [${concept.title}](./${concept.slug}.md) — ${concept.description}`);
  }
  lines.push("", "Sections are flat; this reserved file is navigational only (OKF §3.1).", "");
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir, { recursive: true });
  const file = join(docsDir, "index.md");
  writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * Generate a synthetic OKF v0.2 bundle under `opts.dir` (created recursively,
 * existing files overwritten) and return the ground-truth spec.
 */
export function generateFixture(opts: { size: FixtureSize; seed: number; dir: string }): FixtureSpec {
  const n = SIZE_CONCEPTS[opts.size];
  if (!Number.isInteger(n)) throw new Error(`generateFixture: unknown size ${opts.size}`);
  if (!Number.isInteger(opts.seed)) throw new Error(`generateFixture: seed must be an integer`);
  const rng = createRng(opts.seed);

  // Unique slugs: the full prefix x suffix pool is shuffled once and cut to n,
  // so slug uniqueness is guaranteed by construction for every supported size.
  const pool: string[] = [];
  for (const prefix of PREFIXES) {
    for (const suffix of SUFFIXES) pool.push(`${prefix}-${suffix}`);
  }
  const slugs = rng.shuffle(pool).slice(0, n);
  const titles = slugs.map(slugToTitle);
  const entities = slugs.map((slug) => slug.replace(/-/g, " "));

  const chainCount = chainCountFor(n);
  const chains: ChainSpec[] = [];
  const roleByIndex = new Map<number, { chainId: string; role: "A" | "B" | "C" }>();
  for (let j = 0; j < chainCount; j++) {
    const idxA = 3 * j;
    const idxB = idxA + 1;
    const idxC = idxA + 2;
    // Offsets 0/2 (base facts) vs 4 (chain) keep the chain metric distinct
    // from every base metric of A and B; +5 keeps the chain value distinct
    // from A's base values (+1/+9) modulo the value pool length (16).
    const metric = METRICS[(idxA + 4) % METRICS.length]!;
    const value = VALUES[(idxA * 5 + 5) % VALUES.length]!;
    const chainId = `chain-${j + 1}`;
    const goldFact = factSentence(metric, entities[idxA]!, value);
    chains.push({
      id: chainId,
      aSlug: slugs[idxA]!,
      bSlug: slugs[idxB]!,
      cSlug: slugs[idxC]!,
      aTitle: titles[idxA]!,
      bTitle: titles[idxB]!,
      cTitle: titles[idxC]!,
      metric,
      entity: entities[idxA]!,
      value,
      goldFact,
    });
    roleByIndex.set(idxA, { chainId, role: "A" });
    roleByIndex.set(idxB, { chainId, role: "B" });
    roleByIndex.set(idxC, { chainId, role: "C" });
  }

  // Tag groups (ascending index order) drive same-tag sibling links.
  const tagGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const primary = TAGS[i % TAGS.length]!;
    const group = tagGroups.get(primary) ?? [];
    group.push(i);
    tagGroups.set(primary, group);
  }

  const facts: FactSpec[] = [];
  const concepts: ConceptSpec[] = [];

  for (let i = 0; i < n; i++) {
    const slug = slugs[i]!;
    const title = titles[i]!;
    const entity = entities[i]!;
    const chain = roleByIndex.get(i) ?? null;

    // Two base facts; metric offsets 0 vs 2 (mod 6) never collide, and the
    // per-concept entity keeps (metric, entity) question keys globally unique.
    const baseMetric1 = METRICS[i % METRICS.length]!;
    const baseValue1 = VALUES[(i * 5 + 1) % VALUES.length]!;
    const baseMetric2 = METRICS[(i + 2) % METRICS.length]!;
    const baseValue2 = VALUES[(i * 5 + 9) % VALUES.length]!;
    const conceptFacts: FactSpec[] = [
      {
        kind: "base",
        conceptSlug: slug,
        metric: baseMetric1,
        entity,
        value: baseValue1,
        sentence: factSentence(baseMetric1, entity, baseValue1),
      },
      {
        kind: "base",
        conceptSlug: slug,
        metric: baseMetric2,
        entity,
        value: baseValue2,
        sentence: factSentence(baseMetric2, entity, baseValue2),
      },
    ];

    if (chain?.role === "C") {
      const spec = chains.find((c) => c.id === chain.chainId)!;
      conceptFacts.push({
        kind: "chain",
        conceptSlug: slug,
        metric: spec.metric,
        entity: spec.entity,
        value: spec.value,
        sentence: spec.goldFact,
      });
    }
    facts.push(...conceptFacts);

    const topic = TOPICS[i % TOPICS.length]!;
    const description = `${title} reference: ${topic} notes for the ${entity} domain.`;

    // Sibling links share the concept's primary tag. Chain roles A and B keep
    // at most one sibling so their total concept links stay within 1-3.
    const group = tagGroups.get(TAGS[i % TAGS.length]!)!;
    const pos = group.indexOf(i);
    const siblingIndices: number[] = [];
    if (group.length > 1) siblingIndices.push(group[(pos + 1) % group.length]!);
    const wantsSecondSibling = i % 2 === 0 && chain?.role !== "A" && chain?.role !== "B";
    if (wantsSecondSibling && group.length > 2) {
      const candidate = group[(pos + 2) % group.length]!;
      if (!siblingIndices.includes(candidate)) siblingIndices.push(candidate);
    }

    const related: string[] = siblingIndices.map((sib) => {
      const sibSlug = slugs[sib]!;
      const sibTitle = titles[sib]!;
      return `- [${sibTitle}](./${sibSlug}.md)`;
    });

    // Reserved index links: exactly 3 across the whole fixture.
    const indexLinkPositions = [4, Math.floor(n / 3), 2 * Math.floor(n / 3)];
    if (indexLinkPositions.includes(i)) {
      related.push("- [Documentation index](./index.md)");
    }

    const bodyLines: string[] = [
      `# ${title}`,
      "",
      description,
      "",
    ];

    if (chain?.role === "A") {
      const spec = chains.find((c) => c.id === chain.chainId)!;
      bodyLines.push(
        `Authoritative details for the ${spec.metric} of ${spec.entity} live in [${spec.bTitle}](./${spec.bSlug}.md).`,
        "",
      );
    }
    if (chain?.role === "B") {
      const spec = chains.find((c) => c.id === chain.chainId)!;
      bodyLines.push(
        `The ${spec.metric} of ${spec.entity} is recorded in [${spec.cTitle}](./${spec.cSlug}.md).`,
        "",
      );
    }

    bodyLines.push("Related reading:", ...related, "");

    // Deliberately broken links (targets are never written to disk).
    if (i % 7 === 2) bodyLines.push(`- [Archived notes](./${slug}-legacy.md)`);
    if (i % 13 === 5) bodyLines.push(`- [Draft sketch](./draft-${slug}.md)`);

    bodyLines.push("# Facts", "");
    for (const fact of conceptFacts) bodyLines.push(fact.sentence);
    bodyLines.push("");

    const base = {
      slug,
      title,
      description,
      tags: tagsFor(i),
      status: statusFor(i),
      entity,
    };
    concepts.push({
      ...base,
      facts: conceptFacts,
      chainId: chain?.chainId ?? null,
      chainRole: chain?.role ?? null,
      body: bodyLines.join("\n"),
      file: `docs/${slug}.md`,
    });
  }

  const docsDir = join(opts.dir, "docs");
  mkdirSync(docsDir, { recursive: true });
  for (const concept of concepts) {
    writeFileSync(join(opts.dir, concept.file), frontmatterFor(concept) + concept.body, "utf8");
  }
  const indexFile = writeIndex(opts.dir, concepts);

  return {
    dir: opts.dir,
    size: opts.size,
    seed: opts.seed,
    concepts,
    chains,
    facts,
    counts: {
      concepts: n,
      chains: chainCount,
      baseFacts: n * 2,
      chainFacts: chainCount,
    },
    indexFile,
  };
}
