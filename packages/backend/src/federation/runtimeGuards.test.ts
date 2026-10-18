import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import ts from 'typescript';
import { linkThreatsEnabled } from '../linkThreatsRules.js';
import { isBlockedAddress } from '../safeFetch.js';
import { devPeersProblem, parseDevPeers } from './devPeers.js';
import type { FederationDeps } from './state.js';
import type { Keystore } from './keystore.js';

function loadModule(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): Record<string, unknown> {
  const module = { exports: {} };
  // Исполняется целый модуль, а не вырезанный геттер: потеря fedRuntime/замыкания тоже должна ломать контракт.
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, URL, ...globals,
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Неописанный импорт ${file}: ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}

function loadEnv(federationVars: Record<string, string> = {}): typeof import('../env.js').env {
  // Только синтетические значения: окружение машины/настоящий .env не читается и не меняется.
  const processEnv = {
    DATABASE_URL: 'postgresql://test.invalid/test',
    JWT_SECRET: 'r257-jwt-synthetic-no-real-credential',
    LIVEKIT_API_KEY: 'r257-api',
    LIVEKIT_API_SECRET: 'r257-livekit-synthetic-no-real-credential',
    LIVEKIT_URL_EXTERNAL: 'wss://test.invalid',
    ...federationVars,
  };
  return loadModule('../env.ts', {
    '@gusvoice/shared': shared,
    'node:net': { isIP },
    './linkThreatsRules.js': { linkThreatsEnabled },
    './federation/devPeers.js': { devPeersProblem, parseDevPeers },
    './safeFetch.js': { isBlockedAddress },
  }, { process: { env: processEnv } }).env as typeof import('../env.js').env;
}

function loadInstance() {
  const flags = {
    enabled: false, dmEnabled: false, dataDir: '/synthetic/r257-fed-keys',
    keyPassphrase: 'r257-initial', apiBase: 'https://test.invalid/api',
  };
  const stores: Array<{ dir: string; passphrase: string; store: Keystore }> = [];
  let deps: FederationDeps | undefined;
  const exported = loadModule('./instance.ts', {
    'drizzle-orm': { eq: () => { throw new Error('Запросы базы не разрешены'); } },
    '../db/index.js': { db: new Proxy({}, { get() { throw new Error('База не должна читаться при выборе пароля'); } }) },
    '../db/schema.js': { instanceSettings: {} },
    '../env.js': { env: { federation: flags, clientOrigin: 'https://test.invalid' } },
    './keystore.js': {
      createKeystore(dir: string, passphrase: string) {
        const store = { dir } as Keystore;
        stores.push({ dir, passphrase, store });
        return store;
      },
    },
    './state.js': {
      createFederation(input: FederationDeps) { deps = input; return {}; },
    },
  }, {
    process: { env: {} },
    console: { log() { assert.fail('Пароль и его выбор не логируются'); }, warn() { assert.fail('Неожиданный лог'); }, error() { assert.fail('Неожиданный лог'); } },
    setInterval() { throw new Error('Выбор пароля не должен запускать фоновые задачи'); },
  });
  assert.ok(deps, 'instance передаёт живые зависимости в createFederation');
  return { flags, stores, deps, usePassphrase: exported.useFederationPassphrase as typeof import('./instance.js').useFederationPassphrase };
}

describe('флаги runtime отделены от неизменного источника .env (#224)', () => {
  it('по умолчанию выключено; изменения сеттеров видны сразу, источник panel не превращается в env', () => {
    const flags = loadEnv().federation;
    assert.equal(flags.enabled, false);
    assert.equal(flags.dmEnabled, false);
    assert.equal(flags.envEnabled, false);
    assert.equal(flags.envDmEnabled, false);
    flags.enabled = true;
    assert.equal(flags.enabled, true);
    assert.equal(flags.dmEnabled, false);
    flags.dmEnabled = true;
    assert.equal(flags.dmEnabled, true);
    flags.enabled = false;
    assert.equal(flags.enabled, false);
    assert.equal(flags.dmEnabled, false, 'общий тумблер сильнее сохранённого флага ЛС');
    flags.enabled = true;
    assert.equal(flags.dmEnabled, true);
    flags.dmEnabled = false;
    assert.equal(flags.dmEnabled, false);
    assert.equal(flags.enabled, true);
    assert.equal(flags.envEnabled, false);
    assert.equal(flags.envDmEnabled, false);
  });

  it('включение из env распознаётся без учёта регистра и не меняет источник при runtime-переключениях', () => {
    const flags = loadEnv({ FEDERATION_ENABLED: 'TrUe', FEDERATION_DM_ENABLED: 'TRUE' }).federation;
    assert.equal(flags.enabled, true);
    assert.equal(flags.dmEnabled, true);
    assert.equal(flags.envEnabled, true);
    assert.equal(flags.envDmEnabled, true);
    flags.enabled = false;
    flags.dmEnabled = false;
    assert.equal(flags.enabled, false);
    assert.equal(flags.dmEnabled, false);
    assert.equal(flags.envEnabled, true);
    assert.equal(flags.envDmEnabled, true, 'признак блокировки в панели — снимок env, не текущее состояние');
  });

  it('одна переменная ЛС не открывает федерацию и не объявляет env-блокировку ЛС', () => {
    const flags = loadEnv({ FEDERATION_DM_ENABLED: 'true' }).federation;
    assert.equal(flags.enabled, false);
    assert.equal(flags.dmEnabled, false);
    assert.equal(flags.envDmEnabled, false);
    flags.enabled = true;
    assert.equal(flags.dmEnabled, false, 'начальное значение ЛС требует обоих флагов');
    flags.dmEnabled = true;
    assert.equal(flags.dmEnabled, true, 'включение ЛС из панели остаётся возможно');
    assert.equal(flags.envDmEnabled, false);
  });
});

describe('живой экземпляр федерации получает новые зависимости без пересоздания (#224)', () => {
  it('useFederationPassphrase меняет хранилище и источник, сохраняя каталог ключей', () => {
    const { stores, deps, usePassphrase } = loadInstance();
    assert.equal(stores.length, 1);
    assert.equal(deps.keystore, stores[0].store);
    assert.equal(deps.passphraseSource?.(), 'env');
    usePassphrase('r257-from-base', 'base');
    assert.equal(stores.length, 2);
    assert.equal(stores[1].dir, stores[0].dir);
    assert.equal(stores[1].passphrase, 'r257-from-base');
    assert.equal(deps.keystore, stores[1].store, 'зависимость не должна остаться снимком первого хранилища');
    assert.notEqual(deps.keystore, stores[0].store);
    assert.equal(deps.passphraseSource?.(), 'base');
    usePassphrase('r257-from-env', 'env');
    assert.equal(stores.length, 3);
    assert.equal(stores[2].dir, stores[0].dir);
    assert.equal(stores[2].passphrase, 'r257-from-env');
    assert.equal(deps.keystore, stores[2].store);
    assert.equal(deps.passphraseSource?.(), 'env');
  });

  it('зависимости enabled и dmEnabled читают актуальные флаги, а не снимок импорта instance', () => {
    const { flags, deps } = loadInstance();
    assert.equal(deps.enabled, false);
    assert.equal(deps.dmEnabled, false);
    flags.enabled = true;
    flags.dmEnabled = true;
    assert.equal(deps.enabled, true);
    assert.equal(deps.dmEnabled, true);
    flags.enabled = false;
    flags.dmEnabled = false;
    assert.equal(deps.enabled, false);
    assert.equal(deps.dmEnabled, false);
  });
});
