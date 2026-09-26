'use strict';
/*
 * NATIVE-MEMORY gate 4, the judgement half (spec section 4, Jim R5). Joins the independent
 * labellers' 0/1/2 labels (label-sheet.json, filled) with the engine key and computes, per query,
 * NDCG@5 and recall@10 for legacy and native, then a PAIRED BOOTSTRAP over queries of
 * (native - legacy). The gate: the 95% CI lower bound >= -0.05 (5 points) overall and in every
 * cohort with n >= 8; smaller cohorts are reported, not gated.
 *
 * Scope-adjusted (the gated variant, per the spec): a legacy hit whose source the allow-list
 * EXCLUDES (MINE-SCOPE: data, nested, evidence copies) is an intentional loss, so it is dropped
 * from the judged pool instead of being scored against native. The raw variant is reported too.
 *
 *   node scripts/native-memory-parity-stats.cjs --labels <label-sheet.json> --key <label-key.json>
 *        --public <parity-public.json> [--second <second labeller's sheet>] [--seed N]
 */
const fs = require('fs');

function dcg(gains) { return gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0); }
function ndcgAt(rankedGains, poolGains, k) {
  const ideal = [...poolGains].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg === 0 ? null : dcg(rankedGains.slice(0, k)) / idcg;
}
function recallAt(rankedGains, poolGains, k) {
  const rel = poolGains.filter((g) => g >= 1).length;
  return rel === 0 ? null : rankedGains.slice(0, k).filter((g) => g >= 1).length / rel;
}

/** Per-query metrics for one engine. `items`: [{ gain, legacyRank, nativeRank, excluded }]. */
function perQuery(items, adjust) {
  const pool = items.filter((it) => !(adjust && it.excluded));
  const poolGains = pool.map((it) => it.gain);
  const ranked = (rk) => pool.filter((it) => it[rk] !== null).sort((a, b) => a[rk] - b[rk]).map((it) => it.gain);
  return {
    legacy: { ndcg5: ndcgAt(ranked('legacyRank'), poolGains, 5), recall10: recallAt(ranked('legacyRank'), poolGains, 10) },
    native: { ndcg5: ndcgAt(ranked('nativeRank'), poolGains, 5), recall10: recallAt(ranked('nativeRank'), poolGains, 10) }
  };
}

/** Seeded PRNG (mulberry32) so a bootstrap is reproducible. */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Paired bootstrap of mean(native - legacy) over queries: { mean, lo, hi } (95% percentile CI). */
function pairedBootstrap(diffs, n = 10000, seed = 1) {
  if (!diffs.length) return null;
  const r = rng(seed);
  const means = [];
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(r() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  return { mean: diffs.reduce((s, x) => s + x, 0) / diffs.length, lo: means[Math.floor(0.025 * n)], hi: means[Math.floor(0.975 * n)], n: diffs.length };
}

/** Cohen's kappa over the items both labellers judged (3 categories). */
function kappa(a, b) {
  const pairs = Object.keys(a).filter((k) => b[k] !== undefined && a[k] !== null && b[k] !== null).map((k) => [a[k], b[k]]);
  if (!pairs.length) return null;
  const po = pairs.filter(([x, y]) => x === y).length / pairs.length;
  let pe = 0;
  for (const c of [0, 1, 2]) pe += (pairs.filter(([x]) => x === c).length / pairs.length) * (pairs.filter(([, y]) => y === c).length / pairs.length);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function evaluate({ sheet, key, pub, second = null, seed = 1, gate = -0.05, minCohort = 8, exclude = [] }) {
  const labels = {};
  for (const q of sheet.queries) for (const it of q.items) labels[it.item] = it.label;
  const scopeOf = {};
  for (const r of pub.results) for (const [i, x] of r.legacy.entries()) scopeOf[`${r.qid}|${i + 1}`] = x.scope;
  const rows = [];
  for (const q of key) {
    if (exclude.includes(q.qid)) continue;   // reported, never scored (e.g. an extraction artifact)
    const items = q.items.map((it) => ({ gain: labels[it.item], legacyRank: it.legacyRank, nativeRank: it.nativeRank, excluded: it.legacyRank !== null && it.nativeRank === null && scopeOf[`${q.qid}|${it.legacyRank}`] === 'excluded' }));
    if (items.some((it) => it.gain === null || it.gain === undefined)) continue;   // unlabelled
    rows.push({ qid: q.qid, cohort: q.cohort.replace(/\+stale$/, ''), raw: perQuery(items, false), adjusted: perQuery(items, true) });
  }
  const summarise = (variant) => {
    const out = {};
    const groups = { overall: rows, ...Object.fromEntries([...new Set(rows.map((r) => r.cohort))].map((c) => [c, rows.filter((r) => r.cohort === c)])) };
    for (const [name, rs] of Object.entries(groups)) {
      const m = {};
      for (const metric of ['ndcg5', 'recall10']) {
        const diffs = rs.map((r) => [r[variant].native[metric], r[variant].legacy[metric]]).filter(([n, l]) => n !== null && l !== null).map(([n, l]) => n - l);
        const bs = pairedBootstrap(diffs, 10000, seed);
        m[metric] = bs;
      }
      // A query with NO relevant item in the pool has no NDCG/recall (nothing to find: the
      // no-match cohort, by design). Such queries are reported, not scored, so a cohort is gated
      // on the queries that CAN be scored, never on its raw size.
      const scored = Math.min(m.ndcg5 ? m.ndcg5.n : 0, m.recall10 ? m.recall10.n : 0);
      const gated = name === 'overall' || scored >= minCohort;
      m.n = rs.length;
      m.scored = scored;
      m.gated = gated;
      m.pass = !gated ? null : ['ndcg5', 'recall10'].every((k) => m[k] && m[k].lo >= gate);
      out[name] = m;
    }
    return out;
  };
  const result = { labelledQueries: rows.length, excluded: exclude, gate: { ciLowerBound: gate, minCohort }, adjusted: summarise('adjusted'), raw: summarise('raw') };
  result.pass = result.adjusted.overall.pass === true && Object.values(result.adjusted).every((c) => c.pass !== false);
  if (second) {
    const b = {};
    for (const q of second.queries) for (const it of q.items) b[it.item] = it.label;
    result.kappa = kappa(labels, b);
  }
  return result;
}

module.exports = { dcg, ndcgAt, recallAt, perQuery, pairedBootstrap, kappa, evaluate };

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const res = evaluate({ sheet: read(arg('--labels')), key: read(arg('--key')), pub: read(arg('--public')), // --second accepts several sheets, comma-separated (e.g. round 2's cross-assigned labellers);
  // they cover different queries, so their items are merged for one kappa.
  second: arg('--second') ? { queries: arg('--second').split(',').flatMap((f) => read(f).queries) } : null, seed: Number(arg('--seed') || 1), exclude: (arg('--exclude') || '').split(',').filter(Boolean) });
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = res.pass ? 0 : 1;
}
