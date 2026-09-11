/**
 * MUNDER_DEV=1 — development isolation (Mission 2, DEV-ISOLATION.md).
 *
 * Lets a source checkout run BESIDE the installed Stable app without touching
 * Stable's userData, hive, palace, worktrees, roster or hook pipe. Everything in
 * here is inert unless the launching environment carries `MUNDER_DEV=1`; with it
 * unset, every exported helper returns the v0.4.5 value unchanged.
 *
 * Deliberately free of any `electron` import so it is unit-testable as a plain
 * module (test/dev-isolation.test.cjs). The Electron-facing wiring (setPath,
 * dialog, exit) lives in index.ts and calls into these pure helpers.
 *
 * What is isolated, and why each piece matters:
 *   - userData: Electron derives the default from the package name, so a dev run
 *     and the packaged app would otherwise share `%APPDATA%/munder-difflin` —
 *     the same config.json (and so the same harnessHome / hive), the same
 *     harness.db, AND the same single-instance lock, which is keyed on userData.
 *   - harnessHome: clamped to the dev data root by config.ts, so the hive, palace,
 *     worktrees and roster.json all resolve under it regardless of what the
 *     onboarding wizard or a stale config says.
 *   - hook pipe: hive.ts derives the pipe id from the hive root (sha1), so it is
 *     distinct by construction; a `dev-` marker is added so it is obviously so.
 *   - inherited env: a dev launched from an agent terminal inherits Stable's
 *     HIVE_ROOT / HIVE_SOCK / AGENT_* / MEMPALACE_PALACE_PATH. They are scrubbed
 *     from process.env at bootstrap so nothing in this process (or any child)
 *     can pick up Stable's identity by accident.
 *   - a startup guard hard-fails if any resolved dev path equals or lies inside a
 *     Stable-owned path, or the pipe name equals Stable's.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep, win32, posix, dirname } from 'node:path';

/** True when the process was launched with MUNDER_DEV=1. Read once at load. */
export const DEV_ISOLATION: boolean = process.env.MUNDER_DEV === '1';

/** Env vars a Stable agent terminal exports that would re-point a dev process at
 *  the live hive. Scrubbed at bootstrap when DEV_ISOLATION is on. */
export const STABLE_ENV_KEYS = [
  'HIVE_ROOT',
  'HIVE_SOCK',
  'HIVE_NODE',
  'HIVE_AUTO_APPROVE',
  'AGENT_ID',
  'AGENT_DIR',
  'AGENT_NAME',
  'MEMPALACE_PALACE_PATH',
  // Provider routing Stable injects per agent (Dwight M3 matrix): each would
  // point a dev-spawned agent at a Stable-owned home or endpoint.
  'MD_SLACK_REPLY_CONFIG',
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'CRUSH_GLOBAL_CONFIG',
  'CRUSH_GLOBAL_DATA',
  // Knowledge-graph CLI wiring, integration broker capability, proxy sidecar
  // routing and Claude OTel enablement (Dwight audit of 0d1441db). The proxy
  // and broker ones are normally sidecar/agent-only, but a dev launched from
  // an agent terminal inherits whatever that agent was given.
  'KG_ROOT',
  'KG_CLI',
  'KG_CORE',
  'MD_BROKER_URL',
  'MD_BROKER_TOKEN',
  'HIVE_PROXY_SESSION',
  'OPENAI_BASE_URL',
  'CRUSH_PROXY_BASE_URL',
  'CLAUDE_CODE_ENABLE_TELEMETRY'
] as const;

/** Prefixes scrubbed wholesale: Stable's OTel exporter settings for the
 *  telemetry collector (`OTEL_*`) point at Stable's loopback port. */
export const STABLE_ENV_PREFIXES = ['OTEL_'] as const;

/** Stable-owned paths that must never be selected by a dev build, independent of
 *  anything discoverable at runtime. Windows-only literals; on other platforms
 *  only the runtime-discovered set applies. */
const STABLE_LITERALS_WIN32 = [
  'C:\\Dunder\\hive',
  'C:\\Dunder\\palace',
  'C:\\Dunder\\worktrees',
  'C:\\Dunder\\roster.json',
  'C:\\Dunder\\roster-backups',
  'C:\\Dunder\\hallways.json',
  'C:\\Dunder\\tunnels.json'
];

/** The dev data root: FIXED by the mission contract (no environment override —
 *  a relocatable root was removed at Dwight's audit of 0d1441db). Windows uses
 *  the mission's dedicated location; other platforms `~/MunderDevData`. */
