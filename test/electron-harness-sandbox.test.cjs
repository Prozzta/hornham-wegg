'use strict';

/**
 * THE HARNESS LEAVES NOTHING BEHIND - and says so loudly when it cannot help it.
 *
 * Every Electron harness child gets a throwaway `userData`. Until this test existed the
 * CHILD deleted it on the way out, inside a swallowed `catch`; on Windows its own Chromium
 * handles were still open, so the delete failed every time and nothing said so. About 1,400
 * directories and 14 GB had built up in %TEMP% when it was noticed (L0 milestone record,
 * item 10, finding F1). The lifecycle now belongs to the PARENT (electron-harness/run.cjs):
 * create, hand to the child, remove after the child has EXITED with a bounded retry, and
 * REJECT the run - naming the path - if the directory is still there.
 *
 * Each real run here is given a PRIVATE temp root, because other harness test files run in
 * parallel with this one and share os.tmpdir(): counting the shared directory would measure
 * them, not us.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const run = require('./electron-harness/run.cjs');
const { readSource } = require('./read-source.cjs');

const privateRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'l0-leakcheck-'));

test('a scenario run leaves ZERO new directories in its temp root', async () => {
  const root = privateRoot();
  try {
    const r = await run.runScenario(path.join(__dirname, 'electron-harness', 'scenarios', 'render-capabilities.ts'), { tempRoot: root, timeoutMs: 60_000 });
    assert.equal(r.ok, true, `precondition: the scenario really ran: ${r.error ?? ''}`);
    assert.deepEqual(fs.readdirSync(root), [], 'NOTHING is left in the temp root after a harness run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an IPC-order run - including its real process-crash round - leaves ZERO new directories', async () => {
  const root = privateRoot();
  try {
    const r = await run.runIpcOrder({ phase1: 5, phase2: 5, phase3: 1, tempRoot: root });
    assert.ok(r && typeof r === 'object', 'precondition: the experiment reported');
    assert.deepEqual(fs.readdirSync(root), [], 'NOTHING is left in the temp root after an IPC-order run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a child that refuses to run without --sandbox: the parent, and only the parent, owns the directory', () => {
  for (const f of ['test/electron-harness/harness-main.cjs', 'test/electron-harness/ipc-order-main.cjs']) {
    const src = readSource(f);
    assert.ok(!/mkdtemp|rmSync|tmpdir/.test(src.replace(/\/\/.*$/gm, '')), `${f} neither creates nor deletes a temp directory`);
    assert.match(src, /const sandboxRoot = argOf\('sandbox', null\);\s*if \(!sandboxRoot\) \{[\s\S]*?process\.exit\(2\);/, `${f} refuses to run without one`);
  }
});

/** Hold a directory so that it CANNOT be removed: on Windows a live process's cwd. */
function holdDirectory(dir) {
  // The child SAYS when it is up, from inside the directory. Waiting for the `spawn` event
  // alone was not enough under a parallel full-suite run: the removal sometimes won the race.
  const child = spawn(process.execPath, ['-e', "process.stdout.write(process.cwd()); setInterval(() => {}, 1000)"], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}
const killed = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });

const K = {};

K.aSandboxThatCannotBeRemovedFailsLoudly = async (mod) => {
  const root = privateRoot();
  const dir = mod.createSandbox('l0-harness-', root);
  const holder = await holdDirectory(dir);
  try {
    await assert.rejects(mod.removeSandbox(dir, 3, 50), (e) => {
      assert.match(e.message, /HARNESS SANDBOX LEAK/, 'A LEFTOVER SANDBOX IS AN ERROR, NOT A SHRUG');
      assert.ok(e.message.includes(dir), 'and the error names the path, so a person can find it');
      return true;
    }, 'a sandbox that is still on disk after the retries REJECTS - it is never swallowed');
    assert.equal(fs.existsSync(dir), true, 'precondition: the directory really could not be removed');
  } finally {
    await killed(holder);
    await run.removeSandbox(root, 50, 100); // the REAL remover, never the module under test
  }
};

K.theRetryOutlastsAHandleThatIsReleasedLate = async (mod) => {
  const root = privateRoot();
  const dir = mod.createSandbox('l0-harness-', root);
  const holder = await holdDirectory(dir);
  try {
    setTimeout(() => holder.kill(), 400); // the way Windows releases a dead child's handles: a moment AFTER `close`
    await mod.removeSandbox(dir, 50, 100);
    assert.equal(fs.existsSync(dir), false, 'THE BOUNDED RETRY removes a directory whose handle is released late - which is the real Windows case');
  } finally {
    // Clean up with the REAL remover, never the module under test: a mutant must not be able
    // to turn this test's own tidy-up into the error that gets reported.
    if (holder.exitCode === null && holder.signalCode === null) await killed(holder);
    await run.removeSandbox(root, 50, 100);
  }
};

for (const [name, killer] of Object.entries(K)) {
  test(`sandbox removal: ${name}`, (t) => {
    if (process.platform !== 'win32') { t.skip('holding a directory open by cwd is a Windows behaviour'); return undefined; }
    return killer(run);
  });
}

const MUTANTS = [
  { name: 'the leak swallowed again (the original defect)',
    edits: [['  throw new Error(`HARNESS SANDBOX LEAK:', '  return; throw new Error(`HARNESS SANDBOX LEAK:']],
    killer: 'aSandboxThatCannotBeRemovedFailsLoudly', dies: /REJECTS - it is never swallowed/ },
  { name: 'one attempt, no retry',
    edits: [['  for (let i = 0; i < attempts; i += 1) {', '  for (let i = 0; i < 1; i += 1) {']],
    killer: 'theRetryOutlastsAHandleThatIsReleasedLate', dies: /HARNESS SANDBOX LEAK/, byError: true }
];

test('MUTANT CENSUS (run.cjs): every mutant applies exactly once and is killed', async (t) => {
  if (process.platform !== 'win32') { t.skip('the killers are Windows-only'); return; }
  const source = readSource('test/electron-harness/run.cjs');
  for (const [i, mutant] of MUTANTS.entries()) {
    await t.test(`mutant: ${mutant.name}`, async () => {
      let text = source;
      for (const [from, to] of mutant.edits) {
        assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE`);
        text = text.replace(from, () => to);
      }
      const file = path.join(__dirname, 'electron-harness', `.mutant-run-${i}.cjs`);
      fs.writeFileSync(file, text, 'utf8');
      let died = null;
      try { await K[mutant.killer](require(file)); } catch (e) { died = e; } finally { fs.rmSync(file, { force: true }); }
      assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
      if (!mutant.byError) assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
      assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong place`);
    });
  }
});
