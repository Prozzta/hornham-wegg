<div align="center">

<img src="./docs/logo.png" alt="Munder Difflin — agent harness to run an office of your clones" width="340">

# Munder Difflin

### Agent harness to run an office of your clones — the hardened fork

**Free, open source and performant** — a multi-agent harness that works with the
subscriptions you already pay for, on their hourly limits. It turns the terminal coding CLI
you already run into a clone of you, one that keeps working while you're away and
coordinates a whole office of agents on your own machine.

This is **Prozzta/hornham-wegg**, a fork of
[chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin).
The product concept, the office floor, and the foundation are upstream's work; this fork
is a **hardened, independently versioned line** built for running a floor continuously
and unattended.

<p>
  <em>Electron · React · TypeScript · Pixi.js · xterm.js · node-pty</em>
</p>

<p>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-F4D35E.svg?style=flat-square&labelColor=6E1423"></a>
  <img alt="Version: 1.1.52" src="https://img.shields.io/badge/version-1.1.52-F4D35E.svg?style=flat-square&labelColor=6E1423">
  <img alt="Fork of chaitanyagiri/munder-difflin" src="https://img.shields.io/badge/fork%20of-chaitanyagiri%2Fmunder--difflin-F4F1EA.svg?style=flat-square&labelColor=6E1423">
</p>

<br>

<img src="./docs/media/og.png" alt="Munder Difflin — A hive of agents that message, route, and remember" width="1240">

</div>

---

> [!NOTE]
> **The world's best agents. The world's worst paper company.**
> Munder Difflin takes the terminal-agent CLIs you already run — `claude`, `agy`, `codex`,
> `grok`, and friends — and turns them into a self-coordinating team: each agent gets
> long-term memory, a mailbox, and a desk on a 2D office floor — and **your clone**
> (Michael) routes work between them while you watch. He's the boss of the floor; you're
> still the boss of him.

## Contents

