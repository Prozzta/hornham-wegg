# Native memory engine: build notes (branch `memory-154`)

**Status:** built and tested on branch `memory-154`, off `origin/release-1.1.53` (`79ee6b91`, with `76c8d3ce` carried).
- Nothing is pushed, released or cut.
- The default mode is `legacy`, which changes **nothing**: no worker, no token, no PATH change, and the `/memory` route answers 403 (no `MEMORY_TOKEN` is ever minted in `legacy`, so no caller can authenticate).

**Scope lock** (the Human, via god): 1.1.54 is PURELY the MemPalace replacement.
- No other fixes, cards, refactors or doc sweeps.
- `src/main/memory.ts`, the legacy MemPalace manager, is **unchanged**.
- One carry: `76c8d3ce` is a cherry-pick of `e9daa0b8`. It is **test-only** (it fixes a load flake in `test/log-stall-av.test.cjs` that broke green gates) and **ships nothing**.

**Spec:** `agents/oscar-mu3300lb/NATIVE-MEMORY-SPEC.md`.
- Jim approved it for gate 2 (`NATIVE-MEMORY-SPEC-REVIEW.md`).
- All 5 of his text fixes were already in Oscar's current text (checked: chunk-diff in §1, the §7 thresholds, `MEMORY_TOKEN` for every provider, wake-up tied to the §4 contract, 10 markers).

## What was built

| Piece | File | What it does |
|---|---|---|
| Allow-list | `src/main/nativeMemory/sources.ts` | Eligible sources: `memory.md` and direct `agents/<id>/*.md`. A god-approved top-level list and per-agent nested opt-ins go in `<hive>/memory-sources.json` (default empty). `board.md`, path escapes and missing files are rejected. Every excluded `.md` is reported by path. |
| Tokenizer | `wordpiece.ts` | The BERT-uncased WordPiece tokenizer of all-MiniLM-L6-v2, read from its `tokenizer.json`. |
| Embedder | `embedder.ts` | `onnxruntime-node` used directly: 2 intra-op threads, 1 inter-op, CPU only. Loaded lazily, unloaded when idle. |
| Chunker | `chunker.ts` | Chunks are anchored to headings, with a 200-wordpiece budget (the model window is 256). An append changes no existing chunk. |
| Store | `store.ts` | One SQLite file (WAL, foreign keys, 5 s busy timeout, `journal_size_limit`) with FTS5 plus `vec0` (cosine). Chunk-diff ingestion runs in one transaction. Hybrid search takes `max(4k,40)` candidates from each index, filters before fusion, and fuses by RRF. Also here: the `quick_check`, `VACUUM INTO` + verify, and the compaction policy. |
| Engine | `engine.ts` | One priority queue (search > wake-up/status > ingest > backfill > compaction). Backfill yields every 4 chunks. A non-recursive watcher with a 2 s debounce, a 10-minute reconcile, and compaction with a swap that keeps one prior file. |
| Worker | `worker.ts` → `out/main/memoryWorker.js` | The utility-process entry. The config comes in the first message. Stale requests are answered `expired`. Also: below-normal priority, a model and DLL digest check before loading, and quarantine of a corrupt DB. |
| Main | `service.ts`, `mainWiring.ts` | Forks the worker lazily (on the first memory request). Every request gets a deadline and never blocks: 250 ms warm, 2 s cold, then a named degraded reply. Crash restarts are bounded. Also: per-agent `MEMORY_TOKEN`s, the feature flag (`<hive>/memory-engine.json`), and redacted shadow diagnostics. |
| Endpoint | `hooks.ts` | `POST /memory/<token>` on the existing loopback broker, with a 64 KB body cap. |
| CLI shim | `resources/mempalace-shim.cjs`; wrappers in `<hive>/bin/memory/` (from `hive.writeMemoryShim`) | `search` / `wake-up` / `status` / `--version`, and `--palace` / `MEMPALACE_PALACE_PATH`. Modes: `legacy` / `fallback-legacy` run the legacy CLI; `shadow` prints legacy output only; `native` answers from the engine. Exit codes are 0/2/3/4/5. Past `legacy`, the shim directory is prepended to each agent's PATH. |
| Packaging | `electron-builder.yml`, `build/afterPack-memory-prune.cjs`, `resources/models/native-memory-manifest.json`, `scripts/fetch-memory-model.cjs` | One bundled fp32 model, pinned by SHA-256 and never downloaded at runtime. `vec0` and ORT are unpacked from the asar. The ORT runtime is pruned to the target platform/arch CPU build, without DirectML. |
| Markers | `scripts/release-markers.cjs` | The existing 7 markers plus `vec0.dll`, ORT and the model, each checked by SHA-256 against the manifest. Prints `ALL 10 MARKERS OK`. |
| Tools | `scripts/native-memory-migrate.cjs`, `native-memory-parity.cjs`, `native-memory-parity-stats.cjs` | Copy-only migration with a report; the parity replay with engine-blind label sheets; NDCG@5 / recall@10 with a paired bootstrap and kappa. |
| Gate-2 smoke | `src/main/nativeMemory/smoke.ts` | `"Munder Difflin.exe" --native-memory-smoke=<result.json>`. It points userData at a fresh temp folder before anything reads it, skips the bootstrap, and opens no window. It forks the real worker via `utilityProcess` over a scratch hive, writes the result file, and exits. **Not yet run:** launching the built app needs god's OK. |

