'use strict';

/**
 * AGY 1.1.48 — THE HAND-MUTANT TABLE (design section 7.2), as a committed, re-runnable gate.
 *
 * WHY THIS FILE EXISTS. Every one of these mutations was killed as it was written, but in
 * throwaway scratchpad runners across five commits. That proves the tests were strong ON
 * THE DAY and proves nothing afterwards: nothing in the repository could reproduce it, and
 * a later refactor could quietly un-kill any of them. The design asks for a hand-mutant
 * TABLE; this is it, in one place, with the anchors kept next to the behaviour they pin.
 *
 * WHAT A RUN MEANS. Each entry damages ONE source file at a unique anchor, runs the named
 * suites, and requires the mutation to die AT ITS OWN NAMED ASSERTION - not merely to break
 * something. Three outcomes are failures and are reported as such:
 *   SURVIVED          the behaviour is unpinned; a test is missing or decorative.
 *   KILLED-ELSEWHERE  something failed, but not the assertion that claims to own this.
 *   ANCHOR-NOT-UNIQUE the anchor moved: the mutant is INERT, which is a run failure, never
 *                     a pass. (An inert mutant that silently "passes" is the worst case -
 *                     it reports strength that was never measured.)
 *
 * SAFETY. Every file is restored from the exact bytes read before the edit, and the run
 * ends by re-hashing every file it touched. A mutant runner killed mid-run STRANDS a
 * mutation in src/ - if that ever happens, `git status src` and `git checkout --` it.
 *
 * NOT part of `node --test`: it rewrites source files. Run it directly:
 *   node test/tools/agy-mutants.cjs            (all)
 *   node test/tools/agy-mutants.cjs D-7 N-3    (a subset, by id)
 * Exit code 0 = every mutant killed at its named assertion.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const f = (rel) => path.join(REPO, rel);

const NORM = f('src/main/capacityNormalize.ts');
const SCOPE = f('src/main/capacityScope.ts');
const RUNTIME = f('src/main/capacityRuntime.ts');
const STRIP = f('src/main/capacityStrip.ts');
const OWN = f('src/main/agyStatuslineOwnership.ts');
const SHIM = f('src/main/agyStatuslineShim.ts');
const WAKE = f('src/main/workerWake.ts');
const HIVE = f('src/main/hive.ts');
const USEHIVE = f('src/renderer/src/hooks/useHive.ts');

const SCHEMA = 'test/agy-capacity-schema.test.cjs';
const LEASE = 'test/agy-statusline-lease.test.cjs';
const SHIMT = 'test/agy-statusline-shim.test.cjs';
const TWOPOOL = 'test/agy-two-pool-ui.test.cjs';
const LIFECYCLE = 'test/agy-native-lifecycle.test.cjs';
const GUARD = 'test/hive-global-config-guard.test.cjs';

/**
 * The fifteen the design REQUIRES (D-1..D-15), then the ones the audits added (N-*).
 * `expect` is the assertion that must fail: the test's own name, matched loosely enough
 * to survive a reworded tail but tightly enough to name one behaviour.
 */