- [Why this fork exists](#why-this-fork-exists)
- [How we got here](#how-we-got-here)
- [How this fork is developed](#how-this-fork-is-developed)
- [What it is](#what-it-is)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Architecture](#architecture)
- [Design system](#design-system)
- [Telemetry](#telemetry)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Why this fork exists

**The short version:** this fork takes upstream's stable **v0.4.5** release (commit
`1f6958b0`) and hardens it into **a floor you can leave running** — real work, real
provider limits, days at a time, without a human babysitting it — then rebalances what
that running floor costs. Two numbers carry the story, both measured and recorded in
the fork's ledger and release runbooks:

- **Memory condensation: from a tracked upstream issue to zero loss, proven on the
  installer.** Upstream's condensation issue is tracked as aborting "~80% of the time"
  (upstream #459). This fork rebuilt it, and the packaged release gate — the actual
  installer artifact, real model calls — condensed a real ~1 MB agent memory
  **959,571 → 91,364 bytes (~90% smaller) in 3 passes with 0 of 3,781 lines lost**;
  the same full 48-check gate passed again on the 1.1.48 build before it shipped.
- **The no-change standup: from ~214k tokens to zero.** The stock scheduled standup
  was measured at **213,949 token units per no-change run — 855,796 per day** at the
  then-live six-hour cadence. A deterministic, locally computed floor-state
  fingerprint now skips the model entirely when no material floor input has changed.

Upstream Munder Difflin is a broad, fast-moving stable base — many engines, many
integrations. This fork points the same product at that narrower, harder goal of
unattended endurance. Three ideas drive it:

- **Favour what your subscriptions have left.** Running on a metered API key — and
  monitoring the floor by token usage — still works; this fork simply rebalances the
  default to favour the *remaining allowance* of the subscriptions you already pay
  for (Claude, Codex, Antigravity), on the plans that allow it. A capacity seam
  through the whole app tracks each provider pool's remaining allowance and admits or
  holds automatic work by it, under one fail-closed rule: never type an automatic
  message into a live terminal, and never when the provider allowance is limited or
  unknown. The app's own background model use — memory condensation via headless
  `claude --print` — runs on the subscription login, with the API-key environment
  variables stripped from that child process so background work can never silently
  switch to pay-as-you-go metering.
- **Spend fewer tokens.** The floor's biggest measured waste was spending model turns to
  discover nothing had changed: the stock hourly standup cost ~214k tokens per no-change
  run at the measured baseline. It was replaced with a deterministic, locally computed
  floor-state fingerprint — if no material input changed, no model is invoked at all.
  The idle heartbeat ships off by default with a measured per-setting cost table, and
  automatic memory condensation keeps each agent's memory bounded instead of growing
  (and costing) forever.
- **Local-only.** The whole floor lives on your machine: agents are local terminal
  processes, and the hive — memory, mailboxes, board, log — is a local git repo of
  plain files, not a hosted service. This fork's builds are compiled without the
  upstream analytics key, which makes the analytics module a verified no-op — no
  client, no install id, nothing sent (see [Telemetry](#telemetry)) — because a floor
  that runs your work locally should observe itself locally too. And the auto-updater
  is pinned to this repository, strictly notify-only — nothing downloads or installs
  without you.

One discipline makes those three trustworthy: **correctness over coverage, proven per
release.** A multi-agent floor fails in ways that only surface when it runs
unattended — a lost lifecycle event
leaves an agent "busy" forever; a wake typed into a live turn corrupts it; a
memory-condense pass that trusts the model loses history. This fork treats each of those
as a release blocker, and every change is independently audited before it ships: code
review against a written design, adversarial replay probes, hand-mutant runs that prove
each guarantee is pinned by a test that actually fails without it, and packaged canaries
that exercise the real installer artifact. The line is versioned independently (the
1.1.x series) with its own Windows x64 installer cuts.

Upstream deserves full credit for the concept and the foundation; this fork exists
because we run the thing in anger and needed it to survive that.

## How we got here

The fork moved in small, independently audited milestones — each proven in an isolated
Dev build (fully separate identity, data, hive and hooks, demonstrably unable to touch
the Stable install) before it went anywhere near the running floor, with upstream kept
as a **patch library**: individual upstream fixes come in by `git cherry-pick`, never
wholesale merges. The shape of the line, as evidence for the three ideas above:

- **The wake path** — mailbox wakes made edge-triggered, then bridged (1.1.46) so a
  delivered hive message wakes its recipient directly: the floor advances without a
  heartbeat and without a human nudging stuck agents, and a stall watchdog names any
  guard that wedges a wake instead of failing silently.
- **The capacity safety seam** (promoted to the floor in v1.0.45, surfaced in the UI in
  1.1.45) — the per-provider subscription-allowance tracking, admission, input
  provenance, and single main-owned fail-closed submit path behind the first idea above,
  shaped throughout by dated human rulings.
- **The scheduler delta gate** — the no-change-standup fingerprint and the
  heartbeat-off-by-default cost analysis behind the second idea, shipped with the
  measured numbers.
- **Memory condensation that cannot lose memory** (1.1.47) —
  condense rebuilt on headless `claude --print` with double-validated structured
  output; a verify-don't-trust gate that rejects any rewrite that doesn't round-trip
  byte-for-byte, backed by lossless backups and an atomic swap; bounded splitting so an
  oversized section converges across passes instead of wedging; and packaged release
  canaries (a cold-boot wake gate and a real-model condense gate) that exercise the
  actual installer artifact, not the dev build.
- **Models and the Antigravity provider** (1.1.48) — current Claude models (Opus 5.5,
  Fable 5.1, verified against the CLI's own registry), per-agent model persistence,
  message-router robustness, the Antigravity provider integration (two never-merged
  capacity pools, a default-closed global-config guard, native-lifecycle wake
  coordination closing the false-active stall), and a committed hand-mutant gate.
- **Performance, measured** (1.1.49–1.1.51) — a log that grew forever and a whole-file
  read of it that froze the main thread (reads 460× faster, log rows −91% with every
  wake event kept); the office floor capped at 30 fps (renderer 40% → 10% of a core
  idle); batched terminal output; and no more Codex transcript replays from terminal
  resizes (27 replays for 11 queued messages → 0).
- **A floor that doesn't stall itself** (1.1.52, the current release) — hive commits
  moved off the main thread (a ~2.1 s freeze per routed message → ~11 ms); agent hooks
  delivered to the app without starting processes (~450 ms → ~1 ms per Claude hook);
  MemPalace mining judged by the daemon's job state, with a bloated palace (673 MB for
  ~30 MB of content) rebuilt, verified row for row and swapped in automatically; and
  Antigravity hooks that actually load, so gates, steers and end-of-turn signals reach
  AGY agents.

Every milestone carries a dated human acceptance and evidence tag in the fork's
internal mission ledger; this README keeps only the shape.

## How this fork is developed

The floor develops itself. This fork is built by a multi-agent Munder Difflin floor —
an orchestrator dispatching work to builder agents, with a dedicated auditor agent
independently verifying every change (replay probes, hand mutants, packaged canaries,
installer verification) before it is accepted. The audit records live alongside the
work, and a change that fails audit goes back with a written finding and a required fix.
It is slower than merging your own PRs, and it is why the guarantees above are stated
as facts rather than hopes.

## What it is

Munder Difflin is a desktop app that wraps **real terminal-agent CLIs** as fully-capable
agents, wires them into a **hive**, and puts **your clone** in charge — Michael, the one
agent *you* talk to in order to get things done.

- **Every terminal is an agent.** Each `claude`, `agy`, `codex`, `grok`, or custom
  session runs as a real process in a pseudo-terminal (`node-pty`), byte-for-byte
  authentic, rendered with xterm.js.
- **Every agent is an avatar.** Sessions appear as characters on a Pixi.js office floor —
  they walk to stations as they work, and envelopes fly desk-to-desk when they message
  each other.
- **The hive coordinates them.** Agents read their memory and drain a mailbox; the router
  moves messages between inboxes; the GOD agent adjudicates, assigns, and escalates only
  when it needs you.
- **Memory that persists.** A markdown-first memory layer with semantic recall and
  automatic condensation, so agents remember across sessions without their memory files
  growing forever.

## How it works

```
            you ── talk to ──►  ┌─────────────┐
                                │  GOD agent  │  orchestrator / supervisor
                                │ (Michael's  │  roster · routing · adjudication
                                │   office)   │  blackboard · task ledger
                                └──────┬──────┘
                                       │ assigns · routes · escalates
              ┌────────────────────────┼────────────────────────┐
              ▼                         ▼                         ▼
        ┌───────────┐            ┌───────────┐            ┌───────────┐
        │  agent A  │  message   │  agent B  │  message   │  agent C  │
        │ provider  │ ─────────► │ provider  │ ─────────► │ provider  │
        │  + memory │            │  + memory │            │  + memory │
        └───────────┘            └───────────┘            └───────────┘
              └──────── shared hive: memory · mailbox · blackboard · log ───────┘
```

1. **You spawn agents** — each is a normal terminal process with its own working
   directory, identity, and provider-specific lifecycle.
2. **Agents collaborate through the hive** — a local git repo of plain files. They write
   to their own `outbox/`; the harness's router delivers into recipients' `inbox/`. No
   agent ever touches git (single-committer design avoids `index.lock` corruption).
3. **The GOD agent runs the floor** — it reads every request, resolves routine ones
   itself, and only escalates *critical* items (spend, destructive ops, scope changes)
   into an approvals queue you act on.
4. **Everything is visible** — avatars, envelopes, the live terminal stream; you can type
   back into any session, browse its files, and read its git history.

See [`HIVE.md`](./HIVE.md) for the full multi-agent design, [`SPEC.md`](./SPEC.md) for
the terminal/event plane, and [`DESIGN.md`](./DESIGN.md) for the visual system.

## Getting started

### Prerequisites

- **Windows x64** for this fork's installer releases; the codebase also builds on macOS
  and Linux (upstream ships all three).
- **Node.js 18+** and npm, plus a C/C++ toolchain for `node-pty`'s native addon.
- At least one supported agent CLI on your `PATH` — [Claude Code](https://claude.com/claude-code)
  (`claude`, the default), Antigravity (`agy`), OpenAI Codex (`codex`), or xAI Grok (`grok`).

### Install & run from source

```bash
git clone https://github.com/Prozzta/hornham-wegg.git
cd hornham-wegg
npm install        # postinstall rebuilds node-pty against Electron's ABI
npm run dev        # launches the Electron app with hot reload
```

On first launch you'll go through the onboarding wizard, then land on the floor. Use
**Add agent** to spawn your first session — the GOD agent seats itself in Michael's
office automatically.

### Other scripts

```bash
npm run build      # production build via electron-vite
npm run typecheck  # type-check the node (main/preload) and web (renderer) projects
node --test --test-concurrency=4 test/*.test.cjs   # the test suite
```

> If `node-pty` fails to load after an Electron upgrade, re-run `npm install` (the
> `postinstall` hook runs `electron-rebuild` against the current Electron ABI). Note the
> packaged installer ships natives rebuilt against Electron's ABI — an `npm ci
> --ignore-scripts` build will not.

## Architecture

Two data planes feed one renderer:

- **Terminal plane.** The main process owns a `PtyManager` that spawns each agent as a
  `node-pty` process and streams output over per-id IPC. The renderer talks only through
  a typed `window.cth` bridge ([`src/preload/index.ts`](./src/preload/index.ts)), which
  also exposes sandboxed filesystem and git helpers.
- **Hive / event plane.** `hive.ts` is the on-disk multi-agent layer; `hooks.ts` runs the
  hook server that provider bridges deliver lifecycle payloads to. `reflect.ts` owns memory
  condensation. The router delivers messages, drains provider outboxes, the GOD agent
  adjudicates, and idle/inbox wakeups keep workers draining mail — with the wake
  coordinator as the single authority on when an agent may be prompted.
- **Hook transports.** Each provider reaches the hook server the cheapest way it supports:
  - **Claude** posts to a loopback HTTP route (`/hook/<id>/<token>`), authenticated by a
    per-spawn token in the URL.
  - **Codex** tool hooks are `mcp_tool` hooks into an in-app MCP endpoint (`/mcp/…`); the
    payload is rebuilt from Codex's rollout and named as Codex's own command hooks name it.
  - **Antigravity** observational hooks and its status line go one-way through a small
    `agy-oneway.cmd` (cmd built-ins, no Node start), written in AGY's documented hooks
    schema.
  - Hooks that must answer (a deny, a block, a steer) keep the command shim, and every agent
    falls back to it when the broker is down. A per-minute `hook-transport` row in
    `log.jsonl` shows which route each agent's hooks took.
- **The hive committer.** The harness is the hive repo's only committer. Commits run in the
  background: messages that arrive close together share one commit, delivery never waits
  for git, and the last commit is flushed on quit.
- **Semantic memory.** `memory.ts` drives the MemPalace CLI and its resident daemon: changed
  memory files are mined incrementally as background daemon jobs, judged by the job's state
  rather than by silence. A bloated palace is rebuilt from its own database into a staging
  copy, verified per collection, and swapped in; each step (`palace-repair-*`,
  `palace-swap-*`, `palace-reclaim`) is logged to `log.jsonl`.

The renderer is presentation: main remains the sole submission authority, and nothing
the UI displays can cause or prevent a wake.

## Design system

The aesthetic is **Animal Crossing × Earthbound × SNES menu UI** — pixel-snapped, chunky,
friendly. [`DESIGN.md`](./DESIGN.md) is canonical; every component derives from its
tokens. The Munder Difflin brand layers a **Dunder-Mifflin maroon** (`#6E1423`) and
**gold** (`#F4D35E`) on top for logo and chrome.

## Telemetry

Per upstream's [`TELEMETRY.md`](./TELEMETRY.md), the analytics module gates every send
on a build-time key ([`src/main/analytics.ts`](./src/main/analytics.ts)); compiled
without it, the module constructs no client, writes no install id, and sends nothing.
This fork's builds are compiled without that key — verified on the shipped installer,
whose bundle is byte-identical to a keyless rebuild.

## License

> [!IMPORTANT]
> **Asset licensing.** The bundled pixel art (tilesets and maps) is **Modern Interiors -
> RPG Tileset [16X16]** by [LimeZu](https://limezu.itch.io/moderninteriors), used under
> the **Complete Version licence**, which permits editing and use in commercial and
> non-commercial projects. **Credit to LimeZu is required by that licence** and must stay
> in place. The Office cast is not LimeZu art; it is drawn procedurally in
> `portraitArt.ts`. See
> [`src/renderer/src/assets/ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).

The **source code** is licensed under the **MIT License** — see [`LICENSE`](./LICENSE).
The MIT grant covers the code only; the bundled pixel art is licensed separately from
LimeZu and is carved out in the `LICENSE` scope note. *Munder Difflin* is an affectionate
parody and is not affiliated with NBC's *The Office* or Dunder Mifflin.

## Acknowledgements

- **[chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin)** —
  the upstream project this fork is built on: the concept, the office floor, the hive
  design, and the foundation of everything above. Upstream's community links (Discord,
  [munderdiffl.in](https://munderdiffl.in)) belong to the upstream project.
- [LimeZu](https://limezu.itch.io/) for the *Modern Interiors* pixel-art tilesets
  (Complete Version licence).
- [`shahar061/the-office`](https://github.com/shahar061/the-office) for the office
  tileset/map vendoring.
- [Pixi.js](https://pixijs.com/) · [xterm.js](https://xtermjs.org/) ·
  [node-pty](https://github.com/microsoft/node-pty) ·
  [electron-vite](https://electron-vite.org/) · [CodeMirror](https://codemirror.net/)
  for the libraries this is built on.
- *The Office* (US) for Munder Difflin, Inc.