## Decisions and deviations (for the audit)

1. **No Transformers.js.**
   - It would ship `sharp`, the onnxruntime-web WASM and about 48 MB of JS, just to tokenize and mean-pool.
   - Instead: a WordPiece tokenizer and a direct ORT session.
   - Parity was measured against the spike's Transformers.js pipeline:
     - **0 token-id mismatches** over all 1,148 untruncated corpus texts and queries;
     - embedding cosine: mean 0.99995, min 0.9976 (the minimum is on truncated long texts).
   - The only difference: when Transformers.js truncates, it drops `[SEP]`; this code keeps it, like Python HF. It never matters here, because chunks stay under 200 wordpieces.
2. **`legacy` is inert.** The shim is prepended to PATH only past `legacy`, so a default install runs exactly as 1.1.53.
3. **`--since` / `--before` use `chunks.filed_at`**: the source's mtime when that chunk was first indexed. An unchanged chunk keeps its date.
4. **Filtered vector search** (wing/room/date) is an exact scan with `vec_distance_cosine` over the filtered rows. vec0 KNN cannot pre-filter by a joined column. Unfiltered queries use vec0 KNN.
5. **Wake-up L0** is the wing's own `agents/<id>/identity.md`. Legacy L0 was a global `~/.mempalace/identity.txt` that nobody had configured.
6. **The backfill yields every 4 chunks, not 8** (the spec allows up to 8). With 8, a search during a backfill had a p95 of 255 ms, over the 250 ms warm deadline. See the measurements.
7. **vec0 delete-slot reuse, which the spec listed as unproven, was measured** on 0.1.9. Going 400 → 20 → 400 *different* chunks grew the file 2%. vec0 pre-allocates 1,024-vector chunks and reuses freed slots, and `VACUUM INTO` comes out at the live size.
8. **Packaging finding.** A platform-level `files:` list in electron-builder *replaces* the top-level list (it packed `docs/`, `blog/` and the model twice). The prune is therefore an `afterPack` hook.
9. **Packaging finding.** The packager nests `sqlite-vec-windows-x64` under `sqlite-vec`, so main resolves the DLL through `sqlite-vec`'s own `getLoadablePath()` (a path lookup; main never loads it). The markers script checks both layouts.

## Gates and measurements

All measurements were taken on **copies**. The live palace, the installed app and userData were never opened for writing; the live hive was only read, stat-ed and copied.

