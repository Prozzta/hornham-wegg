/**
 * L0-TERMMATRIX capture — real per-provider frames, from an ALREADY-TRUSTED cwd.
 *
 * WHY THIS IS SAFE WHERE THE ISOLATED-HOME ROUTE WAS NOT:
 *   - The provider's REAL config is used, so the CLI is already authenticated and
 *     the cwd is already trusted. NO CONSENT IS GIVEN AND NONE IS NEEDED.
 *   - `capacityScope.ts:66` shows the app defaults every agent to `~/.claude`, so a
 *     shared provider config is the product's STEADY STATE, not a race this probe
 *     introduces. My earlier objection was too strong and I am correcting it.
 *   - ENTER IS NEVER SENT. Not to a modal, not to a box, not once. If the screen is
 *     anything but a composer the run ABORTS without a keystroke, so a trust or ToS
 *     gate is refused by never being answered rather than by being recognised.
 *   - Env still via the product's buildPtyEnv + devIsolation STABLE_ENV_KEYS, gated.
 *
 * The clear key and the harmless key are applied FROM THE SAME STAGED BASELINE.
 */
const fs = require('fs');
const REPO = 'C:/Dunder/MunderDev';
const pty = require(REPO + '/node_modules/node-pty');
const loadTs = require(REPO + '/test/load-ts.cjs');
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');
const { STABLE_ENV_KEYS } = loadTs('src/main/devIsolation.ts');

const CWD = process.argv[2];
const OUT = process.argv[3];

const baseEnv = buildPtyEnv(process.env, process.env.PATH || '', {});
const ENV = {};
for (const [k, v] of Object.entries(baseEnv)) if (!STABLE_ENV_KEYS.includes(k)) ENV[k] = v;
const leak = Object.keys(ENV).filter((k) => STABLE_ENV_KEYS.includes(k));
if (leak.length) { console.error('LEAK CHECK FAILED: ' + leak.join(',')); process.exit(2); }

const plainOf = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** A composer, or not. Anything not positively a composer aborts the run. */
function isBox(plain) {
  const t = plain.toLowerCase();
  const gate = /trust the files|trust this workspace|running codex in a new folder|sign in with|select login method|terms of service|choose the text style|press enter to continue|enter to confirm/.test(t);
  if (gate) return false;
  return /shift\+tab|ctrl\+|\btry "|for shortcuts|\u276f\s*$|>\s*$/m.test(t);
}

function open(label, file, args) {
  let buf = '', lastAt = Date.now(), exited = false;
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: CWD, env: ENV });
  p.onExit(() => { exited = true; });
  p.onData((d) => { buf += d; lastAt = Date.now(); });
  const quiesce = (quiet = 1800, max = 30_000) => new Promise((r) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (exited || Date.now() - lastAt >= quiet || Date.now() - t0 > max) { clearInterval(tick); r(); }
    }, 150);
  });
  return { p, quiesce, isExited: () => exited, frame: () => buf, reset: () => { buf = ''; },
    send: (b) => p.write(b), kill: () => { try { p.kill(); } catch { /* gone */ } } };
}

async function capture(label, file, args) {
  const s = open(label, file, args);
  await s.quiesce();
  const boot = s.frame();
  if (s.isExited()) { s.kill(); return { label, aborted: 'exited during boot' }; }
  if (!isBox(plainOf(boot))) {
    s.kill();
    return { label, aborted: 'not a composer - aborted WITHOUT any keystroke',
      tail: plainOf(boot).split(/\r?\n/).filter((l) => l.trim()).slice(-8) };
  }
  const mark = 'ZQ' + Math.random().toString(36).slice(2, 8).toUpperCase() + 'QZ';
  s.reset(); await s.quiesce(900, 8000);
  const emptyFrame = s.frame();
  s.reset(); s.send(mark); await s.quiesce(900, 8000);
  const stagedFrame = s.frame();
  s.reset(); s.send('\x15'); await s.quiesce(900, 8000);          // branch A: the candidate
  const afterClear = s.frame();
  s.reset(); s.send(mark); await s.quiesce(900, 8000);            // re-stage
  const restaged = s.frame();
  s.reset(); s.send('\x1b[C'); await s.quiesce(900, 8000);        // branch B: harmless key
  const afterNoop = s.frame();
  s.kill();
  return { label, mark, frames: { boot, emptyFrame, stagedFrame, afterClear, restaged, afterNoop },
    bytes: { staged: stagedFrame.length, clear: afterClear.length, restaged: restaged.length, noop: afterNoop.length },
    markVisibleAfterClear: plainOf(afterClear).includes(mark),
    markVisibleAfterNoop: plainOf(afterNoop).includes(mark) };
}

(async () => {
  const NODE = process.execPath;
  const targets = [
    ['claude', 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', []],
    ['codex', NODE, ['C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js']],
    ['agy', 'C:\\Users\\FiercePC\\AppData\\Local\\agy\\bin\\agy.exe', []]
  ];
  const out = [];
  for (const [l, f, a] of targets) { process.stderr.write('capturing ' + l + '\n'); out.push(await capture(l, f, a)); }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  for (const r of out) console.log(r.label + ': ' + (r.aborted ? ('ABORTED - ' + r.aborted) :
    ('captured, bytes=' + JSON.stringify(r.bytes) + ' markAfterClear=' + r.markVisibleAfterClear + ' markAfterNoop=' + r.markVisibleAfterNoop)));
  process.exit(0);
})();
