'use strict';
/**
 * Announce that a test file is INERT in this environment, where a reader will see it.
 *
 * WHY. `node --test` reports a skipped SUITE under `# suites` and a whole framework-less
 * file under `# tests` — neither ever reaches `# skipped`. So a gate that could not run
 * (no build present, wrong platform) produced `tests 0 / fail 0 / skipped 0`, or a bare
 * `ok 1`, which is identical in every number anyone actually checks to a gate that ran and
 * held. That is the same silent-nothing class as the 1.1.46 wake stall: an absence that
 * reads as health.
 *
 * The fix is deliberately about VISIBILITY, not policy. An inert file is still not a
 * failure — a source-only checkout should not go red, and POSIX group semantics genuinely
 * do not apply on win32 — so this registers one skipped test carrying the reason, which
 * lands in `# skipped` where it can be seen.
 *
 * `test` is injected so the registration itself is testable without spawning anything.
 */
function announceInert(name, reason, { test = require('node:test') } = {}) {
  if (!name) throw new Error('announceInert needs a name');
  if (!reason) throw new Error('announceInert needs a reason — an unexplained skip is the bug it is fixing');
  test(name, { skip: reason }, () => {});
}

module.exports = { announceInert };
