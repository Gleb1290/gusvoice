import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './linkThreatsRules.js';
import * as attachmentRules from './attachmentRules.js';
import * as ogParse from './ogParse.js';

// Исполняем целые модули; заменены только границы окружения, БД и I/O, не проверяемая логика.
function load<T>(name: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, source?: string): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source ?? readFileSync(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, URL, Buffer, AbortSignal, Date,
    console: { log() {}, warn() {} },
    require(spec: string) {
      assert.ok(Object.hasOwn(imports, spec), `неожиданный импорт ${spec}`);
      return imports[spec];
    },
    ...globals,
  });
  return module.exports as T;
}

function runtime(enabled = true, files: string[] = [], read: (file: string) => Promise<string> = async () => '',
  globals: Record<string, unknown> = {}) {
  return load<typeof import('./linkThreats.js')>('./linkThreats.ts', {
    './env.js': { env: { linkThreats: { enabled, files, urls: [] } } },
    './linkThreatsRules.js': rules,
    'node:fs/promises': { readFile: read },
  }, { fetch() { throw new Error('сеть запрещена в этом тесте'); }, ...globals });
}

function manualTimers() {
  const pending: { callback: () => void; delay: number; unreferenced: boolean }[] = [];
  return {
    pending,
    setTimeout(callback: () => void, delay: number) {
      const timer = { callback, delay, unreferenced: false };
      pending.push(timer);
      return { unref() { timer.unreferenced = true; } };
    },
    async tick() {
      const timer = pending.shift();
      assert.ok(timer, 'ожидается запланированный тик');
      timer.callback();
      // tick запускается через void: пропускаем только микрозадачи чтения одного файла,
      // refresh и продолжения worker, без часов, настоящих таймеров и I/O.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

function serializer(threats: typeof import('./linkThreats.js'), source?: string) {
  const imports: Record<string, unknown> = {
    '@gusvoice/shared': shared, './linkThreats.js': threats,
  };
  for (const spec of ['./auth.js', './superAdminRules.js', './env.js', './federation/instanceLabels.js',
    './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js']) imports[spec] = {};
  return load<typeof import('./serialize.js')>('./serialize.ts', imports, {}, source);
}

function message(content: string) {
  return { id: 'message', channelId: 'channel', content, createdAt: new Date(0), editedAt: null,
    author: { id: 'user', username: 'goose', displayName: 'Гусь', avatarUrl: null, createdAt: new Date(0) } };
}

describe('R148 локальные списки угроз и серверные потребители без БД', () => {
  it('выключенный worker не планирует ни первый тик, ни чтение списка', () => {
    const timers = manualTimers();
    const threats = runtime(false, ['list'], async () => { throw new Error('не должно читаться'); },
      { setTimeout: timers.setTimeout });
    threats.startLinkThreatsWorker();
    assert.equal(timers.pending.length, 0);
  });

  it('worker ждёт 20 секунд до первого чтения, после успеха сутки, после отказа час и сохраняет список', async () => {
    const timers = manualTimers();
    let reads = 0;
    let fail = false;
    const threats = runtime(true, ['list'], async () => {
      reads++;
      if (fail) throw new Error('временный отказ');
      return 'evil.example';
    }, { setTimeout: timers.setTimeout });
    threats.startLinkThreatsWorker();
    assert.equal(reads, 0);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delay, 20_000);
    assert.equal(timers.pending[0].unreferenced, true);
    await timers.tick();
    assert.equal(reads, 1);
    assert.equal(threats.isThreatHostNow('evil.example'), true);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delay, 24 * 3600_000);
    assert.equal(timers.pending[0].unreferenced, true);
    fail = true;
    await timers.tick();
    assert.equal(reads, 2);
    assert.equal(threats.isThreatHostNow('evil.example'), true);
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0].delay, 3600_000);
    assert.equal(timers.pending[0].unreferenced, true);
  });

  it('выключенная проверка молчит даже при заполненном списке', () => {
    const threats = runtime(false);
    threats.setThreatListsForTest({ first: ['evil.example'] });
    assert.equal(threats.linkThreatsActive(), false);
    assert.equal(threats.isThreatHostNow('evil.example'), false);
    assert.deepEqual(Array.from(threats.dangerousLinksOf('https://evil.example')), []);
    assert.equal(Object.hasOwn(serializer(threats).serializeMessage(message('https://evil.example')), 'dangerousLinks'), false);
  });

  it('пустой список не меняет DTO, заполненный отмечает дочерний хост, замена убирает прежние угрозы', () => {
    const threats = runtime();
    const serialize = serializer(threats).serializeMessage;
    assert.equal(Object.hasOwn(serialize(message('https://evil.example')), 'dangerousLinks'), false);
    threats.setThreatListsForTest({ first: ['evil.example'], second: ['other.example'] });
    assert.deepEqual(Array.from(serialize(message('https://a.evil.example https://other.example')).dangerousLinks!),
      ['a.evil.example', 'other.example']);
    assert.equal(Object.hasOwn(serialize(message('https://safe.example')), 'dangerousLinks'), false);
    threats.setThreatListsForTest({});
    assert.equal(threats.linkThreatsStatus().sources, 0);
    assert.equal(Object.hasOwn(serialize(message('https://evil.example')), 'dangerousLinks'), false);
  });

  it('обычное сообщение не получает dangerousLinks даже пустым массивом — контрфакт', () => {
    const threats = runtime();
    const check = (serialize: ReturnType<typeof serializer>) =>
      assert.equal(Object.hasOwn(serialize.serializeMessage(message('https://safe.example')), 'dangerousLinks'), false);
    check(serializer(threats));
    const source = readFileSync(new URL('./serialize.ts', import.meta.url), 'utf8');
    const target = '...(dangerous.length ? { dangerousLinks: dangerous } : {})';
    assert.equal(source.split(target).length - 1, 1);
    assert.throws(() => check(serializer(threats, source.replace(target, 'dangerousLinks: dangerous'))), assert.AssertionError);
  });

  it('два файла обновляются независимо: отказ второго сохраняет его прежний набор и убирает удалённый источник', async () => {
    const calls: string[] = [];
    const threats = runtime(true, ['first.txt', 'second.txt'], async file => {
      calls.push(file);
      if (file === 'second.txt') throw new Error('файл недоступен');
      return 'new.example\n';
    });
    threats.setThreatListsForTest({ 'first.txt': ['old.example'], 'second.txt': ['kept.example'], 'removed.txt': ['removed.example'] });
    assert.equal(await threats.refreshLinkThreats(), false);
    assert.deepEqual(calls, ['first.txt', 'second.txt']);
    assert.equal(threats.isThreatHostNow('new.example'), true);
    assert.equal(threats.isThreatHostNow('old.example'), false);
    assert.equal(threats.isThreatHostNow('kept.example'), true);
    assert.equal(threats.isThreatHostNow('removed.example'), false);
    assert.equal(threats.linkThreatsStatus().sources, 2);
    assert.equal(threats.linkThreatsStatus().hosts, 2);
  });

  it('два успешно прочитанных файла дают общий список и успешный результат', async () => {
    const threats = runtime(true, ['one', 'two'], async file => file === 'one' ? 'one.example' : 'two.example');
    assert.equal(await threats.refreshLinkThreats(), true);
    assert.equal(threats.isThreatHostNow('one.example'), true);
    assert.equal(threats.isThreatHostNow('two.example'), true);
    assert.equal(typeof threats.linkThreatsStatus().loadedAt, 'number');
  });

  it('опасный хост не получает карточку и не обращается ни к кэшу, ни к safeFetch; безопасный получает', async () => {
    const threats = runtime();
    threats.setThreatListsForTest({ first: ['evil.example'] });
    let selects = 0;
    const fetches: string[] = [];
    const db = {
      select() { selects++; return { from: () => ({ where: () => ({ limit: async () => [] }) }) }; },
      insert() { return { values: () => ({ onConflictDoUpdate: async () => {} }) }; },
    };
    const preview = load<typeof import('./linkPreview.js')>('./linkPreview.ts', {
      'drizzle-orm': { eq() {}, sql() {} }, './db/index.js': { db }, './db/schema.js': { linkPreviews: { url: 'url' } },
      './attachmentRules.js': attachmentRules, './linkThreats.js': threats, './linkThreatsRules.js': rules,
      './ogParse.js': ogParse,
      './safeFetch.js': { BlockedTargetError: class extends Error {}, async safeFetchPage(url: string) {
        fetches.push(url); return { url, status: 200, contentType: 'text/html', body: '<title>Безопасная страница</title>' };
      } },
    });
    assert.equal(await preview.getLinkPreview('https://sub.evil.example/path#anchor'), null);
    assert.equal(selects, 0);
    assert.deepEqual(fetches, []);
    assert.equal((await preview.getLinkPreview('https://safe.example/path#anchor'))?.title, 'Безопасная страница');
    assert.equal(selects, 1);
    assert.deepEqual(fetches, ['https://safe.example/path']);
  });

  it('признак linkthreats1 объявляется ровно один раз по умолчанию и отсутствует при выключении', () => {
    for (const [raw, count] of [[undefined, 1], ['true', 1], ['false', 0], [' FALSE ', 0]] as const) {
      const features = load<typeof import('./instanceFeatures.js')>('./instanceFeatures.ts', {
        '@gusvoice/shared': shared, './linkThreatsRules.js': rules,
      }, { process: { env: { LINK_THREATS_ENABLED: raw } } });
      assert.equal(features.INSTANCE_FEATURES.filter(x => x === shared.FEATURE_LINKTHREATS1).length, count);
      assert.ok(features.INSTANCE_FEATURES.includes(shared.FEATURE_CONV2));
    }
  });
});
