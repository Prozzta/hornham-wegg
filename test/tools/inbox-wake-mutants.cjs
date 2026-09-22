'use strict';

/**
 * Mutant runner for the pre-M1 event-wake bridge (plan section D). Each mutant injects ONE
 * named regression into ONE source file, runs the wake test files, and must turn them RED.
 * The file is always restored in `finally`. An anchor that is missing or not unique is
 * INERT and counts as a failure of the run. Same engine as capacity-mutants.cjs.
 *
 * Usage (from the repo root):
 *   node test/tools/inbox-wake-mutants.cjs            run all
 *   node test/tools/inbox-wake-mutants.cjs <prefix>   run the mutants whose name starts with <prefix>
 * Exit 0 only when every selected mutant was killed. NOT a *.test.cjs file: it rewrites sources.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS = ['test/hive-event-router.test.cjs', 'test/worker-wake.test.cjs', 'test/inbox-wake-bridge.test.cjs',
  'test/inbox-wake-pins.test.cjs', 'test/control.test.cjs', 'test/automatic-submit-wiring.test.cjs',
  'test/wake-cold-boot.test.cjs'];

const INDEX = 'src/main/index.ts';
const WAKE = 'src/main/workerWake.ts';
const BRIDGE = 'src/main/inboxWakeBridge.ts';
const HIVE = 'src/main/hive.ts';
const CONTROL = 'src/main/control.ts';
const USE_HIVE = 'src/renderer/src/hooks/useHive.ts';

const MUTANTS = [
  // ── the six regressions the card names ──
  ['w the god exclusion comes back to reconciliation (agentId === reg.godId)', INDEX,
    '    .filter(([agentId, a]) => !a?.archived && ptyForAgent(agentId))',
    '    .filter(([agentId, a]) => !(agentId === reg.godId) && !a?.archived && ptyForAgent(agentId))'],
  ['w isGod comes back to the coordinator', WAKE,
    "    if (r.inFlight) return no('in-flight');",
    "    if ((f as { isGod?: boolean }).isGod) return no('is-god');\n    if (r.inFlight) return no('in-flight');"],
  ['w a direct PTY write in the wake path', INDEX,
    '  submit: (req) => automaticSubmit.submit(req),',
    "  submit: (req) => { ptyManager.write(ptyForAgent(req.agentId) ?? '', `${req.text}\\r`, 'PROGRAMMATIC'); return Promise.resolve({ kind: 'COMMITTED' }); },"],
  ['w ids announced at claim time, before COMMITTED', WAKE,
    '    r.pending.clear();\n', '    r.pending.clear();\n    for (const id of ids) r.announced.add(id);\n'],
  ['w the renderer inbox-wake producer (useHive effect #3) comes back', USE_HIVE,
    '  // 3) REMOVED (pre-M1 event-wake bridge).',
    "  useEffect(() => {\n    const iv = setInterval(async () => {\n      for (const a of useStore.getState().agents) {\n        const inbox = await window.cth.hiveInbox(a.id);\n        if (inbox.length) useStore.getState().enqueueMessage(a.id, 'wake', { precondition: 'inbox-nonempty' });\n      }\n    }, 4000);\n    return () => clearInterval(iv);\n  }, []);\n  // 3) REMOVED (pre-M1 event-wake bridge)."],
  ['w a second submit inside the reconciliation beat', INDEX,
    '  inboxWake.reconcileAll(live);\n',
    "  inboxWake.reconcileAll(live);\n  for (const id of live) void automaticSubmit.submit({ requestId: `wake-${id}`, agentId: id, admissionClass: 'CAPACITY_GATED', text: 'wake' });\n"],
  // ── the state machine ──
  ['w INTERFERED is retried automatically', WAKE,
    '      r.held = claim;                  // no automatic retry until a human rules',
    '      for (const id of claim.ids) r.pending.add(id);'],
  ['w a refused wake spends its ids', WAKE,
    '      for (const id of claim.ids) if (!r.announced.has(id)) r.pending.add(id);\n    }\n  }',
    '      for (const id of claim.ids) r.announced.add(id);\n    }\n  }'],
  ['w SubagentStop turns an active main agent idle', WAKE,
    "    if (event === 'SubagentStop') return r.lifecycle === 'idle';",
    "    if (event === 'SubagentStop') { r.lifecycle = 'idle'; return true; }"],
  ['w event mode accepts no idle evidence', WAKE,
    "      if (r.lifecycle !== 'idle') return no(`lifecycle-${r.lifecycle}`);\n", ''],
  ['w D3 reverted: an ACTIVE agent is claimed on PTY quiescence', WAKE,
    "      if (!(r.lifecycle === 'idle' || (r.lifecycle === 'unknown' && quiescent))) {",
    "      if (r.lifecycle !== 'idle' && !quiescent) {"],
  ['w D3 over-tightened: unknown + quiescent no longer recovers', WAKE,
    "      if (!(r.lifecycle === 'idle' || (r.lifecycle === 'unknown' && quiescent))) {",
    "      if (r.lifecycle !== 'idle') {"],
  ['w a second claim while one is in flight', WAKE,
    "    if (r.inFlight) return no('in-flight');\n",
    ''],
  ['w a duplicate delivery id becomes pending again', WAKE,
    '    if (this.known(r, messageId)) return false;\n', ''],
  ['w the claim is enlarged by mail arriving in flight', WAKE,
    '    r.pending.add(messageId);\n    return true;',
    '    r.pending.add(messageId);\n    if (r.inFlight) (r.inFlight.ids as string[]).push?.(messageId);\n    return true;'],
  ['w a stale outcome settles the current claim', WAKE,
    '    if (!r || r.inFlight?.requestId !== claim.requestId) return;',
    '    if (!r) return;'],
  ['w ALREADY_HANDLED submits again', BRIDGE,
    "    if (this.deps.coordinator.resolveInterference(agentId, how) && how === 'SEND_AGAIN') {",
    '    if (this.deps.coordinator.resolveInterference(agentId, how)) {\n      this.deps.coordinator.resolveInterference(agentId, how);\n      this.deps.coordinator.reconcile(agentId, []);\n      this.deps.coordinator.noteDelivery(agentId, `${agentId}-again`);'],
  ['w the bridge skips the authoritative inbox re-read', BRIDGE,
    '    coordinator.reconcile(agentId, ids);\n', ''],
  ['w events are not coalesced per agent per turn', BRIDGE,
    "    if (this.scheduled.has(agentId)) { this.deps.diag?.('schedule', { agentId, cause, took: 'coalesced' }); return; }\n",
    ''],
  ['w a Stop no longer retries pending work', WAKE,
    "    if (event === 'Stop') { r.lifecycle = 'idle'; return true; }",
    "    if (event === 'Stop') { r.lifecycle = 'idle'; return false; }"],
  // ── the router and the control edges ──
  ['w the delivery edge fires before the durable write', HIVE,
    "    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);\n    // THE successful-delivery edge",
    "    try { this.deliveryObserver?.({ agentId: toId, messageId: msg.id }); } catch { /* */ }\n    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);\n    // THE successful-delivery edge"],
  ['w a watch hint no longer schedules a scan', HIVE,
    '        const w = this.routerRuntime.watch(dir, () => this.scheduleRouteOnce());',
    '        const w = this.routerRuntime.watch(dir, () => {});'],
  ['w hints are not coalesced into one scan', HIVE,
    '    if (this.routeQueued || !this.routerTimer) return;',
    '    if (!this.routerTimer) return;'],
  ['w the interval no longer repairs watchers', HIVE,
    '      try { this.refreshOutboxWatchers(); this.routeOnce(); } catch { /* keep the loop alive */ }',
    '      try { this.routeOnce(); } catch { /* keep the loop alive */ }'],
  ['w a same-value control setter emits a transition', CONTROL,
    '    if (c.paused === on) return;\n', ''],
  ['w a capacity change is no longer a retry hint (the merged onChange drops it)', INDEX,
    'onChange: () => { pushCapacityStrip(); pushAgentUsage(); pushAgentImpact(); inboxWake?.onCapacityChange(); }',
    'onChange: () => { pushCapacityStrip(); pushAgentUsage(); pushAgentImpact(); }'],
  ['w the delivery observer is never registered', INDEX,
    '  inboxWake?.onDelivery(agentId, messageId);',
    '  void 0;'],
  // GATE-2: the cold-boot deadlock that stalled the packaged 1.1.46 floor. Counting a
  // CLI's boot SessionStart as an active turn makes a never-prompted agent permanently
  // unclaimable, because only a Stop it can never emit clears the label.
  ['w SessionStart is an active turn again (the 1.1.46 cold-boot deadlock)', WAKE,
    "const ACTIVE_EVENTS = new Set(['UserPromptSubmit'",
    "const ACTIVE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit'"],
  ['w a session boundary no longer clears a stale active label', WAKE,
    "    if (event === 'SessionStart' || event === 'SessionEnd') { r.lifecycle = 'unknown'; return false; }",
    "    if (event === 'SessionEnd') { r.lifecycle = 'unknown'; return false; }"]
];

// THE BASELINE MUST BE GREEN.
const baseline = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8' });
if (baseline.status !== 0) {
  console.log('BASELINE RED: the unmutated wake tests fail, so no mutant result would mean anything.');
  process.exit(2);
}

const only = process.argv[2];
const selected = MUTANTS.filter(([name]) => !only || name.startsWith(only));
let killed = 0;
let inert = 0;
for (const [name, file, from, to] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    fs.writeFileSync(abs, mutated);
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
  } finally {
    fs.writeFileSync(abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