**Tests**
- `test/native-memory.test.cjs`: 32 tests, plain Node.
- `test/native-memory-electron.test.cjs`: 14 tests, run under Electron-as-Node against the real shipped natives and model:
  - the vec0 digest refusal;
  - chunk-diff;
  - search filters and hostile FTS input;
  - the ONNX-then-vec0 BigInt regression;
  - quarantine;
  - the compaction swap;
  - the regrowth gate;
  - vec0 slot reuse;
  - the full worker protocol;
  - the stale-plan and bad-count guards;
  - the model digest refusal;
  - **rollback safety**;
  - the gate-6 review capture (content, location, and nothing written by default).

**Mutant census:** 38 mutants over the store, engine, allow-list, service, wiring, shim, worker, route, format and tokenizer.
- **37 killed, 1 equivalent.** The equivalent one drops `isFile()` from the direct-`.md` filter, which the size/file check in `add()` already enforces.
- The census found a **real bug, now fixed.** SQLite reuses the highest deleted rowids, so the stale-plan check comparing chunk ids alone could apply a plan made against chunks that had since been replaced. Plans now carry `id:contentSha` for every chunk they saw.

**Typecheck / build / full suite:** typecheck 0, build 0; the full suite is **2,190 tests = 2,177 pass / 8 fail / 5 skipped, and the 8 failures are exactly the known 8** (the 1.1.53 baseline); `ALL 10 MARKERS OK` on the source tree and on the built layout.

