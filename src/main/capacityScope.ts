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

/** Short, stable, non-reversible. Long enough that two homes will not collide. */
function scopeHash(path: string): string {
  return createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 12);
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
