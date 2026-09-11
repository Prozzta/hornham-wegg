#!/usr/bin/env node
'use strict';
/**
 * `npm run dev:isolated` — launch `electron-vite dev` with MUNDER_DEV=1 set
 * cross-platform (no cross-env dependency), and with Stable's exported hive
 * identity removed from the child environment as a first line of defence.
 * The main process scrubs the same keys again at bootstrap (devIsolation.ts),
 * so this script is a convenience, not the guard.
 *
 * Pass-through: extra args go to electron-vite (`npm run dev:isolated -- --help`).
 * The data root is fixed (C:\Dunder\MunderDevData on Windows); there is no override.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// Mirror of STABLE_ENV_KEYS / STABLE_ENV_PREFIXES in src/main/devIsolation.ts.
const STABLE_ENV_KEYS = [
  'HIVE_ROOT', 'HIVE_SOCK', 'HIVE_NODE', 'HIVE_AUTO_APPROVE', 'AGENT_ID', 'AGENT_DIR', 'AGENT_NAME',
  'MEMPALACE_PALACE_PATH', 'MD_SLACK_REPLY_CONFIG', 'CODEX_HOME', 'PI_CODING_AGENT_DIR',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'CRUSH_GLOBAL_CONFIG', 'CRUSH_GLOBAL_DATA', 'KG_ROOT', 'KG_CLI', 'KG_CORE', 'MD_BROKER_URL',
  'MD_BROKER_TOKEN', 'HIVE_PROXY_SESSION', 'OPENAI_BASE_URL', 'CRUSH_PROXY_BASE_URL',
  'CLAUDE_CODE_ENABLE_TELEMETRY'
];
const STABLE_ENV_PREFIXES = ['OTEL_'];

const env = { ...process.env, MUNDER_DEV: '1' };
const scrubbed = Object.keys(env).filter((k) => STABLE_ENV_KEYS.includes(k) || STABLE_ENV_PREFIXES.some((p) => k.startsWith(p)));
for (const k of scrubbed) delete env[k];

const isWin = process.platform === 'win32';
const bin = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'electron-vite.cmd' : 'electron-vite');

console.log(`[dev:isolated] MUNDER_DEV=1 (data root is fixed: ${isWin ? 'C:\\Dunder\\MunderDevData' : '~/MunderDevData'})`);
if (scrubbed.length) console.log(`[dev:isolated] scrubbed inherited Stable env: ${scrubbed.join(', ')}`);

// A .cmd shim needs a shell on Windows (Node >= 18.20 refuses to spawn it directly).
const child = spawn(isWin ? `"${bin}"` : bin, ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: isWin
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => { console.error('[dev:isolated] failed to start electron-vite:', err.message); process.exit(1); });