export function devDataRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'C:\\Dunder\\MunderDevData' : join(homedir(), 'MunderDevData');
}

/** Electron userData for the dev build: `<root>/userData`. */
export function devUserData(root: string): string {
  return join(root, 'userData');
}

/** The harness home (what config.harnessHome is clamped to). v0.4.5 derives
 *  hive = <home>/hive, palace = <home>/palace, worktrees = <home>/worktrees and
 *  roster.json = <home>/roster.json, so the root itself is the home. */
export function devHarnessHome(root: string): string {
  return root;
}

export interface ResolvedPaths {
  userData: string;
  harnessHome: string;
  hiveRoot: string;
  palace: string;
  worktrees: string;
  /** The hook IPC endpoint (named pipe on Windows, socket file elsewhere). */
  pipeName: string;
}

/** Mirror of hive.ts sockPath(): the 12-hex pipe id for a hive root. Kept here so
 *  the guard can compute what Stable's pipe name IS from Stable's hive root. */
export function hookPipeId(hiveRoot: string): string {
  return createHash('sha1').update(hiveRoot).digest('hex').slice(0, 12);
}

export function hookPipeName(
  hiveRoot: string,
  dev: boolean,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\munder-difflin-${dev ? 'dev-' : ''}${hookPipeId(hiveRoot)}`;
  }
  return join(hiveRoot, 'hooks.sock');
}

/** The full set of paths a dev build will use for a given data root. */
export function devPaths(root: string, platform: NodeJS.Platform = process.platform): ResolvedPaths {
  const harnessHome = devHarnessHome(root);
  const hiveRoot = join(harnessHome, 'hive');
  return {
    userData: devUserData(root),
    harnessHome,
    hiveRoot,
    palace: join(harnessHome, 'palace'),
    worktrees: join(harnessHome, 'worktrees'),
    pipeName: hookPipeName(hiveRoot, true, platform)
  };
}

/** Every Stable-owned path the guard must reject. Combines the hard-coded
 *  literals with what is discoverable: Electron's DEFAULT userData (which is
 *  Stable's — captured before we override it) and, if Stable's config.json is
 *  readable, the hive/palace/worktrees/roster under Stable's harnessHome. */
export function stableForbiddenPaths(opts: {
  defaultUserData?: string | null;
  stableHarnessHome?: string | null;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const out: string[] = platform === 'win32' ? [...STABLE_LITERALS_WIN32] : [];
  if (opts.defaultUserData) out.push(opts.defaultUserData);
  const home = typeof opts.stableHarnessHome === 'string' ? opts.stableHarnessHome.trim() : '';
  if (home) {
    out.push(
      join(home, 'hive'),
      join(home, 'palace'),
      join(home, 'worktrees'),
      join(home, 'roster.json'),
      join(home, 'roster-backups')
    );
  }
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(normalizePath(p, platform)) ? false : (seen.add(normalizePath(p, platform)), true)));
}

/** Canonical form for comparison: resolved, single separators, no trailing
 *  separator, case-folded on Windows (NTFS is case-insensitive). */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const lib = platform === 'win32' ? win32 : posix;
  let n = lib.normalize(p.trim());
  while (n.length > 1 && (n.endsWith(lib.sep) || n.endsWith('/'))) n = n.slice(0, -1);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * The REAL path for comparison. The hook pipe id is sha1 of the root STRING, so
 * `C:\Dunder\hive`, `C:/Dunder/hive`, `c:\dunder\hive`, an 8.3 short name, a
 * trailing slash or a junction all yield different pipes for the SAME directory
 * — pipe difference proves nothing about directory difference (Andy, M4 §4).
 * The guard therefore compares filesystem-resolved paths: `realpathSync.native`
 * on the path itself, or — for a path that does not exist yet (the dev root on
 * first launch) — on its nearest existing ancestor with the remainder appended.
 * Falls back to pure normalisation when the path cannot be resolved on this
 * host at all (e.g. a Windows path evaluated in a POSIX unit test).
 */
export function canonicalPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== process.platform) return normalizePath(p, platform);
  const lib = platform === 'win32' ? win32 : posix;
  let probe = lib.resolve(p.trim());
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(probe);
      return normalizePath(tail.length ? lib.join(real, ...tail.reverse()) : real, platform);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break; // hit the root without finding anything that exists
      tail.push(lib.basename(probe));
      probe = parent;
    }
  }
  return normalizePath(p, platform);
}

/** True when `child` equals `parent` or lies anywhere beneath it — compared on
 *  canonical (realpath-resolved, normalised, case-folded on win32) forms. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = canonicalPath(child, platform);
  const p = canonicalPath(parent, platform);
  if (c === p) return true;
  const s = platform === 'win32' ? '\\' : sep;
  return c.startsWith(p + s);
}

/** The isolation check. Returns human-readable violations; empty = safe. A
 *  resolved dev path that equals or lies inside ANY forbidden path is a
 *  violation, and so is a forbidden path that lies inside a dev path (a dev
 *  harnessHome of `C:\Dunder` would contain Stable's hive). The pipe name is
 *  compared against the pipe Stable would derive from each forbidden hive root. */
export function checkIsolation(
  resolved: ResolvedPaths,
  forbidden: string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const violations: string[] = [];
  const entries: Array<[keyof ResolvedPaths, string]> = [
    ['userData', resolved.userData],
    ['harnessHome', resolved.harnessHome],
    ['hiveRoot', resolved.hiveRoot],
    ['palace', resolved.palace],
    ['worktrees', resolved.worktrees]
  ];
  for (const [name, p] of entries) {
    if (!p) { violations.push(`${name} is unset`); continue; }
    for (const f of forbidden) {
      if (isInside(p, f, platform)) violations.push(`${name} "${p}" is inside Stable path "${f}"`);
      else if (isInside(f, p, platform)) violations.push(`${name} "${p}" contains Stable path "${f}"`);
    }
  }
  if (!resolved.pipeName) {
    violations.push('pipeName is unset');
  } else {
    const live = platform === 'win32' ? resolved.pipeName.toLowerCase() : resolved.pipeName;
    for (const f of forbidden) {
      // A forbidden entry that IS a hive root (or contains one) yields Stable's
      // pipe name; compare against both the plain and hive-suffixed forms.
      for (const candidateRoot of [f, join(f, 'hive')]) {
        const stablePipe = hookPipeName(candidateRoot, false, platform);
        const cmp = platform === 'win32' ? stablePipe.toLowerCase() : stablePipe;
        if (live === cmp) violations.push(`pipe "${resolved.pipeName}" equals Stable's pipe for "${candidateRoot}"`);
      }
    }
    if (platform === 'win32' && !/munder-difflin-dev-/i.test(resolved.pipeName)) {
      violations.push(`pipe "${resolved.pipeName}" lacks the dev marker`);
    }
  }
  return violations;
}

