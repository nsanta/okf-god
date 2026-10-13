import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanCatalog, type CatalogKind } from "../src/catalog.ts";

const FIXTURES = mkdtempSync(join(tmpdir(), "okf-fields-"));
afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(FIXTURES, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function fixtureRoots(): Record<CatalogKind, string[]> {
  return {
    skill: [join(FIXTURES, "skills")],
    doc: [join(FIXTURES, "docs")],
    agent: [join(FIXTURES, "agents")],
  };
}

describe("OKF v0.2 field extraction at scan time", () => {
  it("skips reserved navigational files (§3.1) in every directory", async () => {
    write("docs/index.md", "# Listing\n");
    write("docs/deep/index.md", "# Listing\n");
    write("docs/log.md", "# History\n");
    write("docs/real.md", "---\ntype: Reference\ndescription: Real concept.\ntags: []\n---\n");

    const entries = await scanCatalog(fixtureRoots());
    const names = entries.filter((entry) => entry.kind === "doc").map((entry) => entry.name);
    expect(names).toEqual(["real"]);
  });

  it("extracts type, resource, stale_after, generated.at, and trust tiers", async () => {
    write(
      "docs/orders.md",
      [
        "---",
        "type: BigQuery Table",
        "title: Customer Orders",
        "description: One row per completed customer order.",
        "resource: https://console.example.com/bigquery/orders",
        "tags: [sales, orders]",
        "status: draft",
        "stale_after: 2026-09-23T00:00:00Z",
        "generated: { by: reference_agent/gemini-2.5-pro, at: 2026-05-28T14:30:00Z }",
        "verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }",
        "sources:",
        "  - id: ga4-schema",
        "    resource: https://developers.example.com/schema",
        "---",
        "Body.",
      ].join("\n"),
    );
    write(
      "docs/profit.md",
      [
        "---",
        "type: Attested Computation",
        "runtime: dbt",
        "verified:",
        "  - { by: process:finance-nightly, at: 2026-06-12T08:00:00Z }",
        "stale_after: 2020-01-01T00:00:00Z",
        "---",
        "Body.",
      ].join("\n"),
    );
    write("docs/plain.md", "---\ntype: Reference\n---\nBody.\n");

    const entries = await scanCatalog(fixtureRoots());
    const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.name}`, entry]));

    const orders = byKey.get("doc:orders");
    expect(orders?.okfType).toBe("BigQuery Table");
    expect(orders?.resource).toBe("https://console.example.com/bigquery/orders");
    expect(orders?.staleAfter).toBe("2026-09-23T00:00:00Z");
    expect(orders?.generatedAt).toBe("2026-05-28T14:30:00Z");
    expect(orders?.trustTier).toBe("human-reviewed");
    expect(orders?.status).toBe("draft");

    // process-only verification and a past stale_after: machine-confirmed.
    const profit = byKey.get("doc:profit");
    expect(profit?.okfType).toBe("Attested Computation");
    expect(profit?.trustTier).toBe("machine-confirmed");
    expect(profit?.generatedAt).toBeUndefined();

    // Absent families: unverified, stable, no extras (§11 permissive).
    const plain = byKey.get("doc:plain");
    expect(plain?.trustTier).toBe("unverified");
    expect(plain?.status).toBe("stable");
    expect(plain?.okfType).toBe("Reference");
    expect(plain?.resource).toBeUndefined();
    expect(plain?.staleAfter).toBeUndefined();
  });

  it("records the scan root on each entry for bundle-relative resolution", async () => {
    write("docs/anchored.md", "---\ntype: Reference\n---\n");
    const entries = await scanCatalog(fixtureRoots());
    const anchored = entries.find((entry) => entry.name === "anchored");
    expect(anchored?.root).toBe(join(FIXTURES, "docs"));
  });
});
