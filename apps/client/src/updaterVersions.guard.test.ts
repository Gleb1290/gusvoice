import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const cargo = readFileSync(new URL('../../desktop/src-tauri/Cargo.toml', import.meta.url), 'utf8');
const client = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const desktop = JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'));
const CHECK = 'R365/versions/check/';

function limited(raw: string) {
  if (raw.length > 2_000_000) throw new Error('R365/versions/budget/source');
  return raw;
}

function majorMinor(value: string) {
  const match = /^[~^]?(\d+)\.(\d+)(?:\.|$)/.exec(value);
  assert.ok(match, 'R365/versions/setup/version');
  return `${Number(match[1])}.${Number(match[2])}`;
}

function cargoVersion(name: string, raw = cargo) {
  const matches = [...limited(raw).matchAll(new RegExp(`^${name}\\s*=\\s*(?:\\{\\s*version\\s*=\\s*)?"([^"]+)"`, 'gm'))];
  assert.equal(matches.length, 1, 'R365/versions/setup/cargo-dependency');
  return matches[0][1];
}

function checkPair(name: string, js: string, raw = cargo) {
  assert.equal(majorMinor(cargoVersion(name, raw)), majorMinor(js), CHECK + name + '-same-major-minor');
}

function failure(prefix: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
}

// Legacy ZIP-version/temporary-ignore checks are replaced by the all-level SAST gate.
// Keep only the independent Rust/JS compatibility contract in this file.

it('R365 Rust и JS plugin-updater согласованы по major.minor, различие patch допустимо', () => {
  const version = client.dependencies['@tauri-apps/plugin-updater'] as string;
  checkPair('tauri-plugin-updater', version);
  const [major, minor] = majorMinor(version).split('.').map(Number);
  checkPair('tauri-plugin-updater', `${major}.${minor}.999`);
  for (const wrong of [`${major}.${minor + 1}.0`, `${major + 1}.${minor}.0`]) {
    assert.throws(() => checkPair('tauri-plugin-updater', wrong), failure(CHECK + 'tauri-plugin-updater-same-major-minor'));
  }
});

it('R365 Rust tauri и CLI имеют одну major.minor, несовпадение обеих частей обнаруживается', () => {
  const version = desktop.devDependencies['@tauri-apps/cli'] as string;
  checkPair('tauri', version);
  const [major, minor] = majorMinor(version).split('.').map(Number);
  checkPair('tauri', `${major}.${minor}.999`);
  for (const wrong of [`${major}.${minor + 1}.0`, `${major + 1}.${minor}.0`]) {
    assert.throws(() => checkPair('tauri', wrong), failure(CHECK + 'tauri-same-major-minor'));
  }
});
