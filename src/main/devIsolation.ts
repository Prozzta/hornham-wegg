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
import { realpathSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
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
 * DEV agent's isolated CODEX_HOME (Andy M4 finding on 0d1441db; Dwight re-audit
 * of 00bd99bc). Three things in the global file point back at Stable/user state
 * and must not be inherited verbatim:
 *   - every `CODEX_HOME = '…'` key (the global file carries one under
 *     `[mcp_servers.node_repl.env]`, pointing at ~/.codex, which would give the
 *     helper a WRITABLE global home despite the process-env scrub) — rewritten
 *     to the DEV agent's own CODEX_HOME;
 *   - every named-pipe value (`SKY_CUA_NATIVE_PIPE_DIRECTORY = '\\.\pipe\codex-
 *     computer-use-…'`), a shared named identity / cross-talk channel with
 *     Stable's helpers — suffixed so it is DEV-distinct per agent;
 *   - every `[projects.'<path>']` / `[projects."<path>"]` trust table (the
 *     user's global folder-trust list) — dropped with its body. A DEV agent's
 *     trust gate is suppressed by the preset's CODEX_NON_INTERACTIVE anyway.
 * Left as-is, deliberately: NODE_REPL_TRUSTED_CODE_PATHS / NODE_REPL_TRUSTED_
 * SERVICES / NODE_REPL_NODE_PATH etc. reference the user's installed Codex
 * runtime and plugin cache — read-only inputs, documented as shared in
 * DEV-ISOLATION.md §8. Line-based on purpose: the file is simple TOML written
 * by Codex itself, and a full parser would add a dependency. Everything else
 * passes through verbatim so auth/model/MCP settings keep working.
 */
export interface CodexSeedOptions {
  /** The DEV agent's own CODEX_HOME — every nested `CODEX_HOME =` is REWRITTEN
   *  to this (not dropped: an absent key would let the helper fall back to the
   *  user's ~/.codex — Dwight re-audit of 00bd99bc). */
  codexHome: string;
  /** Suffix appended to every named-pipe value (`\\.\pipe\…`) so helper pipes
   *  such as SKY_CUA_NATIVE_PIPE_DIRECTORY are DEV-distinct per agent instead of
   *  the same named identity Stable's helpers use. */
  pipeSuffix: string;
}

export interface CodexSeedResult {
  text: string;
  rewrittenHomes: number;
  rewrittenPipes: number;
  droppedTables: number;
}

/** TOML literal-string form for a Windows path (no escaping needed unless the
 *  value contains a single quote, which no Windows path can). */
function tomlLiteral(v: string): string {
  return v.includes("'") ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `'${v}'`;
}

export function sanitizeCodexConfigForDev(toml: string, opts: CodexSeedOptions): CodexSeedResult {
  const out: string[] = [];
  let rewrittenHomes = 0;
  let rewrittenPipes = 0;
  let droppedTables = 0;
  let skippingTable = false;
  // key = 'value' | key = "value"  — captures indent/key, quote char, body.
  const kv = /^(\s*[A-Za-z0-9_.-]+\s*=\s*)(['"])(.*)\2(\s*(?:#.*)?)$/;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      skippingTable = /^projects\s*[."']/.test(header[1].trim());
      if (skippingTable) { droppedTables++; continue; }
    } else if (skippingTable) {
      continue; // body of a dropped [projects.…] table
    }
    if (/^\s*CODEX_HOME\s*=/.test(line)) {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      out.push(`${indent}CODEX_HOME = ${tomlLiteral(opts.codexHome)}`);
      rewrittenHomes++;
      continue;
    }
    const m = kv.exec(line);
    if (m) {
      const body = m[3];
      // A named pipe in either quoting style: literal `\\.\pipe\x` or basic `\\\\.\\pipe\\x`.
      if (/^\\{2,4}\.\\{1,2}pipe\\{1,2}/.test(body) && !body.endsWith(opts.pipeSuffix)) {
        out.push(`${m[1]}${m[2]}${body}-${opts.pipeSuffix}${m[2]}${m[4]}`);
        rewrittenPipes++;
        continue;
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), rewrittenHomes, rewrittenPipes, droppedTables };
}

/** Window title for the dev build. Unchanged when isolation is off. */
export function devWindowTitle(base: string, dev: boolean = DEV_ISOLATION): string {
  if (!dev) return base;
  return base.includes('Munder Difflin')
    ? base.replace('Munder Difflin', 'Munder Difflin DEV')
    : `${base} [DEV]`;
}

/** F1 — where a Codex agent home may seed its credential from, or `null` when it
 *  must not be seeded at all.
 *
 *  v0.4.5 unconditionally links the user's GLOBAL `~/.codex/auth.json` into every
 *  per-agent CODEX_HOME (hive.ts installCodexHooks), which under MUNDER_DEV=1 hands a
 *  Dev agent a live, writable handle on the credential Stable also uses. `homedir()`
 *  is the OS home and DEV does not move it, so that source is the real global one in
 *  Dev exactly as in Stable. Under DEV it is therefore never a legal source: the Dev
 *  home is left without a credential, and a `codex login` run inside Dev writes a
 *  DEV-OWNED one into the agent's own `.codex`, which already lives under the dev
 *  data root.
 *
 *  Pure on purpose. This is the SOURCE decision only; the lstat/readlink/unlink EFFECT
 *  that migrates an already-linked home is `migrateCodexAuthLink` below, kept a
 *  separate function so the policy stays independently testable. Every use of a global
 *  credential source must flow through here — a second path reaching `homedir()`
 *  directly would bypass the policy silently. */
export function codexAuthSeedSource(opts: {
  userCodexHome: string;
  devIsolation?: boolean;
}): string | null {
  const dev = opts.devIsolation ?? DEV_ISOLATION;
  if (dev) return null;
  return join(opts.userCodexHome, 'auth.json');
}

/** Proof that a credential path is a legal place to DELETE a link from.
 *  `ok:false` carries the reason; every caller treats it as fail-closed. */
export type CodexAuthDestBound =
  | { ok: true; realParent: string }
  | { ok: false; reason: string };

/** F1 — prove `authDest` is confined to a DEV agent's own Codex home BEFORE anything
 *  is inspected or unlinked. `DEV_ISOLATION` is a MODE gate, not a containment proof:
 *  `installCodexHooks(dir)` derives the destination from `dir`, and `agentDir(id)`
 *  is a plain join with no containment check of its own, so a deletion primitive must
 *  not rest on ID sanitisation or an uncorrupted registry.
 *
 *  NO SECOND PATH-SECURITY MODEL: this reuses `normalizePath`, `canonicalPath` and
 *  `isInside` exactly as the rest of this module does. The one difference is
 *  deliberate and narrow — for THIS object, the destructive destination parent, the
 *  FORGIVING ERROR PATH is removed. `canonicalPath` catches any `realpathSync.native`
 *  failure, walks to the nearest existing ancestor and re-appends the unresolved tail,
 *  so a DANGLING parent symlink/junction would rebuild an apparently in-root lexical
 *  parent and pass a check it should fail. Here the parent must resolve for real, or
 *  the operation refuses.
 *
 *  The PARENT is resolved, never `authDest` itself: resolving the link would
 *  deliberately follow it to the outside target, the opposite of what is being proved.
 *  (`canonicalPath` is still right for the link TARGET in `migrateCodexAuthLink` — a
 *  broken target must stay classifiable. The fallback is fine when deciding what a link
 *  POINTS AT, and unacceptable when proving where we may DELETE.) */
export function codexAuthDestBound(opts: {
  authDest: string;
  devDataRoot: string;
  platform?: NodeJS.Platform;
}): CodexAuthDestBound {
  const platform = opts.platform ?? process.platform;
  const lib = platform === 'win32' ? win32 : posix;

  if (lib.basename(opts.authDest) !== 'auth.json') {
    return { ok: false, reason: `destination basename is not auth.json: ${opts.authDest}` };
  }

  // DIRECT realpath, no fallback. On this path the parent MUST already exist —
  // authDest cannot exist, and no unlink can be attempted, unless it does — so a
  // resolution failure here is never a normal case. It is ambiguity, and ambiguity
  // refuses. This is the branch a dangling parent reparse point lands in.
  const parent = lib.dirname(opts.authDest);
  let realParent: string;
  try {
    realParent = normalizePath(realpathSync.native(parent), platform);
  } catch (e) {
    return { ok: false, reason: `could not resolve the credential directory ${parent}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const agentsRoot = lib.join(opts.devDataRoot, 'hive', 'agents');
  // isInside() is true for an exact match, so strictness is spelled out: the agents
  // directory ITSELF is not a legal place to delete a credential from.
  const strict =
    isInside(realParent, agentsRoot, platform) &&
    canonicalPath(realParent, platform) !== canonicalPath(agentsRoot, platform);
  if (!strict) {
    return { ok: false, reason: `${realParent} is not inside a DEV agent home under ${agentsRoot}` };
  }
  return { ok: true, realParent };
}

/** What `migrateCodexAuthLink` did, or why it refused. A refusal is FAIL-CLOSED: the
 *  caller must block the Codex spawn rather than continue with a possibly-live
 *  external link. */
export type CodexAuthMigration =
  | { ok: true; action: 'skipped-not-dev' | 'absent' | 'preserved-regular' | 'preserved-inside-link' | 'removed-outside-link' }
  | { ok: false; reason: string };

/** F1 — remove a pre-existing link from a DEV agent's Codex home to a credential
 *  OUTSIDE the dev data root, and prove the result is safe.
 *
 *  This exists because the v0.4.5 seed only runs when `authDest` does NOT already
 *  exist, so changing the seed policy alone would leave every pre-existing Dev agent
 *  still linked while F1 reported success.
 *
 *  It is the ONLY deletion in F1, and it removes the LINK ENTRY ONLY. The resolved
 *  external target — the user's real credential — is never unlinked, never written,
 *  never read. On Windows, unlinking a file symlink removes the directory entry for
 *  the link, not the target.
 *
 *  Every failure and every unrecognised state returns `ok:false`. Nothing here throws
 *  for an expected condition, because a thrown error would be absorbed by the caller's
 *  best-effort catch and the spawn would continue — which is precisely the failure this
 *  is here to close. */
export function migrateCodexAuthLink(opts: {
  authDest: string;
  devDataRoot?: string;
  devIsolation?: boolean;
  platform?: NodeJS.Platform;
}): CodexAuthMigration {
  const dev = opts.devIsolation ?? DEV_ISOLATION;
  // Stable never enters this code. Not even to look.
  if (!dev) return { ok: true, action: 'skipped-not-dev' };

  const platform = opts.platform ?? process.platform;
  const lib = platform === 'win32' ? win32 : posix;
  const root = opts.devDataRoot ?? devDataRoot(platform);

  const bound = codexAuthDestBound({ authDest: opts.authDest, devDataRoot: root, platform });
  if (!bound.ok) return { ok: false, reason: bound.reason };

  let st;
  try {
    st = lstatSync(opts.authDest); // lstat, never stat: we classify the LINK, not its target.
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: true, action: 'absent' };
    return { ok: false, reason: `could not classify ${opts.authDest}: ${e instanceof Error ? e.message : String(e)}` };
  }

  // A regular file is a DEV-OWNED credential the user created by logging in inside
  // Dev. Preserve it — deleting it would log them out on every spawn.
  if (st.isFile()) return { ok: true, action: 'preserved-regular' };

  if (!st.isSymbolicLink()) {
    return { ok: false, reason: `${opts.authDest} is neither a regular file nor a symbolic link` };
  }

  let target: string;
  try {
    // A relative target resolves against the link's OWN directory, not the cwd.
    // canonicalPath (with its nearest-existing-ancestor fallback) is wanted here: a
    // DANGLING target must still be classifiable.
    target = canonicalPath(lib.resolve(lib.dirname(opts.authDest), readlinkSync(opts.authDest)), platform);
  } catch (e) {
    return { ok: false, reason: `could not read the link target of ${opts.authDest}: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (isInside(target, root, platform)) return { ok: true, action: 'preserved-inside-link' };

  try {
    unlinkSync(opts.authDest); // the LINK ENTRY only — never the resolved target.
  } catch (e) {
    return { ok: false, reason: `could not remove the external credential link ${opts.authDest}: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Postcondition, re-checked rather than assumed: absent, a regular file, or a link
  // that stays inside the dev root. Anything else refuses.
  try {
    const after = lstatSync(opts.authDest);
    if (after.isFile()) return { ok: true, action: 'removed-outside-link' };
    if (after.isSymbolicLink()) {
      const t2 = canonicalPath(lib.resolve(lib.dirname(opts.authDest), readlinkSync(opts.authDest)), platform);
      if (isInside(t2, root, platform)) return { ok: true, action: 'removed-outside-link' };
    }
    return { ok: false, reason: `an external credential link is still present at ${opts.authDest} after removal` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: true, action: 'removed-outside-link' };
    return { ok: false, reason: `could not verify ${opts.authDest} after removal: ${e instanceof Error ? e.message : String(e)}` };
  }
}
