const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const source = require('./orpheus-reachability-source.json');

const runtimeFiles = [
  'js/orpheus-client.js',
  'js/orpheus-ice.js',
  'js/orpheus-worker.js',
  'pkg/orpheus_sdk_wasm.js',
  'pkg/orpheus_sdk_wasm_bg.wasm',
];

function stageRuntime(sourceRoot, outputRoot, revision) {
  for (const file of runtimeFiles) {
    if (!existsSync(path.join(sourceRoot, 'wasm', file))) {
      throw new Error(`Missing Orpheus runtime asset: ${file}`);
    }
  }
  for (const file of runtimeFiles) {
    const destination = path.join(outputRoot, file);
    mkdirSync(path.dirname(destination), {recursive: true});
    copyFileSync(path.join(sourceRoot, 'wasm', file), destination);
  }
  writeFileSync(path.join(outputRoot, 'package.json'), JSON.stringify({type: 'module'}));
  const wasmSha256 = createHash('sha256')
    .update(readFileSync(path.join(outputRoot, 'pkg/orpheus_sdk_wasm_bg.wasm')))
    .digest('hex');
  writeFileSync(
    path.join(outputRoot, 'build.json'),
    JSON.stringify({revision, wasmSha256}, null, 2)
  );
}

function build() {
  const directory = process.env.ORPHEUS_SDK_DIR
    ? path.resolve(process.env.ORPHEUS_SDK_DIR)
    : path.join(tmpdir(), 'webex-orpheus-source', source.revision);
  if (!existsSync(directory)) {
    mkdirSync(path.dirname(directory), {recursive: true});
    execFileSync('git', ['clone', '--no-checkout', source.repository, directory], {
      stdio: 'inherit',
    });
    execFileSync('git', ['checkout', '--detach', source.revision], {
      cwd: directory,
      stdio: 'inherit',
    });
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  if (revision !== source.revision)
    throw new Error(`Orpheus source must be pinned to ${source.revision}`);
  execFileSync(
    'git',
    ['diff', '--exit-code', 'HEAD', '--', 'Cargo.lock', 'Cargo.toml', 'common', 'wasm'],
    {
      cwd: directory,
      stdio: 'pipe',
    }
  );
  execFileSync('wasm-pack', ['build', 'wasm', '--scope', 'webex', '--target', 'web', '--release'], {
    cwd: directory,
    env: {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2'},
    stdio: 'inherit',
  });
  stageRuntime(
    directory,
    path.resolve(__dirname, '../packages/@webex/plugin-meetings/dist/reachability/orpheus'),
    revision
  );
}

module.exports = {stageRuntime};
if (require.main === module) build();
