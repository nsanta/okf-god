import { describe, expect, it } from "vitest";
import { deriveTrustTier, isStale, normalizeStatus } from "../src/trust.ts";

describe("deriveTrustTier (OKF §5.3)", () => {
  it("returns unverified when verified is absent or empty", () => {
    expect(deriveTrustTier(undefined)).toBe("unverified");
    expect(deriveTrustTier(null)).toBe("unverified");
    expect(deriveTrustTier([])).toBe("unverified");
    expect(deriveTrustTier("garbage")).toBe("unverified");
    expect(deriveTrustTier(42)).toBe("unverified");
  });

  it("returns machine-confirmed when only non-human actors verified", () => {
    expect(
      deriveTrustTier([{ by: "reference_agent/gemini-2.5-pro", at: "2026-06-20T22:53:05Z" }]),
    ).toBe("machine-confirmed");
    expect(deriveTrustTier([{ by: "process:finance-nightly", at: "2026-06-26T02:00:00Z" }])).toBe(
      "machine-confirmed",
    );
  });

  it("returns human-reviewed when any human:<id> verifier is present", () => {
    expect(deriveTrustTier({ by: "human:ahormati", at: "2026-06-25T09:00:00Z" })).toBe("human-reviewed");
    expect(
      deriveTrustTier([
        { by: "process:finance-nightly", at: "2026-06-26T02:00:00Z" },
        { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
      ]),
    ).toBe("human-reviewed");
  });

  it("normalizes a bare { by, at } mapping to a one-element list (§5.2)", () => {
    expect(deriveTrustTier({ by: "human:ahormati", at: "2026-06-25T09:00:00Z" })).toBe("human-reviewed");
    expect(deriveTrustTier({ by: "process:nightly", at: "2026-06-25T09:00:00Z" })).toBe("machine-confirmed");
  });

  it("tolerates malformed entries without throwing", () => {
    expect(deriveTrustTier([{ nope: true }, "string entry", 5, { by: 123 }])).toBe("unverified");
    expect(deriveTrustTier([null, undefined, { by: "human:x" }])).toBe("human-reviewed");
    expect(deriveTrustTier([{ by: "   " }])).toBe("unverified");
  });
});

describe("isStale (OKF §5.5)", () => {
  const staleAfter = "2026-09-23T00:00:00Z";

  it("is stale when now >= stale_after (boundary inclusive)", () => {
    expect(isStale(staleAfter, new Date("2026-09-23T00:00:00Z"))).toBe(true);
    expect(isStale(staleAfter, new Date("2026-09-24T00:00:00Z"))).toBe(true);
  });

  it("is fresh before the instant", () => {
    expect(isStale(staleAfter, new Date("2026-09-22T23:59:59Z"))).toBe(false);
  });

  it("never reports stale for absent or malformed values", () => {
    expect(isStale(undefined, new Date("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isStale("not-a-date", new Date("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isStale({ object: true }, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("defaults now to the current time", () => {
    expect(isStale("1999-01-01T00:00:00Z")).toBe(true);
    expect(isStale("2999-01-01T00:00:00Z")).toBe(false);
  });
});

describe("normalizeStatus (OKF §5.4)", () => {
  it("defaults absent, empty, and non-string values to stable", () => {
    expect(normalizeStatus(undefined)).toBe("stable");
    expect(normalizeStatus(null)).toBe("stable");
    expect(normalizeStatus("")).toBe("stable");
    expect(normalizeStatus("   ")).toBe("stable");
    expect(normalizeStatus(7)).toBe("stable");
  });

  it("keeps any producer string, including unknown ones", () => {
    expect(normalizeStatus("draft")).toBe("draft");
    expect(normalizeStatus("stable")).toBe("stable");
    expect(normalizeStatus("deprecated")).toBe("deprecated");
    expect(normalizeStatus("beta")).toBe("beta");
  });
});
