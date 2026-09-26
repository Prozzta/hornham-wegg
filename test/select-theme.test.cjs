// HEAVY-SETTING-DARK (1.1.56 live): the "Heavy jobs at once" dropdown was unreadable in the dark
// theme. global.css pins `color-scheme: light` (for the cream design's caret), so Chromium drew
// the select box and its option popup LIGHT while the text inherited the dark theme's near-white
// ink. Every select (and option) now takes its colours from the theme tokens, and the dark theme
// declares the dark UA scheme.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src', 'renderer', 'src');
const css = fs.readFileSync(path.join(SRC, 'design', 'global.css'), 'utf8');
const tokens = fs.readFileSync(path.join(SRC, 'design', 'tokens.css'), 'utf8');

test('the dark theme declares the dark UA scheme; the light default stays light', () => {
  assert.match(css, /:root \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-cth-theme='dark'\] \{ color-scheme: dark; \}/);
});

test('every select, option and optgroup takes its surface and text from the theme tokens (the same pair as the other inputs)', () => {
  const rule = css.match(/select, option, optgroup \{([^}]*)\}/);
  assert.ok(rule, 'one rule covers select + option + optgroup');
  assert.match(rule[1], /background-color: var\(--cth-paper-100\);/);
  assert.match(rule[1], /color: var\(--cth-ink-900\);/);
  // both tokens really swap in the dark theme (dark surface, light ink)
  const dark = tokens.slice(tokens.indexOf(":root[data-cth-theme='dark']"));
  assert.match(dark, /--cth-paper-100:\s*#1A1A1F;/);
  assert.match(dark, /--cth-ink-900:\s*#DEDBD6;/);
});

test('no <select> in the renderer hard-codes a colour that would override the themed one', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) {
        const s = fs.readFileSync(p, 'utf8');
        for (let i = s.indexOf('<select'); i >= 0; i = s.indexOf('<select', i + 1)) {
          const tag = s.slice(i, s.indexOf('>', i + 7) + 1 || i + 400);
          const hard = tag.match(/(background|color)\s*:\s*['"`]?(#[0-9a-fA-F]{3,8}|white|black|rgb)/);
          if (hard) offenders.push(`${path.relative(SRC, p)}: ${hard[0]}`);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});

test('the Heavy jobs select itself sets no colours of its own (it inherits the themed rule)', () => {
  const ui = fs.readFileSync(path.join(SRC, 'components', 'SettingsModal.tsx'), 'utf8');
  const at = ui.indexOf('aria-label="Heavy jobs at once"');
  const tag = ui.slice(ui.lastIndexOf('<select', at), ui.indexOf('>', ui.indexOf('style=', at)) + 1);
  assert.ok(!/background|color:/.test(tag), tag);
});
