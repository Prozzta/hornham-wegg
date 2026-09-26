// NATIVE-MEMORY packaging prune (spec section 5.4): onnxruntime-node ships CPU binaries for every
// platform and arch (~210 MB) plus DirectML (a GPU provider). The engine needs exactly the target's
// CPU runtime. They are asarUnpacked, so they are real files under app.asar.unpacked here and can
// be removed before the installer is made. sqlite-vec's other-platform packages are optional
// dependencies that are not installed off their own platform, so they need nothing.
const fs = require('fs');
const path = require('path');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;           // win32 | darwin | linux
  const arch = ARCH[context.arch] ?? String(context.arch);
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const bin = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(bin)) return;
  let removed = 0;
  const rm = (p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; } };
  for (const p of fs.readdirSync(bin)) {
    if (p !== platform) { rm(path.join(bin, p)); continue; }
    for (const a of fs.readdirSync(path.join(bin, p))) {
      if (arch !== 'universal' && a !== arch) rm(path.join(bin, p, a));
    }
  }
  for (const a of fs.existsSync(path.join(bin, platform)) ? fs.readdirSync(path.join(bin, platform)) : []) {
    rm(path.join(bin, platform, a, 'DirectML.dll'));
  }
  console.log(`  • native-memory prune: kept onnxruntime ${platform}/${arch} CPU only (${removed} paths removed)`);
};