/** Remove Stable's exported identity from an env object IN PLACE. Returns the
 *  keys that were actually present (for the startup log). */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const k of STABLE_ENV_KEYS) {
    if (k in env) { delete env[k]; removed.push(k); }
  }
  for (const k of Object.keys(env)) {
    if (STABLE_ENV_PREFIXES.some((p) => k.startsWith(p))) { delete env[k]; removed.push(k); }
  }
  return removed;
}

/**
 * Sanitise the user's global `~/.codex/config.toml` before it is seeded into a
 * DEV agent's isolated CODEX_HOME (Andy M4 finding on 0d1441db). Two things in
 * the global file point back at Stable/user state and must not be inherited:
 *   - any `CODEX_HOME = "…"` key (the global file carries one under an MCP
 *     server's `env` table, pointing at ~/.codex) — dropped wherever it occurs;
 *   - every `[projects.'<path>']` / `[projects."<path>"]` trust table (the
 *     user's global folder-trust list) — dropped with its body. A DEV agent's
 *     trust gate is suppressed by the preset's CODEX_NON_INTERACTIVE anyway.
 * Line-based on purpose: the file is simple TOML written by Codex itself, and a
 * full parser would add a dependency. Everything else is passed through
 * verbatim so auth/model/MCP settings keep working.
 */
export function sanitizeCodexConfigForDev(toml: string): { text: string; droppedKeys: number; droppedTables: number } {
  const out: string[] = [];
  let droppedKeys = 0;
  let droppedTables = 0;
  let skippingTable = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      skippingTable = /^projects\s*[."']/.test(header[1].trim());
      if (skippingTable) { droppedTables++; continue; }
    } else if (skippingTable) {
      continue; // body of a dropped [projects.…] table
    }
    if (/^\s*CODEX_HOME\s*=/.test(line)) { droppedKeys++; continue; }
    out.push(line);
  }
  return { text: out.join('\n'), droppedKeys, droppedTables };
}

/** Window title for the dev build. Unchanged when isolation is off. */
export function devWindowTitle(base: string, dev: boolean = DEV_ISOLATION): string {
  if (!dev) return base;
  return base.includes('Munder Difflin')
    ? base.replace('Munder Difflin', 'Munder Difflin DEV')
    : `${base} [DEV]`;
}
