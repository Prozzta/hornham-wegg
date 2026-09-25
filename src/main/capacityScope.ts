/**
 * Account scope for capacity pools.
 *
 * WHY THIS EXISTS. A pool is a provider-ACCOUNT/limit identity. Neither provider
 * hands us an account identifier: Claude's status line has no account field at all,
 * and Codex's rate-limit snapshot carries a limit id but not a login. Keying on the
 * provider alone would merge two accounts of one provider into one pool and
 * understate consumption on both, so an account discriminator has to come from
 * somewhere — and the only thing that actually distinguishes two accounts on this
 * machine is WHICH CREDENTIAL LOCATION the session authenticates from.
 *
 * CREDENTIAL BYTES ARE NEVER READ. These functions look at PATHS only, and publish
 * a truncated hash of a path rather than the path itself, so a pool key can be
 * logged, pushed to a renderer or written to a note without carrying a home
 * directory or a filename. Resolving a symlink is a path operation: two agent homes
 * whose `auth.json` links to the same target are the same account and must share a
 * pool, which is exactly the behaviour F1's linking already assumes.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether path CASE distinguishes two locations on this machine.
 *
 * Platform is an approximation of a filesystem property - a case-sensitive volume
 * can be mounted on Windows, and macOS can be formatted case-sensitive - but it is
 * the honest default: Windows and macOS ship case-insensitive, Linux does not.
 * Probing the actual volume would mean creating a file to see what comes back, and
 * this module does not touch the filesystem beyond resolving a path.
 */
const caseInsensitiveFs = (): boolean => process.platform === 'win32' || process.platform === 'darwin';

/**
 * Short, stable, non-reversible. Long enough that two homes will not collide.
 *
 * CASE IS FOLDED ONLY WHERE THE FILESYSTEM FOLDS IT. Lowercasing unconditionally
 * made `/home/Alice/.codex` and `/home/alice/.codex` one scope, and on a
 * case-sensitive filesystem those are two directories that can hold two different
 * credentials - so two accounts MERGED INTO ONE POOL and each understated the
 * other's consumption. Where the filesystem itself is case-insensitive the fold is
 * required for the opposite reason: there one account would otherwise split into
 * two pools depending on how a path happened to be typed.
 */
function scopeHash(path: string): string {
  const key = caseInsensitiveFs() ? path.toLowerCase() : path;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Resolve through symlinks where possible; the unresolved path is a fine fallback. */
function resolved(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Claude's account scope.
 *
 * LIMITATION, STATED RATHER THAN HIDDEN: Claude Code exposes no account identity to
 * an integration, so this is the config directory the sessions authenticate from.
 * Every Claude session sharing that directory is treated as one pool. That is
 * correct for the single-subscription case this hive runs, and it is the thing to
 * revisit first if Munder ever drives two Claude accounts at once.
 */
export function claudeAccountScope(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return scopeHash(resolved(dir));
}

/**
 * Codex's account scope, from the CODEX_HOME a worker was launched with.
 *
 * The credential inside that home decides the identity: under ordinary operation
 * the per-agent home's `auth.json` is a link to the user's global credential, so
 * every agent resolves to one scope and one pool. Under MUNDER_DEV=1 the Dev home
 * holds its own credential and resolves to a DIFFERENT scope, which is the correct
 * answer — Dev authenticates as a different identity and must not pool with the
 * user's real allowance.
 *
 * Only the path is touched. Nothing opens the file.
 */
export function codexAccountScope(codexHome: string): string {
  const auth = join(codexHome, 'auth.json');
  return scopeHash(existsSync(auth) ? resolved(auth) : resolved(codexHome));
}

/**
 * The Gemini home Antigravity reads its configuration and credential from.
 *
 * `GEMINI_CLI_HOME` when it is set to something non-blank, otherwise `~/.gemini`.
 * The same resolution the statusline-ownership code uses for the settings file, so
 * "which account" and "whose settings" can never disagree about the directory.
 */
export function geminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_CLI_HOME?.trim() || join(homedir(), '.gemini');
}

/**
 * Antigravity's account scope: a hash of the resolved Gemini home PATH, and nothing else.
 *
 * THE STATUSLINE CARRIES THE ACCOUNT'S EMAIL, and it is deliberately not used - not
 * accepted, not hashed, not retained. A hash of an email is still a stable identifier of
 * a person, and it would travel into logs, pool keys and the durable store. The home
 * directory is what actually distinguishes two accounts on this machine (the same rule
 * Claude and Codex follow), and hashing a path discloses nothing about who is signed in.
 * Case folding and symlink resolution are the shared rules above, so two spellings of
 * one home are one pool and two homes are two.
 */
export function agyAccountScope(env: NodeJS.ProcessEnv = process.env): string {
  return scopeHash(resolved(geminiHome(env)));
}
