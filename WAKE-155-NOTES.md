# WAKE-155 notes

Baseline: `origin/release-1.1.54` at `4854278bf5f7377da32b1ff5d6635365eaa82f13`; branch: `wake-155`.

## Codex false confirmation

The delayed `task_complete` was about the pre-wake turn. It must never confirm the
provisional wake epoch. Confirmation now requires a distinct `task_started` at or after
the wake claim (so a real start observed before asynchronous settle is retained), and
records its turn id. A Codex-only recovery
recognises the old non-provisional legacy state when its completion predates the active
epoch, restores the bounded provisional path, and re-pends the committed ids once.

## Retained self draft

The submit owner remembers only its own last committed text, incarnation, and human
generation. On a retry, it re-presses Enter only when the rendered composer region from
its prompt marker through the cursor exactly matches that text after TUI border and
whitespace normalization, and the generation is unchanged. This covers explicit Ink and
ratatui row breaks as well as xterm soft wraps. It uses the
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

- New regressions fail before C1/C2 for explicit TUI composer rows and a genuine Codex
  `task_started` between claim and settle, respectively.
- Passed: `node --test test/composer-attestation.test.cjs test/automatic-submit-wiring.test.cjs test/wake-confirm-153.test.cjs test/wake-stall.test.cjs` (122 tests).
- Passed: `npm run typecheck`.
- Required `npm ci` installed dependencies but its concurrent native rebuild saw an
  `node-pty\\build` lock; no process was killed. The normal postinstall patch was then
  run and the required markers were asserted: postinstall marker, win32 pty prebuild,
  and win32 ConPTY prebuild.
- No Electron desktop launch, package cut, or push was performed.
