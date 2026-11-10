const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {stageRuntime} = require('./build-orpheus-reachability.cjs');

test('stages the complete browser runtime without rewriting ESM worker or Wasm imports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orpheus-package-test-'));
  try {
    const source = path.join(root, 'source');
    const output = path.join(root, 'output');
    for (const directory of ['js', 'pkg'])
      mkdirSync(path.join(source, 'wasm', directory), {recursive: true});
    for (const name of ['orpheus-client.js', 'orpheus-ice.js', 'orpheus-worker.js']) {
      writeFileSync(
        path.join(source, 'wasm/js', name),
        `export const url = new URL('../pkg/core.wasm', import.meta.url); // ${name}`
      );
    }
    writeFileSync(
      path.join(source, 'wasm/pkg/orpheus_sdk_wasm.js'),
      'export default async function init() {}'
    );
    writeFileSync(
      path.join(source, 'wasm/pkg/orpheus_sdk_wasm_bg.wasm'),
      Buffer.from([0, 97, 115, 109])
    );

    stageRuntime(source, output, 'test-revision');

    assert.equal(JSON.parse(readFileSync(path.join(output, 'package.json'))).type, 'module');
    assert.equal(
      JSON.parse(readFileSync(path.join(output, 'build.json'))).revision,
      'test-revision'
    );
    for (const name of ['orpheus-client.js', 'orpheus-ice.js', 'orpheus-worker.js']) {
      assert.equal(
        readFileSync(path.join(output, 'js', name), 'utf8'),
        readFileSync(path.join(source, 'wasm/js', name), 'utf8')
      );
    }
    assert.deepEqual(
      readFileSync(path.join(output, 'pkg/orpheus_sdk_wasm_bg.wasm')),
      Buffer.from([0, 97, 115, 109])
    );
    assert.equal(existsSync(path.join(output, 'pkg/orpheus_sdk_wasm.js')), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('fails if a required runtime asset is missing instead of shipping an incomplete package', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orpheus-package-test-'));
  try {
    assert.throws(
      () => stageRuntime(root, path.join(root, 'output'), 'revision'),
      /Missing Orpheus runtime asset/
    );
    assert.equal(existsSync(path.join(root, 'output')), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
