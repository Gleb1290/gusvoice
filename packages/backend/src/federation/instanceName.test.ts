import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { FederationDeps } from './state.js';

const source = readFileSync(new URL('./instance.ts', import.meta.url), 'utf8');
type NameApi = Pick<typeof import('./instance.js'), 'neighborVisibleName'>;

function fixture(meta: unknown, local: unknown, raw = source) {
  const settings = new Map<string, unknown>([['federation_meta', meta], ['instance', local]]);
  const reads: string[] = [];
  const table = { key: 'settings-key', value: 'settings-value' };
  let deps: FederationDeps | undefined;
  const module = { exports: {} as NameApi };
  const imports: Record<string, unknown> = {
    'drizzle-orm': { eq(column: unknown, key: string) { assert.equal(column, table.key); return key; } },
    '../db/schema.js': { instanceSettings: table },
    '../db/index.js': { db: {
      select(fields: { value: unknown }) {
        assert.equal(fields.value, table.value);
        return { from(from: unknown) {
          assert.equal(from, table);
          return { where(key: string) {
            assert.ok(key === 'federation_meta' || key === 'instance', 'читается только мета имени');
            reads.push(key);
            return { limit(n: number) {
              assert.equal(n, 1);
              const value = settings.get(key);
              return Promise.resolve(value === undefined ? [] : [{ value }]);
            } };
          } };
        } };
      },
    } },
    '../env.js': { env: { clientOrigin: 'https://instance.invalid', federation: {
      enabled: false, dmEnabled: false, dataDir: '/synthetic/keys', keyPassphrase: '', apiBase: 'https://instance.invalid/api',
    } } },
    './keystore.js': { createKeystore: () => ({}) },
    './state.js': { createFederation(input: FederationDeps) { deps = input; return {}; } },
  };
  // Целый production-модуль: исполняется и настоящий loadInstanceMeta, не только копия формулы имени.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, URL, process: { env: {} },
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `описан импорт ${id}`); return imports[id]; },
    setInterval() { assert.fail('Чтение имени не запускает фоновую работу'); },
  });
  assert.ok(deps, 'экземпляр получает loadInstanceMeta');
  return { api: module.exports, settings, reads, load: deps.loadInstanceMeta };
}

it('R279 явное имя для соседей имеет приоритет и не требует чтения локального названия', async () => {
  // Новое умолчание не должно затирать выбранное держателем отдельное имя федерации.
  const f = fixture({ name: 'Для соседей', iconHash: 'icon-hash' }, { name: 'Для своих' });
  assert.equal(f.api.neighborVisibleName('Для соседей', 'Для своих'), 'Для соседей');
  const result = await f.load();
  assert.equal(result.name, 'Для соседей'); assert.equal(result.iconHash, 'icon-hash');
  assert.deepEqual(f.reads, ['federation_meta']);
});

it('R279 пустое имя федерации читает обычное имя из ключа instance и сохраняет иконку', async () => {
  // Чтение не должно вместо имени показывать домен или перезаписывать отдельное поле в базе.
  for (const meta of [undefined, null, {}, { name: '' }, { name: 42 }]) {
    const f = fixture(meta, { name: '  Название инстанса  ' });
    const result = await f.load();
    assert.equal(result.name, 'Название инстанса'); assert.equal(result.iconHash, null);
    assert.deepEqual(f.reads, ['federation_meta', 'instance']);
    assert.equal(f.settings.get('federation_meta'), meta, 'load не записывает подстановку в федеративную мету');
  }
  const f = fixture({ name: '', iconHash: 'existing-icon' }, { name: 'Своё' });
  assert.equal((await f.load()).iconHash, 'existing-icon');
});

