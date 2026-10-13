import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CatalogKind, CatalogRoots } from "./catalog.ts";

/**
 * Per-kind default roots, resolved against a working directory. Mirrors pi's
 * own discovery: project `.pi/` dirs first, then user-level `~/.pi/agent/`,
 * then the Agent Skills/agents spec locations pi also supports. Missing roots
 * are skipped at scan time.
 */
export function defaultRoots(cwd: string): CatalogRoots {
  const home = homedir();
  return {
    skill: [
      join(cwd, ".pi", "skills"),
      join(cwd, ".agents", "skills"),
      join(home, ".pi", "agent", "skills"),
      join(home, ".agents", "skills"),
    ],
    doc: [join(cwd, "docs")],
    agent: [join(cwd, ".pi", "agents"), join(home, ".pi", "agent", "agents"), join(home, ".agents")],
  };
}

export interface OkfConfig {
  skills?: string[];
  docs?: string[];
  agents?: string[];
  exclude?: string[];
}

/**
 * Resolve the effective scan roots: OKF config override
 * (`<cwd>/.pi/okf.json`, else `~/.pi/agent/okf.json`) or the defaults.
 * Config paths may be relative to `cwd` and may start with `~`.
 * Missing or malformed config files are ignored (never throws).
 */
export function resolveRoots(cwd: string, config?: OkfConfig): CatalogRoots {
  const roots = defaultRoots(cwd);
  if (!config) return roots;

  const overridden: CatalogRoots = { ...roots };
  const kinds: CatalogKind[] = ["skill", "doc", "agent"];
  for (const kind of kinds) {
    const paths = config[kind === "skill" ? "skills" : kind === "doc" ? "docs" : "agents"];
    if (Array.isArray(paths) && paths.length > 0) {
      overridden[kind] = paths.map((p) => resolvePath(p, cwd)).filter((p) => p !== undefined);
    }
  }
  return overridden;
}

/** Read the first existing okf.json; returns undefined when absent/invalid. */
export async function loadConfig(cwd: string): Promise<OkfConfig | undefined> {
  const candidates = [join(cwd, ".pi", "okf.json"), join(homedir(), ".pi", "agent", "okf.json")];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const config = parsed as Record<string, unknown>;
      return {
        skills: readStringList(config["skills"]),
        docs: readStringList(config["docs"]),
        agents: readStringList(config["agents"]),
        exclude: readStringList(config["exclude"]),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Extract the `exclude` segments from the loaded config, if any. */
export function configExclude(config: OkfConfig | undefined): string[] {
  const exclude = config?.exclude?.filter((segment) => typeof segment === "string" && segment.length > 0) ?? [];
  return exclude;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items;
}

function resolvePath(path: string, cwd: string): string | undefined {
  if (typeof path !== "string" || path.trim().length === 0) return undefined;
  let expanded = path.trim();
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
