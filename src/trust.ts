/** OKF §5.3 trust tiers, lowest to highest. */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/**
 * Derive the OKF §5.3 trust tier from a `verified` frontmatter value.
 *
 * - absent / unusable  => "unverified"
 * - only non-`human:` actors => "machine-confirmed"
 * - any `human:<id>` verifier => "human-reviewed"
 *
 * A bare `{ by, at }` mapping is normalized to a one-element list (§5.2).
 * Malformed values are tolerated defensively and never throw.
 */
export function deriveTrustTier(verified: unknown): TrustTier {
  const events = normalizeVerifiedList(verified);
  if (events.length === 0) return "unverified";

  let sawVerifier = false;
  let sawHuman = false;
  for (const event of events) {
    const actor = readActor(event);
    if (actor === undefined) continue;
    sawVerifier = true;
    if (actor.startsWith("human:")) sawHuman = true;
  }

  if (!sawVerifier) return "unverified";
  return sawHuman ? "human-reviewed" : "machine-confirmed";
}

/**
 * OKF §5.5: a concept is stale when `now >= stale_after` (plain instant
 * comparison, no TTL). Unparseable or absent values are never stale.
 */
export function isStale(staleAfter: unknown, now: Date = new Date()): boolean {
  if (typeof staleAfter !== "string" && !(staleAfter instanceof Date) && typeof staleAfter !== "number") {
    return false;
  }
  const instant = new Date(staleAfter as string | number | Date);
  if (Number.isNaN(instant.getTime())) return false;
  return now.getTime() >= instant.getTime();
}

/**
 * OKF §5.4 lifecycle status. Absent/empty values default to "stable"; any
 * producer string is kept as-is (permissive conformance, unknown values are
 * tolerated rather than rewritten).
 */
export function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "stable";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "stable";
}

/** Normalize a `verified` value into a list of verification events. */
export function normalizeVerifiedList(verified: unknown): unknown[] {
  if (verified === null || verified === undefined) return [];
  if (Array.isArray(verified)) return verified.filter((item) => item !== null && item !== undefined);
  if (typeof verified === "object") return [verified]; // bare { by, at } mapping (§5.2)
  return [];
}

function readActor(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const by = (event as Record<string, unknown>)["by"];
  if (typeof by !== "string") return undefined;
  const trimmed = by.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