const TABLE = [
  // ── design 7.2, in its own order ──────────────────────────────────────────
  { id: 'D-1', file: NORM, tests: [SCHEMA, TWOPOOL],
    what: 'replace limitId with the provider id (collapses the two pools into one)',
    from: "    limitId: family,", to: "    limitId: 'antigravity' as AgyFamily,",
    expect: /GOLDEN 1\.2\.8|two pools|POOL KEY/i },
  { id: 'D-2a', file: NORM, tests: [SCHEMA],
    what: 'map EVERY model to gemini',
    from: "  return modelId.startsWith('Gemini ') ? 'gemini' : '3p';", to: "  return 'gemini';",
    expect: /MODEL|family|GOLDEN/i },
  { id: 'D-2b', file: NORM, tests: [SCHEMA],
    what: 'map EVERY model to 3p (a lowercase/slug id must NOT silently bind here)',
    from: "  return modelId.startsWith('Gemini ') ? 'gemini' : '3p';", to: "  return '3p';",
    expect: /MODEL|family|GOLDEN/i },
  { id: 'D-3', file: NORM, tests: [SCHEMA],
    what: 'numerical zero becomes a PROVIDER-ATTRIBUTED limit (claims a refusal agy never made)',
    from: "    providerReachedType: null,\n    ordinaryUsageAllowed: null,\n    planType: null\n  });",
    to: "    providerReachedType: (windows[`${family}-5h`].remainingPercent === 0 ? 'LIMIT' : null) as null,\n    ordinaryUsageAllowed: null,\n    planType: null\n  });",
    expect: /zero|RESERVE_ONLY|numerical/i },
  { id: 'D-4a', file: NORM, tests: [SCHEMA],
    what: 'accept an unknown FIFTH quota key',
    from: "  if (!exactKeys(quota, AGY_QUOTA_KEYS)) return drift('quota-keys');",
    to: "  if (!AGY_QUOTA_KEYS.every((k) => k in quota)) return drift('quota-keys');",
    expect: /quota|ALL-OR-NOTHING|key/i },
  { id: 'D-4b', file: NORM, tests: [SCHEMA],
    what: 'accept a MISSING family (publish half a reading)',
    from: "  if (!exactKeys(quota, AGY_QUOTA_KEYS)) return drift('quota-keys');", to: "",
    expect: /quota|ALL-OR-NOTHING|key/i },
  { id: 'D-5', file: SCOPE, tests: [SCHEMA],
    what: 'derive the account scope from the EMAIL instead of the home path',
    from: 'export function agyAccountScope(', to: 'export function agyAccountScope_unused(',
    expect: /scope|email|home/i, alsoNeeds: 'compile-break' },
  { id: 'D-6', file: STRIP, tests: [TWOPOOL],
    what: "one family's freshness/latch overwrites its sibling",
    from: "    const key = pool.poolKey;",
    to: "    const key = pool.provider === 'antigravity' ? `${pool.provider}:${pool.accountScope}` : pool.poolKey;",
    expect: /sibling|independen|THE OTHER POOL|only the pool that moved/i },
  { id: 'D-7', file: RUNTIME, tests: [TWOPOOL],
    what: 'map the agent after only ONE observation was accepted',
    from: "    if (agentId && coherent && ra.accepted && rb.accepted) {",
    to: "    if (agentId && coherent && (ra.accepted || rb.accepted)) {",
    expect: /BOTH pools ingested|accepted|half/i },
  { id: 'D-8', file: OWN, tests: [LEASE],
    what: 'unconditional shutdown restore OVER an external user edit',
    from: "  if (!present || !isOurs(current, j.installedValue)) {", to: "  if (false) {",
    expect: /external edit|not ours|never overwrit/i },
  { id: 'D-9', file: OWN, tests: [LEASE],
    what: 'discard the original prior scalar while adopting a crash leftover',
    from: "          const next: StatuslineJournal = { ...j, phase: 'owned', leases: [...liveLeases(env, j), lease] };",
    to: "          const next: StatuslineJournal = { ...j, phase: 'owned', prior: { present: true, value: current }, leases: [...liveLeases(env, j), lease] };",
    expect: /adopt|prior|crash|restore/i },
  { id: 'D-10', file: OWN, tests: [LEASE],
    what: 'break multi-instance LAST-lease restoration (first one out restores)',
    from: "    const rest = liveLeases(env, j).filter((l) => l.id !== leaseId);\n    if (rest.length) {\n      writeJournal(paths.journal, { ...j, leases: rest });\n      return 'released';\n    }",
    to: "    const rest = [];",
    expect: /lease|multi|last|instance/i },
  { id: 'D-11', file: SHIM, tests: [SHIMT],
    what: 'remove the shim connect/absolute deadline (it can hang the statusline)',
    from: "  var deadline = setTimeout(function () {", to: "  var deadline = setTimeout(function () { if (0) {",
    expect: /deadline|timeout|fast|exit 0/i },
  { id: 'D-12', file: USEHIVE, tests: [LIFECYCLE],
    what: 'restore Antigravity PostInvocation -> idle (the UI/main split-brain)',
    from: "        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });\n      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {",
    to: "        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });\n      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {",
    expect: /PostInvocation no longer asserts idle/ },
  { id: 'D-13a', file: WAKE, tests: [LIFECYCLE],
    what: 'map RUNNING to idle',
    from: "    if (status === 'idle') {\n      if (r.activeSince > 0",
    to: "    if (status === 'idle' || status === 'running') {\n      if (r.activeSince > 0",
    expect: /MEASURED SEQUENCE|TOOL_USE without a confirmation/ },
  { id: 'D-13b', file: WAKE, tests: [LIFECYCLE],
    what: 'map CONFIRMATION to idle',
    from: "    if (status === 'idle') {\n      if (r.activeSince",
    to: "    if (status === 'idle' || status === 'waiting_for_confirmation') {\n      if (r.activeSince",
    expect: /CONFIRMATION is BOTH active and a HITL hold/ },
  { id: 'D-14', file: WAKE, tests: [LIFECYCLE],
    what: 'let active + PTY silence pass wake reconciliation (D3 removed)',
    from: "      if (!(r.lifecycle === 'idle' || (r.lifecycle === 'unknown' && quiescent))) {",
    to: "      if (!(r.lifecycle === 'idle' || quiescent)) {",
    expect: /D3 REGRESSION/ },
  { id: 'D-15', file: WAKE, tests: [LIFECYCLE],
    what: 'associate a null-agent PERSONAL tick with a hive worker',
    from: "    if (!agentId) return false;\n    const r = this.rec(agentId);\n    if (sessionId) {",
    to: "    const r = this.rec(agentId ?? 'personal');\n    if (sessionId) {",
    expect: /A PERSONAL tick \(no agent id\) never touches a floor agent/ },

  // ── added by the audits; each one was a real hole or a real ruling ────────
  { id: 'N-1', file: WAKE, tests: [LIFECYCLE],
    what: 'AUDIT c4: remove the confirm grace (a stale idle double-types into a live turn)',
    from: "      if (r.lifecycle === 'active' && r.activeSince > 0 && at - r.activeSince < PROVIDER_IDLE_CONFIRM_MS) {\n        return false;\n      }\n",
    to: "", expect: /RACE REPLAY/ },
  { id: 'N-2', file: WAKE, tests: [LIFECYCLE],
    what: 'AUDIT c4: the grace requires a running tick first (re-creates the stall)',
    from: "if (r.lifecycle === 'active' && r.activeSince > 0 && at - r.activeSince < PROVIDER_IDLE_CONFIRM_MS)",
    to: "if (r.lifecycle === 'active' && r.sawRunning === true && at - r.activeSince < PROVIDER_IDLE_CONFIRM_MS)",
    expect: /RACE REPLAY/ },
  { id: 'N-3', file: NORM, tests: [LIFECYCLE, SCHEMA],
    what: 'AUDIT c4: believe a read_at in the FUTURE (clock skew buys a double-type)',
    from: "&& stamped <= input.receivedAt", to: "",
    expect: /READ_AT: the tick carries the SHIM/ },
  { id: 'N-4', file: SHIM, tests: [LIFECYCLE, SHIMT],
    what: 'AUDIT c4: the shim stops stamping read_at (the ordering guard goes blind)',
    from: "    read_at: Date.now(),\n", to: "",
    expect: /READ_AT: the shim stamps it|EXACT-KEY|envelope/i },
  { id: 'N-5', file: WAKE, tests: [LIFECYCLE],
    what: "RULING d: wire PreInvocation as a coordinator active edge",
    from: "const ACTIVE_EVENTS = new Set(['UserPromptSubmit',",
    to: "const ACTIVE_EVENTS = new Set(['PreInvocation', 'UserPromptSubmit',",
    expect: /N9: PreInvocation is NOT a coordinator active edge/ },
  { id: 'N-6', file: WAKE, tests: [LIFECYCLE],
    what: 'AUDIT c4: a Stop with fullyIdle:false is terminal after all',
    from: "      if (fullyIdle === false) return false;   // the provider says the turn is not over\n",
    to: "", expect: /STOP FALLBACK/ },
  { id: 'N-7', file: STRIP, tests: [TWOPOOL],
    what: 'RATIFIED RULE: show both rows unconditionally (the lazy row rule removed)',
    from: "    if (pool.provider !== 'antigravity') return true;", to: "    return true;",
    expect: /HIDDEN AT START|CONSUMPTION reveals only the pool that moved/ },
  { id: 'N-9', file: STRIP, tests: [TWOPOOL],
    what: 'AUDIT c3-1: the lastRemainder memory is NOT pruned when a pool leaves',
    from: "    for (const k of [...this.lastRemainder.keys()]) if (!live.has(k)) this.lastRemainder.delete(k);\n",
    to: "", expect: /A POOL THAT LEAVES AND RETURNS starts clean/ },
  // N-10 is the c3 EQUIVALENCE, re-measured one level deeper. Weakening the override ALONE
  // is invisible because the ratified gating rule (1b) reveals the row anyway - the same
  // subsumption god accepted at c3. So the mutant that must die is the one that gates BOTH
  // on freshness, which is what would actually lose the guarantee. Recorded as two entries
  // so the pair is re-measured on every run instead of being taken on trust.
  { id: 'N-10a', file: STRIP, tests: [TWOPOOL], equivalent: true,
    what: 'AUDIT c3-3: freshness-gate the OVERRIDE only - EQUIVALENT, gating rule 1b carries it',
    from: "    if (blocking && gating) { this.moving.add(key); return true; }",
    to: "    if (blocking && gating && pool.freshness === 'FRESH') { this.moving.add(key); return true; }",
    expect: /SAFETY OVERRIDE holds for a STALE limiting pool/ },
  { id: 'N-10b', file: STRIP, tests: [TWOPOOL],
    what: 'AUDIT c3-3: freshness-gate BOTH the override and gating - the guarantee is then lost',
    from: "    if (blocking && gating) { this.moving.add(key); return true; }\n\n    // GATING: a live agent draws on this family (ratified rule 1b).\n    if (gating) { this.moving.add(key); return true; }",
    to: "    if (blocking && gating && pool.freshness === 'FRESH') { this.moving.add(key); return true; }\n\n    if (gating && pool.freshness === 'FRESH') { this.moving.add(key); return true; }",
    expect: /SAFETY OVERRIDE holds for a STALE limiting pool/ },
  { id: 'N-8', file: HIVE, tests: [GUARD],
    what: "GUARD: write the user's GLOBAL config for a home that is not the live one",
    from: "  private mayWriteGlobalConfig(", to: "  private mayWriteGlobalConfig_unused(",
    expect: /global|guard|refus/i, alsoNeeds: 'compile-break' }
];

