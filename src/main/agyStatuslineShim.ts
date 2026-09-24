/**
 * The Antigravity statusline shim, written to `<hive>/bin/agy-statusline.cjs`.
 *
 * Antigravity runs the configured statusline command after every TUI render with the
 * session's status JSON on stdin, and shows whatever the command prints. This shim does
 * two things with one parse, and nothing else:
 *   1. prints ONE sanitized line for the user's terminal - model and state, never quota,
 *      never identity; and
 *   2. forwards the payload, once, to the local HookServer, which normalizes it.
 *
 * HARD LIMITS, because AGY waits on it and auto-disables a statusline that keeps failing:
 *   - built-in modules only (`fs`, `net`, `path`) - no dependency can load slowly or fail;
 *   - a 64 KiB stdin ceiling - anything larger is dropped, not parsed;
 *   - a 150 ms connect/write deadline and a 400 ms absolute watchdog, under AGY's 500 ms;
 *   - exit code 0 on EVERY path, including every telemetry failure.
 * It has no daemon and no polling: without one complete JSON object on stdin it does
 * nothing. Antigravity does not invoke it for `agy -p`, and Munder never installs it as a
 * headless hook.
 *
 * WHERE IT SENDS. An inherited HIVE_SOCK means a Munder-launched worker. Otherwise it
 * reads the locator named by the installed command, and connects only if the locator's
 * schema and owner token match the command it was installed with and the owning process
 * is still alive. A personal session sends `agent_id: null` - on purpose: capacity is
 * account-wide, but a session nobody spawned must never move a hive agent's status.
 *
 * WRITTEN WITHOUT A SINGLE BACKSLASH, BACKTICK OR DOLLAR-BRACE. This source is embedded
 * in a TypeScript template literal; newline and the middle dot are built from char codes
 * so no escaping layer can ever change what is written to disk. A census test pins that.
 */
export const AGY_STATUSLINE_SHIM = `'use strict';
var fs = require('fs');
var net = require('net');
var path = require('path');

var NL = String.fromCharCode(10);
var DOT = String.fromCharCode(183);
var MAX_STDIN = 65536;
var CONNECT_MS = 150;
var WATCHDOG_MS = 400;
var MODEL_CHARS = 48;

function quit() { try { process.exit(0); } catch (e) { /* nothing else to do */ } }
process.on('uncaughtException', quit);
setTimeout(quit, WATCHDOG_MS);

function arg(name) {
  var i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function printable(value, max) {
  var out = '';
  var n = 0;
  for (var ch of String(value)) {
    var c = ch.codePointAt(0);
    if (c < 32 || c === 127 || (c >= 128 && c < 160)) continue;
    out += ch;
    n += 1;
    if (n >= max) break;
  }
  return out.trim();
}

function stateWord(p) {
  if (p.tool_confirmation_pending === true) return 'confirmation';
  if (p.agent_state === 'working' || p.agent_state === 'tool_use') return 'working';
  if (p.agent_state === 'idle') return 'idle';
  return null;
}

function printLine(p) {
  var state = stateWord(p);
  var m = p.model && typeof p.model === 'object' ? (p.model.display_name || p.model.id) : null;
  if (!state || typeof m !== 'string') return;
  var model = printable(m, MODEL_CHARS);
  if (!model) return;
  try { process.stdout.write('AGY ' + DOT + ' ' + model + ' ' + DOT + ' ' + state + NL); } catch (e) { /* ignore */ }
}

function endpoint() {
  var inherited = process.env.HIVE_SOCK;
  if (inherited) return inherited;
  var locator = arg('--locator');
  var owner = arg('--owner');
  if (!locator || !owner || !path.isAbsolute(locator)) return null;
  var l;
  try { l = JSON.parse(fs.readFileSync(locator, 'utf8')); } catch (e) { return null; }
  if (!l || l.schema !== 1 || l.token !== owner || typeof l.sock !== 'string' || !Number.isInteger(l.pid)) return null;
  try { process.kill(l.pid, 0); } catch (e) { if (e && e.code === 'ESRCH') return null; }
  return l.sock;
}

function send(p) {
  var sock = endpoint();
  if (!sock) return quit();
  // read_at is when THIS shim read the status, not when main received it. The payload
  // carries no generation time of its own, and arrival times through one socket are
  // monotone - so without this the ordering guard in the wake coordinator can never fire.
  // Plain wall clock, the same one main compares against.
  var envelope = JSON.stringify({
    hook_event_name: 'AgyStatusLine',
    agent_id: process.env.AGENT_ID || null,
    read_at: Date.now(),
    agy_status: p
  }) + NL;
  var c = null;
  var deadline = setTimeout(function () {
    try { if (c) c.destroy(); } catch (e) { /* ignore */ }
    quit();
  }, CONNECT_MS);
  try {
    c = net.createConnection(sock, function () {
      c.end(envelope, function () { clearTimeout(deadline); quit(); });
    });
    c.on('error', quit);
  } catch (e) { quit(); }
}

var chunks = [];
var size = 0;
var oversize = false;
process.stdin.on('data', function (d) {
  if (oversize) return;
  size += d.length;
  if (size > MAX_STDIN) { oversize = true; chunks = []; return; }
  chunks.push(d);
});
process.stdin.on('error', quit);
process.stdin.on('end', function () {
  if (oversize) return quit();
  var p;
  try { p = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return quit(); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return quit();
  printLine(p);
  send(p);
});
`;