it('R279 отсутствие обоих названий возвращает null для показа домена, а не строку undefined', async () => {
  // Локальная установка без названия остаётся допустимой: сосед сам выберет домен из визитки.
  for (const local of [undefined, null, {}, { name: '' }, { name: '   ' }, { name: 99 }]) {
    const f = fixture({}, local);
    assert.equal((await f.load()).name, null);
  }
  assert.equal(fixture({}, {}).api.neighborVisibleName('  ', '  Локальное  '), 'Локальное');
});

it('R279 обычное название ровно из сорока символов уходит соседу целиком', async () => {
  // Граница протокола включительна: допустимый последний символ не должен исчезнуть.
  const f = fixture({}, { name: 'я'.repeat(40) });
  assert.equal((await f.load()).name, 'я'.repeat(40));
  assert.equal(f.api.neighborVisibleName(null, 'я'.repeat(40)), 'я'.repeat(40));
});

async function truncatedName(raw = source) {
  const f = fixture({ name: '' }, { name: `  ${'я'.repeat(40)}х  ` }, raw);
  assert.equal((await f.load()).name, 'я'.repeat(40), 'R279 визитка обрезает локальное имя до сорока символов');
  assert.equal(f.api.neighborVisibleName(null, `${'я'.repeat(40)}х`), 'я'.repeat(40));
}
it('R279 сорок первый символ локального названия не нарушает предел визитки', () => {
  // Имя обычного инстанса может быть длиннее федеративного: проверяем реальную подстановку.
  return truncatedName();
});

it('R279 новое локальное название видно в следующей визитке без перезапуска и без записи федеративного имени', async () => {
  // Кеш старого имени оставил бы соседям прошлое название после сохранения на вкладке Инстанс.
  const f = fixture({}, { name: 'Первое' });
  assert.equal((await f.load()).name, 'Первое');
  f.settings.set('instance', { name: 'Второе' });
  assert.equal((await f.load()).name, 'Второе');
  assert.deepEqual(f.reads, ['federation_meta', 'instance', 'federation_meta', 'instance']);
  assert.deepEqual(f.settings.get('federation_meta'), {});
});

it('R279 потеря обрезки обнаруживается настоящим loadInstanceMeta после проверки оригинала', async () => {
  // Мутант корректен синтаксически и загружается: ошибкой считается именно слишком длинная визитка.
  await truncatedName(); const from = 'own.slice(0, NEIGHBOR_NAME_MAX)';
  assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(() => truncatedName(source.replace(from, 'own')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R279 визитка обрезает'));
});

async function whitespaceName(raw = source) {
  for (const name of [' ', ' \t\n ', '\u00a0\u2003']) {
    const meta = Object.freeze({ name, iconHash: 'saved-icon' });
    const f = fixture(meta, { name: '  Обычное имя  ' }, raw);
    const result = await f.load();
    assert.equal(result.name, 'Обычное имя', 'R280 пробельное имя использует обычное название инстанса');
    assert.equal(result.iconHash, 'saved-icon');
    assert.deepEqual(f.reads, ['federation_meta', 'instance']);
    assert.equal(f.settings.get('federation_meta'), meta, 'подстановка не сохраняет новое федеративное имя');
    const empty = fixture(meta, {}, raw);
    assert.equal((await empty.load()).name, null, 'без обычного имени сосед по-прежнему выбирает домен');
  }
}

it('R280 пробелы в имени для соседей подставляют обычное название, не теряя иконку и не меняя мету', () => {
  // Legacy-строка из пробелов не должна подавлять fallback, который уже работает для пустой строки.
  return whitespaceName();
});

it('R280 удаление trim обнаруживается настоящим loadInstanceMeta после проверки оригинала', async () => {
  // Чистая neighborVisibleName уже делает trim; важно поймать потерю чтения локального имени в обвязке.
  await whitespaceName();
  const from = "const fedName = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name : null;";
  assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(() => whitespaceName(source.replace(from, from.replace('meta.name.trim().length', 'meta.name.length'))),
    (e: unknown) => e instanceof assert.AssertionError
      && e.message.split('\n')[0] === 'R280 пробельное имя использует обычное название инстанса');
});
