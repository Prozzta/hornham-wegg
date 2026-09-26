# WAKE-155 notes

Baseline: `origin/release-1.1.53` at `79ee6b91d35de5ecaf2b0947929e22251cc95d24`; branch: `wake-155`.

## Codex false confirmation

The delayed `task_complete` was about the pre-wake turn. It must never confirm the
provisional wake epoch. Confirmation now requires a distinct `task_started` whose
timestamp follows the committed epoch, and records its turn id. A Codex-only recovery
recognises the old non-provisional legacy state when its completion predates the active
epoch, restores the bounded provisional path, and re-pends the committed ids once.

## Retained self draft

The submit owner remembers only its own last committed text, incarnation, and human
generation. On a retry, it re-presses Enter only when the rendered current logical
composer tail exactly matches that text and the generation is unchanged. It uses the
existing non-yielding commit section; anything else remains an interference hold.
Screen-reading IPC now carries that optional attestation. A pending `held-interfered`
state is no longer excluded from the five-minute wake-stall diagnostic.

## First Enter evidence

The recorded owner outcome proves only that the PTY write accepted `\r`; the available
log has no TUI-level submit acknowledgement. It therefore cannot distinguish a swallowed
first Enter from provider-side composer retention. This patch does not claim one: it
adds the positive composer-tail proof and a single guarded retry, while retaining the
human-interference fail-closed path.

## Verification

- New regressions fail on the 1.1.53 baseline for delayed Codex completion, legacy
  false-active recovery, retained self draft, held-state surfacing, and tail-attestation
  transport.
- Passed: `node --test test/automatic-submit-wiring.test.cjs test/wake-confirm-153.test.cjs test/wake-stall.test.cjs` (119 tests).
- Passed: `npm run typecheck`.
- Required `npm ci` installed dependencies but its concurrent native rebuild saw an
  `node-pty\\build` lock; no process was killed. The normal postinstall patch was then
  run and the required markers were asserted: postinstall marker, win32 pty prebuild,
  and win32 ConPTY prebuild.
- No Electron desktop launch, package cut, or push was performed.
