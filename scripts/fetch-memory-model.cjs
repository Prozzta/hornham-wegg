#!/usr/bin/env node
/*
 * NATIVE-MEMORY: provision the bundled embedding model into resources/models/<dir>/ BEFORE a
 * build (the app never downloads a model at runtime; spec section 5). Every file is checked
 * against the SHA-256 pinned in resources/models/native-memory-manifest.json; a mismatch fails.
 *
 *   node scripts/fetch-memory-model.cjs [--from <local cache dir containing the model files>]
 *
 * --from (or MUNDER_MODEL_CACHE) copies from a local cache, e.g. a Transformers.js cache's
 * `Xenova/all-MiniLM-L6-v2` directory. Without it the files are downloaded from the manifest's
 * source (HuggingFace). Either way the digests decide.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const dest = path.join(ROOT, 'resources', 'models', manifest.model.dir);
const argFrom = process.argv.indexOf('--from');
const from = argFrom > 0 ? process.argv[argFrom + 1] : process.env.MUNDER_MODEL_CACHE || null;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString()));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  let ok = 0;
  for (const [rel, want] of Object.entries(manifest.model.files)) {
    const out = path.join(dest, ...rel.split('/'));
    if (fs.existsSync(out) && sha(fs.readFileSync(out)) === want) { ok++; continue; }
    const buf = from
      ? fs.readFileSync(path.join(from, ...rel.split('/')))
      : await download(`${manifest.model.source}/resolve/main/${rel}`);
    const got = sha(buf);
    if (got !== want) throw new Error(`${rel}: SHA-256 ${got}, the manifest pins ${want}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    ok++;
  }
  console.log(`native-memory model: ${ok}/${Object.keys(manifest.model.files).length} files verified in ${path.relative(ROOT, dest)}`);
})().catch((e) => { console.error(`fetch-memory-model: ${e.message}`); process.exit(1); });