**Migration** (gate 3, a copy of the live hive's Markdown: 625 files, 4.5 MB)

| Measure | Value |
|---|---|
| Discovered / eligible / excluded by rule / unreadable | 625 / 119 / 506 / 0 |
| Chunked = embedded = vectors; failed | 3,667; 0 |
| Legacy palace (copy) | 546 source files, 6,362 chunks, 80 MB |
| Legacy scope kept | every `memory.md` (10 files); 108 of 109 direct `.md`. The one missing is stale: moved to another agent's folder, where native has it. |
| Legacy scope dropped | nested `.md` 187 files; data 184 files (`.json`/`.jsonl`/`.csv`); other 56 files (`.txt`, code …) |
| Excluded `.md` that are not in dot-directories | 6: `COMMANDS.md`, `L0-PIN6-VERDICT.md`, `PROTOCOL.md`, `board.md` (top level) and 2 nested deliverables, `agents/andy-mtuk4y4x/capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md` and `agents/jim-mtujpe28/upstream-evidence/README.md`. Owners or god can opt these in. |
| Native DB | **10.6 MB** (legacy palace: 80 MB) |

**Worker** (shipped bundle + natives, packaged exe as Node, full copy)

| Measure | Value |
|---|---|
| Full backfill | 81 s for 3,667 chunks (about 22 ms each, 2 ORT threads) |
| Warm search | p50 **8 ms**, p95 **10 ms** (legacy CLI: **1,441 ms** median per call, a Python process each time) |
| Cold search, first after load | 136 ms, including the model load (114 ms) |
| Search during a backfill | p50 86 ms, **p95 104 ms** (budget: 250 ms warm) |
| RSS | 56 MB start → 358 MB peak during backfill → 289 MB after → **111 MB after the model unloads** (after 10 min idle) |
| Main, synchronous work per memory request | < 2 ms p95 (a test pins it) |
| Python / child processes on the native path | **0**: the worker bundle requires only `fs`/`os`/`path`/`crypto`, the ONNX runtime and `better-sqlite3`; a native CLI call never runs the legacy CLI (both pinned by tests) |
| Regrowth: 200 entries + 1,000 appends | **1.0045×** a fresh rebuild (gate: ≤ 1.5×); each append embedded exactly one chunk |

**Packaging** (win x64, measurement build only: not a release, not launched)

| Measure | Value |
|---|---|
| Installer | 218,239,886 B, against 131,796,812 for 1.1.53: **+86.4 MB** with fp32 (target ≤ 130 MB) |
| Unpacked ORT | 16.3 MB (`onnxruntime.dll` + binding; other platforms and DirectML removed) |
| `vec0.dll` | 286 KB |
| Model | 87 MB (fp32 `model.onnx` + tokenizer). q8 was not evaluated: fp32 already meets the size target. |
| Markers | `ALL 10 MARKERS OK` in `node_modules` **and** on the built layout |
| Installed-layout pre-check (packaged exe as Node, **not** the gate-2 smoke) | The worker bundle loaded from inside `app.asar`, with the unpacked better-sqlite3, the nested vec0.dll and the pruned ORT, ingested and searched a scratch hive: OK |

**Gate 2: the built-app utility-process smoke. PASSED**
- Run under god's conditions: the built exe with `--native-memory-smoke` only; no window; a fresh temp userData and a temp scratch hive; the env scrubbed of MEMPALACE/HIVE/AGENT/MUNDER/MEMORY variables and anything naming a live path; HOME/USERPROFILE jailed.
- The process tree was recorded with WMI creation events:
  - main (`Munder Difflin.exe`);
  - a **utility process `node.mojom.NodeService`** (the memory worker);
  - Electron's standard gpu-process and network utility.
  - Nothing else: no Python, no shell, no helper.
- The worker loaded the asar-unpacked better-sqlite3, the nested `vec0.dll`, the pruned ORT and the bundled model in the installed layout. It ingested, then searched (`[1] smoke / memory`), in 483 ms total (ready in 211 ms).
- The exe exited 0 **on its own** in 3.0 s, with 0 leftover processes.
- The runner is `_work/andy-mem154-measure/smoke-with-tree.cjs`; the report is `%TEMP%/memory-smoke-*/smoke-report.json`.
- **Not covered here:** the mac and Linux artifacts (not buildable on this host), and the Defender/BitDefender scan-time observation (it needs an install).

**Parity** (gate 4), a **documented spec deviation**, as god decided
- **Why:** the spec wants 30–50 intents from real transcripts. Real `mempalace search` calls are rare: **6 distinct intents** exist, from 3 agents, before the build started; everything else was diagnostics.
- **God's decision.** The gate-4 set is **the 6 real intents plus 48 authored by Phyllis** (not the builder): 8 in each of the spec's cohorts (exact identifier, semantic paraphrase, wing-scoped, no-match, punctuation/quoting, stale/removed). That makes 54 queries, and every cohort has n ≥ 8, so each can be gated.
- **Labellers:** JIM is the primary labeller (blind, shuffled union, 0/1/2); PHYLLIS takes a random 20% (seed 20260926, 11 queries) for kappa; the Human spot-checks 10 queries (seed 1590).
- **Real-query parity is re-run on SHADOW diagnostics before any native cutover (gate 6).**
- **Contamination check.** Phyllis's intents briefly sat in the hive (`agents/phyllis-mu11xldm/PARITY-INTENTS.md`, about 10:54Z) before being moved out and deleted. The replay uses copies taken before that:
  - the palace copy has **0** drawers with that source, and its newest `filed_at` is 10:07Z;
  - the hive-Markdown copy for the native index was taken at 10:31Z and lacks the file;
  - the replay script **throws** if any hit from either engine comes from a query-set file.
- **Replay** (54 queries, on the frozen copies):
  - legacy CLI median **1,443 ms** (p95 1,618) per query;
  - native warm median **16 ms** (p95 28), cold 137 ms;
  - mean source overlap 5.6 of 10.
  - Of the legacy hits native does not return, **137 are scope-excluded** (MINE-SCOPE: data, nested and evidence files, dropped from the judged pool in the gated scope-adjusted variant) and **22 are removed** (files that no longer exist, i.e. stale legacy entries).
- **Label sheets** (engine-blind, 1,049 items, private: never committed, never in the hive):
  - `_work/andy-mem154-measure/parity-private/label-sheet-JIM.json`;
  - `label-sheet-PHYLLIS-20pct.json` (219 items);
  - `spotcheck-HUMAN.json`.
  - The engine key is in `builder-only/`.
- **Scoring** is `scripts/native-memory-parity-stats.cjs`: NDCG@5, recall@10, a paired bootstrap (10,000 resamples), the 95% CI lower bound ≥ −5 pts overall and per cohort, and kappa.
  - A cohort is gated only on queries that *can* be scored. A query with no relevant item has no NDCG/recall; that is the no-match cohort by design.

**Gate 4 result** (Jim primary 54/54, 1,049 items; Phyllis 20%, 219 items)
- **Excluded, not scored: `r01`.** It is an extraction artifact, not a real intent: runbook text inside a Jim command that merely quoted a search. The real intent there is `r02`. The other 5 real intents are genuine. That leaves 53 queries, 43 of them scorable.
- **Kappa, Jim vs Phyllis: 0.478** (moderate; above god's 0.4 floor).
- **Scope-adjusted, native minus legacy, mean [95% CI], in points:**

| Cohort | n (scored) | NDCG@5 | recall@10 | Gate (lower bound ≥ −5) |
|---|---|---|---|---|
| **overall** | 53 (43) | **+15.3 [+4.5, +26.6]** | **+24.4 [+10.6, +38.3]** | **pass** |
| exact-identifier | 9 (9) | +45.0 [+16.4, +72.4] | +62.3 [+32.3, +87.1] | pass |
| semantic | 12 (11) | −4.6 [−20.3, +11.8] | +14.3 [−3.7, +36.2] | **fail** (lower bound) |
| wing-scoped | 8 (8) | +10.7 [−12.5, +33.9] | +6.9 [−26.4, +40.6] | **fail** (lower bound) |
| punctuation | 8 (8) | +24.3 [−1.0, +48.8] | +28.5 [−12.5, +58.3] | **fail** (lower bound) |
| stale | 8 (7) | +3.6 [−8.9, +17.9] | +6.9 [−10.1, +23.9] | not gated (7 < 8 scorable) |
| no-match | 8 (0) | n/a | n/a | not gated (nothing relevant to find, by design) |

- The raw variant (MINE-SCOPE hits kept in the pool) gives the same verdicts; overall it is NDCG@5 +12.0 [+0.9, +23.7] and recall@10 +19.6 [+5.8, +33.3].
- **Plainly: the gate as specified FAILS**, on the per-cohort lower bound for semantic, wing-scoped and punctuation.
  - Overall, native is **significantly better** than legacy on both metrics: both CI lower bounds are above zero.
  - No cohort shows a significant regression: every CI contains zero or is above it.
  - The failing cohorts fail on CI *width* (±20–30 pts at n = 8–12), not on a worse estimate. Only semantic NDCG@5 has a negative point estimate (−4.6), and its recall@10 is +14.3.
  - Certifying ≥ −5 per cohort at this variance would need roughly 5–10× more queries per cohort.
  - **Decision for god, Jim and the Human:**
    - (a) more queries in the failing cohorts;
    - (b) accept on the overall result plus no cohort regression, with gate 6's shadow re-run on real queries as the confirmation;
    - (c) another rule.

**SUPERSEDED. God first chose option (b), a deferral to gate 6; the Human then REVERSED it.**
- The Human asked why we don't simply test more, and approved it: **the per-cohort ≥ −5 lower-bound rule applies NOW, at gate 4, on an expanded set.**
- The gate-6 shadow diagnostics below stay, as the real-query **confirmation** step before any cutover.
- The history of the deferral is kept below for the record.

**Expanded gate 4, round 2** (god andyparity2/2b):
- **Queries:** 373 in all.
  - Round 1: 53 (r01 excluded as an extraction artifact).
  - PHYLLIS 160 and DWIGHT 160, authored as 20 per scorable cohort plus 5 no-match per 105-query file, and 10 plus 5 per 55-query file. Oscar could not be woken.
  - That gives **68–72 per scorable cohort**, inside Jim's 40–80 target for a CI half-width of about 10 pts. There are 28 no-match queries.
- **Replay:** on the SAME frozen pre-10:54Z copies. The contamination guard also covers the round-2 file names; none tripped.
- **Labels:**
  - JIM, primary, all 373: 1,027 round-1 labels reused where the item is identical (the same query, source and text), and 6,325 new.
  - DWIGHT, second labeller: a random 20% of Phyllis's queries (32).
  - PHYLLIS, second labeller: a random 20% of Dwight's (32), plus her round-1 20%.
  - Kappa is computed over all the second labels (≥ 0.4 required). The Human spot-checks 10.
- **The gate is QUALITY AND SPEED together** (the Human; Jim's method, MEMORY-154-AUDIT Addendum 2):
  - quality: the per-cohort ≥ −5 lower bound on NDCG@5 and recall@10 (semantic NDCG@5 reported first, the watch item);
  - speed, **end-to-end** through the wrapper an agent runs:
    - native warm p95 ≤ 250 ms;
    - worker-cold and model-cold p95 ≤ 2 s;
    - p95 ≤ 250 ms during a backfill;
    - native faster than legacy on p50 AND p95 in every cohort;
    - ≤ 1 Electron-as-Node process per call.
  - The results table is below, once the labels are in.

**History: god's first decision on gate 4, option (b) conditional (a gate-rule DEFERRAL, now superseded).**
- **1.1.54 may ship memory-154 ONLY legacy-default** (zero behaviour change), with `shadow` available.
- **Basis:**
  - overall native is significantly better on both metrics (both lower bounds > 0);
  - no cohort shows a significant regression;
  - kappa is 0.478;
  - the per-cohort failures are CI width at n = 8–12.
- **The per-cohort rule is NOT waived.** The spec's "95% CI lower bound ≥ −5 pts per cohort" moves to **gate 6**. It must pass on **shadow real-query** diagnostics, with enough queries per cohort, before any native or 10% cutover.
- **Watch item:** semantic NDCG@5 (point estimate −4.6).
- **The Human's spot-check (10 queries) is still required before the cut.**

**How gate 6 gets its per-cohort n** (built in this branch):
1. **Every shadow request writes a redacted row** to `log.jsonl` (`native-memory-shadow`). It carries:
   - its **cohort**, classified from the query's shape at capture (`classifyQuery`: wing-scoped / exact-identifier / punctuation / semantic), or `no-match` when legacy returned nothing;
   - both engines' **ranked source hashes** (`legacyRanked`, `nativeRanked`: sha256 of wing|source), plus latencies and overlap.
   - **No query or chunk text.** The per-cohort n is therefore visible from the log alone.
2. **Labelling needs text, so there is an opt-in, dated review window.**
   - It is set with `{"mode":"shadow","reviewCaptureUntil":"<ISO date>"}` in `<hive>/memory-engine.json`, and **stops by itself** at the date.
   - While it is open, the **worker** also appends the query text and both rankings (native with chunk text) to `<userData>/memory/<key>.shadow-review.jsonl`: beside the index, **never in the hive** (legacy mines agent folders), never in `log.jsonl`.
   - The file is kept open and rotated like the hive log.
3. **Reaching n.**
   - Real `mempalace search` traffic is sparse: 6 intents in all the transcripts before this build.
   - So the window is opened for a bounded period while agents work normally in shadow mode, and god and the Human decide its length and scope.
   - The review file is then turned into engine-blind label sheets. The same tooling (`native-memory-parity.cjs` / `-stats.cjs`) adds a reader for it, and a labeller outside the build does the labelling.
   - Gate 6 is scored per cohort on the real queries, with the ≥ −5 lower bound per cohort and a scorable n ≥ 8. At the observed variance, a certain pass needs more per cohort (see above).
   - **If a cohort cannot reach n in a reasonable window, that is reported, never assumed.**
4. **The rollout order is unchanged:** legacy (1.1.54 default) → shadow (diagnostics, the review window) → gate 6 → controlled cutover with the rollback drill.

## Rollback (1.1.54 → 1.1.53) and why it is safe

**What 1.1.54 never touches:**
- **The MemPalace store and config.** The native engine never opens, moves, mutates or deletes `<harnessHome>/palace` or `~/.mempalace`.
  - Its worker is never given the palace path.
  - A static test pins that no native-memory module names the palace, Chroma or MemPalace config, and that the worker config has no palace field.
- **The palace, byte for byte.** An Electron-backed test runs a worker's whole life (backfill, search, wake-up, status, a forced compaction) over a harness home that contains a palace. It asserts the palace tree is **byte-identical afterwards**: the same file list, sizes, SHA-256 and mtimes, with nothing added.
- **Legacy mining.** `memory.ts` is unchanged, so legacy MemPalace mining keeps running exactly as in 1.1.53, in every mode. The palace a rollback finds is current.

**Where the native index lives:** in its own path, `<userData>/memory/<sha256(hiveRoot)[:16]>.sqlite`.
- Next to it: `-wal`/`-shm`, one `.prior` after a compaction, and `.corrupt-*` on quarantine.
- It is disposable and rebuilt from the Markdown.

**New files in the hive:**
- `<hive>/memory-engine.json`, the flag. Absent means `legacy`, and 1.1.53 never reads it.
- `<hive>/bin/memory/mempalace{,.cmd}`, written only past `legacy`. 1.1.53 never puts them on PATH.

**Steps:**
1. Reinstall 1.1.53 (its installer or the in-app downgrade).
2. Restart the agents once, so their PATH and env are 1.1.53's: no shim, no `MEMORY_TOKEN`.
3. Nothing else is needed. The palace is intact and current, and `mempalace` resolves to the uv-installed CLI as before.
4. Optional cleanup, which 1.1.53 does not need: delete `<userData>/memory/`, `<hive>/memory-engine.json` and `<hive>/bin/memory/`.

**Rolling back within 1.1.54:** set `<hive>/memory-engine.json` to `{"mode":"fallback-legacy"}`. The very next `mempalace` call runs the legacy CLI, with no data migration.

## Operator runbook notes (Jim's audit, MEMORY-154-AUDIT.md)

- **Delete the gate-6 review file after labelling.** `<userData>/memory/<key>.shadow-review.jsonl` (and its rotated `*.shadow-review.<stamp>.jsonl`) holds query **and chunk text**. It is kept whole while the review window is open (`keep: Infinity`). When the gate-6 labels are done, delete it with the app closed.
- **N3, worker down:** after 3 crashes within 10 minutes the worker stays down until the app restarts, and memory requests answer exit 3. Set `<hive>/memory-engine.json` to `{"mode":"fallback-legacy"}`: the next `mempalace` call runs the legacy CLI. Restart the app to retry native.
- **N4, a mode change takes effect for NEW agent spawns.** `MEMORY_TOKEN`, the endpoint and the PATH with the shim are injected at spawn. After moving from `legacy` to `shadow`/`native`, respawn the agents. The shim reads the mode on every call, so moving back to `fallback-legacy`/`legacy` takes effect at once for agents that already have the shim.
- **N2 (fixed here):** when the idle timer unloads the model, the worker tells main, and the next search gets the cold budget (2 s), not the warm one (250 ms). A test pins it.
- **For 1.1.55** (non-blocking):
  - **N5:** the model digest is checked once per worker life, at the first load; re-check on reload.
  - **N7:** the gate-2 smoke flag ships in the production binary (harmless: it only ever uses temp paths).
  - Keep the tokenizer parity (0 mismatches over 1,148 texts) as a regression check for any model bump.

## Open

1. **Gate 4 (expanded, quality + speed):** the replay and the speed bench have run. **The labels are pending** (Jim, all queries; Dwight and Phyllis, 20% cross). **The Human spot-check (10 queries) is required before the cut.**
2. **Opt-ins:** whether the 2 nested deliverables and any top-level notes join the allow-list (god and the owners).
3. **Not covered on this host:** the mac and Linux artifact smokes; the Defender/BitDefender install-time scan observation.
