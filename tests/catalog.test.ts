import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CatalogCache, scanCatalog, type CatalogKind } from "../src/catalog.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-catalog-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string, mtime?: Date): void {
  const full = join(FIXTURES, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  if (mtime) utimesSync(full, mtime, mtime);
}

function fixtureRoots(): Record<CatalogKind, string[]> {
  return {
    skill: [join(FIXTURES, "skills")],
    doc: [join(FIXTURES, "docs")],
    agent: [join(FIXTURES, "agents")],
  };
}

describe("scanCatalog", () => {
  it("indexes skills, docs, and agents with resolved names and metadata", async () => {
    write(
      "skills/alpha/SKILL.md",
      "---\nname: alpha-skill\ntitle: Alpha Skill\ndescription: Alpha does things.\ntags: [build, test]\nstatus: stable\n---\nBody ignored.\n",
    );
    // No frontmatter name -> directory name is used.
    write("skills/beta/SKILL.md", "---\ndescription: Beta helps too.\ntags: []\n---\nBody.\n");
    // Excluded: 99-archive path segment.
    write("skills/99-archive/gamma/SKILL.md", "---\nname: gamma\ndescription: Archived.\ntags: []\n---\n");
    // Excluded: hidden directory below the root.
    write("skills/.hidden/delta/SKILL.md", "---\nname: delta\ndescription: Hidden.\ntags: []\n---\n");
    // Excluded: node_modules path segment.
    write("skills/node_modules/epsilon/SKILL.md", "---\nname: epsilon\ndescription: Deps.\ntags: []\n---\n");

    write("docs/guide.md", "---\ntitle: User Guide\ndescription: How to use it.\ntags: [guide]\n---\n");
    write("docs/deep/nested/notes.md", "---\ndescription: Nested notes.\ntags: [notes]\n---\n");

    write("agents/helper.md", "---\nname: helper-agent\ndescription: A helpful agent.\ntags: [dev]\nstatus: beta\n---\n");
    // No frontmatter at all -> filename fallback, empty metadata.
    write("agents/plain.md", "Just text, no frontmatter.\n");

    const entries = await scanCatalog(fixtureRoots());

    const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.name}`, entry]));

    const alpha = byKey.get("skill:alpha-skill");
    expect(alpha).toBeDefined();
    expect(alpha?.title).toBe("Alpha Skill");
    expect(alpha?.tags).toEqual(["build", "test"]);
    expect(alpha?.status).toBe("stable");
    expect(alpha?.path).toBe(join(FIXTURES, "skills/alpha/SKILL.md"));

    expect(byKey.get("skill:beta")?.description).toBe("Beta helps too.");

    const guide = byKey.get("doc:guide");
    expect(guide?.title).toBe("User Guide");
    expect(guide?.section).toBeUndefined();

    const notes = byKey.get("doc:notes");
    expect(notes?.section).toBe("deep/nested");

    expect(byKey.get("agent:helper-agent")?.status).toBe("beta");
    const plain = byKey.get("agent:plain");
    expect(plain?.description).toBe("");
    expect(plain?.tags).toEqual([]);

    // Exclusions.
    expect(byKey.has("skill:gamma")).toBe(false);
    expect(byKey.has("skill:delta")).toBe(false);
    expect(byKey.has("skill:epsilon")).toBe(false);
  });

  it("picks up file changes on rescan with a shared cache (mtime invalidation)", async () => {
    write("skills/refresh/SKILL.md", "---\nname: refresh\ndescription: Before edit.\ntags: []\n---\n");
    const cache = new CatalogCache();
    const before = await scanCatalog(fixtureRoots(), { cache });
    expect(before.find((entry) => entry.name === "refresh")?.description).toBe("Before edit.");

    const changedAt = new Date(Date.now() + 5000);
    write("skills/refresh/SKILL.md", "---\nname: refresh\ndescription: After edit.\ntags: []\n---\n", changedAt);

    const after = await scanCatalog(fixtureRoots(), { cache });
    expect(after.find((entry) => entry.name === "refresh")?.description).toBe("After edit.");
  });

  it("invalidates on size change even when mtime is unchanged", async () => {
    write("skills/resize/SKILL.md", "---\nname: resize\ndescription: Short.\ntags: []\n---\n");
    const cache = new CatalogCache();
    const before = await scanCatalog(fixtureRoots(), { cache });
    expect(before.find((entry) => entry.name === "resize")?.description).toBe("Short.");

    // Rewrite with a longer body but pin mtime back to the original value.
    const original = before.find((entry) => entry.name === "resize");
    const pinned = new Date(0);
    void original;
    const statBefore = cache.peek(join(FIXTURES, "skills/resize/SKILL.md"));
    write(
      "skills/resize/SKILL.md",
      "---\nname: resize\ndescription: Longer description now.\ntags: []\n---\nExtra body.\n",
      pinned,
    );
    if (statBefore) utimesSync(join(FIXTURES, "skills/resize/SKILL.md"), new Date(statBefore.mtimeMs), new Date(statBefore.mtimeMs));

    const after = await scanCatalog(fixtureRoots(), { cache });
    expect(after.find((entry) => entry.name === "resize")?.description).toBe("Longer description now.");
  });

  it("keeps the first entry when names duplicate across roots", async () => {
    write("agents/dup.md", "---\nname: same-name\ndescription: First wins.\ntags: []\n---\n");
    const roots = fixtureRoots();
    roots.agent = [join(FIXTURES, "agents"), join(FIXTURES, "agents-dup")];
    write("agents-dup/other.md", "---\nname: same-name\ndescription: Second loses.\ntags: []\n---\n");

    const entries = await scanCatalog(roots);
    const dupes = entries.filter((entry) => entry.kind === "agent" && entry.name === "same-name");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.description).toBe("First wins.");
  });

  it("ignores missing roots silently", async () => {
    const roots = {
      skill: [join(FIXTURES, "does-not-exist")],
      doc: [join(FIXTURES, "docs")],
      agent: [],
    };
    const entries = await scanCatalog(roots);
    expect(entries.every((entry) => entry.kind === "doc")).toBe(true);
  });
});