// ─── runner ─────────────────────────────────────────────────────────────────

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = only.length ? TABLE.filter((m) => only.includes(m.id)) : TABLE;
if (!chosen.length) {
  console.error(`no mutants matched ${only.join(' ')}; ids: ${TABLE.map((m) => m.id).join(' ')}`);
  process.exit(2);
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const touched = [...new Set(chosen.map((m) => m.file))];
const baseline = Object.fromEntries(touched.map((p) => [p, sha(p)]));

const results = [];
for (const m of chosen) {
  const original = fs.readFileSync(m.file, 'utf8');
  const crlf = original.includes('\r\n');
  const norm = original.replace(/\r\n/g, '\n');
  if (norm.split(m.from).length !== 2) {
    results.push({ ...m, verdict: 'ANCHOR-NOT-UNIQUE', failed: [] });
    continue;
  }
  let mutated = norm.replace(m.from, m.to);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  fs.writeFileSync(m.file, mutated);
  let failed = [];
  let ran = false;
  try {
    const r = spawnSync(process.execPath, ['--test', ...m.tests], {
      cwd: REPO, encoding: 'utf8', timeout: 900_000
    });
    ran = true;
    failed = (r.stdout || '').split('\n')
      .filter((l) => /^not ok \d+ - /.test(l))
      .map((l) => l.replace(/^not ok \d+ - /, '').trim());
    // A mutation that breaks the BUILD (a renamed export) can only fail as a load error;
    // that still counts, but it is recorded so nobody mistakes it for an assertion.
    if (!failed.length && r.status !== 0 && m.alsoNeeds === 'compile-break') {
      failed = ['(module failed to load - the export it needs is gone)'];
    }
  } finally {
    fs.writeFileSync(m.file, original);
  }
  const restored = sha(m.file) === baseline[m.file];
  const named = failed.some((n) => m.expect.test(n));
  // A mutant DECLARED equivalent must survive: it is one half of a subsuming pair, kept in
  // the table so the subsumption is re-measured on every run rather than taken on trust.
  // If one ever starts dying, the rules have become independent and the note is stale -
  // which is a finding, so it is reported as a failure in that direction too.
  const verdict = !restored ? 'RESTORE-FAILED'
    : !ran ? 'RUN-FAILED'
      : m.equivalent ? (failed.length ? 'EQUIVALENT-NOW-DIES' : 'EQUIVALENT (expected)')
        : named ? 'KILLED'
          : failed.length ? 'KILLED-ELSEWHERE' : 'SURVIVED';
  results.push({ ...m, failed, verdict });
}

let bad = 0;
for (const r of results) {
  const ok = r.verdict === 'KILLED' || r.verdict === 'EQUIVALENT (expected)';
  if (!ok) bad += 1;
  console.log(`${r.verdict.padEnd(18)} ${r.id.padEnd(6)} ${r.what}`);
  const hit = r.failed.find((n) => r.expect.test(n));
  console.log(`                          ${hit ? `named: ${hit}` : `failed: ${r.failed.join(' | ') || '(none)'}`}`);
}
const drift = touched.filter((p) => sha(p) !== baseline[p]);
console.log('');
console.log(drift.length
  ? `SOURCE DRIFT - RESTORE BY HAND: ${drift.join(', ')}`
  : `all ${touched.length} source file(s) restored to their original hashes`);
const eq = results.filter((r) => r.verdict === 'EQUIVALENT (expected)').length;
console.log(`${results.length - bad}/${results.length} accounted for`
  + ` (${results.length - bad - eq} killed at a named assertion, ${eq} measured-equivalent)`);
process.exit(bad === 0 && drift.length === 0 ? 0 : 1);
