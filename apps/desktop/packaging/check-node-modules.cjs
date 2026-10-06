// electron-builder afterPack hook: fail the build if any node_modules package in app.asar differs
// from the version Node resolves for that same location in the source tree.
//
// Why: under pnpm's `node-linker=hoisted`, electron-builder's pnpm collector has placed the wrong
// version of a nested duplicate (formdata-node's web-streams-polyfill came out as 3.3.3, whose main
// entry polyfills globalThis.ReadableStream, instead of 4.0.0-beta.3). That silently broke every
// fetch() body read in the packaged main process while the unpackaged app worked.
const fs = require('fs');
const path = require('path');

const desktopDir = path.join(__dirname, '..');

// @electron/asar is a dependency of electron-builder; resolve it from there.
function loadAsar() {
  const builderLib = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [desktopDir] }));
  return require(require.resolve('@electron/asar', { paths: [builderLib] }));
}

// Directory Node would load `name` from when required by code in `fromDir` (node_modules lookup,
// ignoring "exports", which is enough to compare versions).
function sourcePackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

function checkAsar(asarPath) {
  const asar = loadAsar();
  const files = asar.listPackage(asarPath).map((f) => f.split(path.sep).join('/'));
  // Package roots only: node_modules/<name>/package.json, at any nesting depth.
  const manifests = files.filter((f) => /^\/(node_modules\/(@[^/]+\/)?[^/]+\/)+package\.json$/.test(f));
  const problems = [];
  const shipped = new Map();   // node_modules/a/node_modules/b -> package.json
  for (const manifest of manifests) {
    const pkgDir = manifest.slice(1, -'/package.json'.length);   // node_modules/a/node_modules/b
    const parts = pkgDir.split('/node_modules/');
    const name = parts[parts.length - 1].replace(/^node_modules\//, '');
    // Walk the same chain of parents in the source tree, starting from the desktop app.
    let fromDir = desktopDir;
    for (const parent of parts.slice(0, -1).map((p) => p.replace(/^node_modules\//, ''))) {
      fromDir = fromDir && sourcePackageDir(parent, fromDir);
    }
    // @electron/asar splits archive paths on the native separator, so hand it backslashes on Windows.
    let json;
    try {
      json = JSON.parse(asar.extractFile(asarPath, manifest.slice(1).split('/').join(path.sep)).toString('utf8'));
    } catch (e) {
      problems.push(`${pkgDir}: package.json unreadable in app.asar (${e.message})`);
      continue;
    }
    if (json.version === undefined) continue;   // package.json files without a version (module-type markers)
    shipped.set(pkgDir, { json, sourceDir: fromDir && sourcePackageDir(name, fromDir) });
    const expectedDir = shipped.get(pkgDir).sourceDir;
    const expected = expectedDir ? versionOf(expectedDir) : null;
    if (expected !== json.version) problems.push(`${pkgDir}: packaged ${json.version}, source resolves ${expected ?? 'nothing'}`);
  }

  // Completeness: every dependency of a shipped package must resolve inside the archive. Outside it,
  // Node keeps walking up the real filesystem, so a gap passes in release/win-unpacked (inside the
  // repo, whose node_modules fill it) and only breaks once installed. This is how ajv went missing.
  const resolvesInArchive = (pkgDir, dep) => {
    const chain = pkgDir.split('/node_modules/');
    for (let i = chain.length; i >= 1; i--) {
      if (shipped.has(`${chain.slice(0, i).join('/node_modules/')}/node_modules/${dep}`)) return true;
    }
    return shipped.has(`node_modules/${dep}`);
  };
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(desktopPkg.dependencies || {})) {
    if (!shipped.has(`node_modules/${dep}`)) problems.push(`node_modules/${dep}: a dependency of the app, missing from app.asar`);
  }
  for (const [pkgDir, { json, sourceDir }] of shipped) {
    const optional = json.optionalDependencies || {};
    for (const dep of Object.keys({ ...json.dependencies, ...optional })) {
      // Optional deps count only when installed in the source tree (platform binaries for this OS).
      if (dep in optional && !(sourceDir && sourcePackageDir(dep, sourceDir))) continue;
      if (!resolvesInArchive(pkgDir, dep)) problems.push(`${pkgDir} needs ${dep}, which is missing from app.asar`);
    }
  }
  return { checked: shipped.size, problems };
}

module.exports = async function afterPack(context) {
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  const { checked, problems } = checkAsar(asarPath);
  if (problems.length) {
    throw new Error(`app.asar node_modules differ from the source tree (${problems.length}):\n  ${problems.join('\n  ')}`);
  }
  console.log(`  • node_modules check  ${checked} packages match the source tree`);
};

// Standalone: node packaging/check-node-modules.cjs release/win-unpacked/resources/app.asar
if (require.main === module) {
  const { checked, problems } = checkAsar(path.resolve(process.argv[2]));
  console.log(problems.length ? problems.join('\n') : `all ${checked} packages match the source tree`);
  process.exit(problems.length ? 1 : 0);
}
