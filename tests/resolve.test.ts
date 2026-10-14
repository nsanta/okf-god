import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEntry, type CatalogEntry, type CatalogKind } from "../src/catalog.ts";
import { resolveCatalogEntry } from "../src/resolve.ts";

const R1 = "/root-one";
const R2 = "/root-two";

/** Build an entry from a POSIX root-relative path; the name is the filename slug. */
function entry(kind: CatalogKind, root: string, relPath: string): CatalogEntry {
  const segments = relPath.split("/");
  const section = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
  return buildEntry(kind, join(root, ...segments), root, section, {
    description: "Fixture for resolution tests",
    tags: [],
  });
}

function expectEntry(result: ReturnType<typeof resolveCatalogEntry>): CatalogEntry {
  expect(result).not.toHaveProperty("error");
  return result as CatalogEntry;
}

function expectError(result: ReturnType<typeof resolveCatalogEntry>): string {
  expect(result).toHaveProperty("error");
  return (result as { error: string }).error;
}

// One mock doc per root layout plus an agent whose name collides with the doc.
const entries: CatalogEntry[] = [
  entry("doc", R1, "docs/mock.md"), // doc/mock
  entry("doc", R1, "docs/guides/deploy.md"), // doc/deploy, section docs/guides
  entry("doc", R2, "reports/status.md"), // doc/status
  entry("agent", R2, "agents/mock.md"), // agent/mock
];

describe("resolveCatalogEntry path ladder", () => {
  it("level 1: resolves an exact absolute path", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: join(R1, "docs/mock.md") }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("level 1: accepts an absolute path without the .md extension", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: join(R1, "docs/mock") }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("level 2: resolves the display form kind/name", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "doc/mock" }));
    expect(match).toMatchObject({ kind: "doc", name: "mock", path: join(R1, "docs/mock.md") });
  });

  it("level 2: the display form decides before a would-be ambiguous suffix", () => {
    // The bare `mock` suffix hits both roots, but doc/mock is a unique kind:name.
    const match = expectEntry(resolveCatalogEntry(entries, { path: "doc/mock" }));
    expect(match).toMatchObject({ kind: "doc", path: join(R1, "docs/mock.md") });
  });

  it("level 3: resolves a kind-prefixed section-qualified path (doc/guides/deploy)", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "doc/guides/deploy" }));
    expect(match).toMatchObject({ kind: "doc", name: "deploy", path: join(R1, "docs/guides/deploy.md") });
  });

  it("level 3: resolves a root-relative path with .md (docs/mock.md)", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "docs/mock.md" }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("level 3: resolves a root-relative path without extension (docs/mock)", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "docs/mock" }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("level 3: strips a trailing .md case-insensitively", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "docs/mock.MD" }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("level 3: normalizes backslash separators and a leading ./", () => {
    expectEntry(resolveCatalogEntry(entries, { path: "docs\\mock" }));
    expectEntry(resolveCatalogEntry(entries, { path: "./docs/mock" }));
  });

  it("level 3: resolves an extensionless nested suffix (guides/deploy)", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "guides/deploy" }));
    expect(match).toMatchObject({ kind: "doc", name: "deploy" });
  });

  it("level 3: strips a leading kind/ from a root-relative path (doc/docs/mock)", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "doc/docs/mock" }));
    expect(match).toMatchObject({ kind: "doc", name: "mock" });
  });

  it("reports ambiguity when one level matches entries under two roots", () => {
    const twoRoots = [entry("doc", R1, "docs/mock.md"), entry("doc", R2, "docs/mock.md")];
    const error = expectError(resolveCatalogEntry(twoRoots, { path: "docs/mock" }));
    expect(error).toContain(
      `doc:mock (${join(R1, "docs/mock.md")})\ndoc:mock (${join(R2, "docs/mock.md")})`,
    );
  });

  it("an ambiguous path level decides and never falls through to the name", () => {
    const twoRoots = [entry("doc", R1, "docs/mock.md"), entry("doc", R2, "docs/mock.md")];
    const error = expectError(resolveCatalogEntry(twoRoots, { path: "docs/mock", name: "mock" }));
    expect(error).toContain("ambiguous");
  });

  it("an unknown path lists the accepted forms and suggests okf_search", () => {
    const error = expectError(resolveCatalogEntry(entries, { path: "elusive/target" }));
    expect(error).toContain("elusive/target");
    expect(error).toContain("doc/mock");
    expect(error).toContain("docs/mock.md");
    expect(error).toContain("okf_search");
  });
});

describe("resolveCatalogEntry name handling", () => {
  it("resolves a unique exact name", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { name: "deploy" }));
    expect(match).toMatchObject({ kind: "doc", name: "deploy", path: join(R1, "docs/guides/deploy.md") });
  });

  it("reports ambiguity across kinds with candidates one per line", () => {
    const error = expectError(resolveCatalogEntry(entries, { name: "mock" }));
    expect(error).toContain(
      `doc:mock (${join(R1, "docs/mock.md")})\nagent:mock (${join(R2, "agents/mock.md")})`,
    );
  });

  it("reports a missing name", () => {
    const error = expectError(resolveCatalogEntry(entries, { name: "ghost" }));
    expect(error).toContain("ghost");
    expect(error).toContain("okf_search");
  });

  it("falls through to the name when the path matches nothing", () => {
    const match = expectEntry(resolveCatalogEntry(entries, { path: "elusive/target", name: "status" }));
    expect(match).toMatchObject({ kind: "doc", name: "status", path: join(R2, "reports/status.md") });
  });

  it("requires a path or a name", () => {
    expectError(resolveCatalogEntry(entries, {}));
    expectError(resolveCatalogEntry(entries, { path: "   " }));
    expectError(resolveCatalogEntry(entries, { name: "   " }));
  });
});
