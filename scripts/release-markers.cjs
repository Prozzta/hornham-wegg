#!/usr/bin/env node
/*
 * The release markers (runbook Appendix B steps 4 and 7), now TEN: the 7 postinstall markers
 * (node-pty's conpty patch and native builds, better-sqlite3) plus the 3 native-memory artifacts
 * (NATIVE-MEMORY spec section 5.5, Jim fix 5), each checked by SHA-256 against
 * resources/models/native-memory-manifest.json:
 *   8  vec0.dll                       (sqlite-vec, win32-x64)
 *   9  onnxruntime.dll + binding      (onnxruntime-node, win32-x64 CPU)
 *   10 the model (onnx + tokenizer)   (all-MiniLM-L6-v2 fp32)
 *
 *   node scripts/release-markers.cjs <node_modules root> <models dir>
 *     source:  node_modules                                        resources/models
 *     build:   dist/win-unpacked/resources/app.asar.unpacked/node_modules   dist/win-unpacked/resources/models
 * Prints ALL 10 MARKERS OK, or MARKERS FAILED (exit 1).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.argv[2];
const modelsDir = process.argv[3];
if (!root || !modelsDir) { console.error('usage: release-markers.cjs <node_modules root> <models dir>'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const agent = path.join(root, 'node-pty', 'lib', 'conpty_console_list_agent.js');
const src = fs.existsSync(agent) ? fs.readFileSync(agent, 'utf8') : '';
const findFile = (dir, name) => { const out = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) out.push(p); } }; walk(dir); return out; };
const built = (pkg, name) => findFile(path.join(root, pkg), name).filter((p) => fs.statSync(p).size > 0);
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const plat = 'win32-x64';
const vec = manifest.vec0[plat];
const ort = manifest.ort[plat];
const checks = [
  ['conpty guard present', src.includes('try { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) { consoleProcessList = []; }')],
  ['unguarded form absent', src.length > 0 && !src.includes('var consoleProcessList = getConsoleProcessList(shellPid);')],
  ['send guard present', src.includes('try { process.send({ consoleProcessList: consoleProcessList }); } catch (e)')],
  ['pty.node built', built('node-pty', 'pty.node').length > 0],
  ['conpty.node built', built('node-pty', 'conpty.node').length > 0],
  ['winpty-agent.exe built', built('node-pty', 'winpty-agent.exe').length > 0],
  ['better_sqlite3.node built', built('better-sqlite3', 'better_sqlite3.node').length > 0],
  // The packager may nest the platform package under sqlite-vec (the installed layout does).
  ['vec0.dll digest = manifest', !!vec && [path.join(root, vec.package, vec.file), path.join(root, 'sqlite-vec', 'node_modules', vec.package, vec.file)].some((p) => sha(p) === vec.sha256)],
  ['onnxruntime win32-x64 digests = manifest', !!ort && Object.entries(ort).every(([rel, want]) => sha(path.join(root, 'onnxruntime-node', ...rel.split('/'))) === want)],
  ['model files digests = manifest', Object.entries(manifest.model.files).every(([rel, want]) => sha(path.join(modelsDir, manifest.model.dir, ...rel.split('/'))) === want)]
];
let ok = true;
for (const [n, v] of checks) { console.log((v ? 'OK   ' : 'FAIL ') + n); ok = ok && v; }
console.log(ok ? `ALL ${checks.length} MARKERS OK` : 'MARKERS FAILED');
process.exit(ok ? 0 : 1);
