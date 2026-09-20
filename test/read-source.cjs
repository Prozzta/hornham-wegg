'use strict';

/**
 * Read a SOURCE file for a test that inspects its text — LINE-ENDING INDEPENDENT.
 *
 * WHY THIS EXISTS. This repo has `core.autocrlf=true` and no `.gitattributes`, so the
 * same committed file is LF in the working tree it was authored in and CRLF in a fresh
 * checkout. A test that searches source for a literal containing `\n` therefore passes in
 * its author's tree and fails — or worse, passes for a different reason — everywhere else.
 * Dwight's validation of L0-FUSION stage 5.1 caught exactly that: `commitSectionSource`
 * looked for `'\n}\n'`, found nothing in a CRLF checkout, and failed before it had
 * inspected a single prohibition. Green only in the tree it was written in.
 *
 * So: every source-reading test in the L0-FUSION stage-5 files reads THROUGH HERE, and a
 * registered test asserts that none of them calls `readFileSync` on its own.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** CRLF and lone CR both become LF. Idempotent. */
function normaliseEol(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Read a repo file (relative to the repo root, or absolute) with LF line endings. */
function readSource(file) {
  return normaliseEol(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
}

/** The same text as a CRLF checkout and as an LF checkout would hold it on disk. */
function bothEolRenderings(text) {
  const lf = normaliseEol(text);
  return { lf, crlf: lf.replace(/\n/g, '\r\n') };
}

module.exports = { ROOT, normaliseEol, readSource, bothEolRenderings };
