'use strict';
/**
 * PROMOTION GUARANTEE: the packaged app may only ever look for, fetch or offer a
 * build from the human's own repository — never from the upstream project it was
 * forked from.
 *
 * The update surfaces are many and live in different files: electron-updater's
 * feed (baked into app-update.yml from electron-builder.yml `publish`), the
 * notify-only releases/latest poll, the release-tag lookup, the installer
 * download URLs, the "view release" links, and the Settings hero fetch. Before
 * this change the release home was spelled out in FIVE places, including two
 * separate `REPO` constants, which is how an app ends up half-repointed. These
 * arms hold the whole set to one definition and one value.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const OWN = 'Prozzta/hornham-wegg';
const UPSTREAM = 'chaitanyagiri';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { REPO, installerUrl } = loadTs('src/shared/updateState.ts');

/** Every string literal and template text under src/, with comments EXCLUDED
 *  structurally (AST, not regex) — the code comments quote the old upstream
 *  repo on purpose, to explain why it is gone, and must not trip the arm. */
function codeStrings() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|cjs|js)$/.test(e.name)) {
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.ES2022, true);
        (function visit(n) {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ file: p, text: n.text });
          else if (ts.isTemplateExpression(n)) {
            out.push({ file: p, text: n.head.text });
            for (const s of n.templateSpans) out.push({ file: p, text: s.literal.text });
          }
          ts.forEachChild(n, visit);
        })(sf);
      }
    }
  })(path.join(ROOT, 'src'));
  return out;
}

test('the release home is the human\'s own repository', () => {
  assert.equal(REPO, OWN);
});

test('NO string in the app\'s code names the upstream project', () => {
  const found = codeStrings().filter((s) => s.text.toLowerCase().includes(UPSTREAM));
  assert.deepEqual(found.map((s) => path.relative(ROOT, s.file)), [],
    'no fetch, feed, download or link may be built from the upstream owner');
  // Prove the scan is actually reading code, or an empty result means nothing.
  assert.ok(codeStrings().some((s) => s.text.includes('api.github.com')), 'the AST scan sees real string literals');
});

test('there is exactly ONE definition of REPO, in shared/updateState.ts', () => {
  const defs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.ES2022, true);
        (function visit(n) {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'REPO') {
            defs.push(path.relative(ROOT, p).replace(/\\/g, '/'));
          }
          ts.forEachChild(n, visit);
        })(sf);
      }
    }
  })(path.join(ROOT, 'src'));
  assert.deepEqual(defs, ['src/shared/updateState.ts'],
    'a second copy of the release home is how an app ends up half-repointed');
});

test('electron-builder publish (the baked app-update.yml) names the same repository', () => {
  const yml = read('electron-builder.yml');
  const block = /^publish:\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(yml);
  assert.ok(block, 'found the publish block');
  const field = (k) => (new RegExp(`^[ \\t]+${k}:[ \\t]*(\\S+)`, 'm').exec(block[1]) || [])[1];
  assert.equal(field('provider'), 'github');
  assert.equal(`${field('owner')}/${field('repo')}`, REPO, 'the feed and the code must agree');
});

test('package.json repository and version, and the lockfile agrees on the version', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.repository.url, `https://github.com/${OWN}.git`,
    'electron-builder falls back to `repository` for a github publish, so it must not point upstream');
  assert.equal(pkg.version, '1.0.45');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version, 'package-lock root version agrees');
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock packages[""] version agrees');
});

test('every installer download URL resolves under the human\'s repository', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const url = installerUrl('1.0.45', platform);
    if (url === null || url === undefined) continue;
    assert.ok(url.startsWith(`https://github.com/${OWN}/releases/download/`), `${platform}: ${url}`);
  }
});
