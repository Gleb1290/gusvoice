import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Message } from '@gusvoice/shared';
import type { ChannelMessageEvent } from '../channelEvents.js';

const source = readFileSync(new URL('../channelEvents.ts', import.meta.url), 'utf8');
const memberSource = readFileSync(new URL('../memberEvents.ts', import.meta.url), 'utf8');
const message: Message = { id: 'm', channelId: 'c', author: { id: 'a', username: 'author', displayName: 'Автор', avatarUrl: null },
  content: 'текст', createdAt: '2026-01-01T00:00:00Z', editedAt: null, attachments: [], reactions: [], replyTo: null };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(raw = source) {
  const published: unknown[][] = [], warnings: string[] = [];
  let audienceCalls = 0;
  let audience: { serverId: string; userIds: string[] } | null = { serverId: 's', userIds: ['a', 'bot'] };
  const deps: Record<string, unknown> = {
    './permissions.js': { getChannelAudience: async () => { audienceCalls++; return audience; } },
    './realtime.js': { publishToChannel: async (...args: unknown[]) => { published.push(args); } },
  };
  const module = { exports: {} as typeof import('../channelEvents.js') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Promise, Map, Error, console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
      require(name: string) { assert.ok(Object.hasOwn(deps, name), `известная граница ${name}`); return deps[name]; } });
  return { api: module.exports, published, warnings, audienceCalls: () => audienceCalls, audience: (next: typeof audience) => { audience = next; } };
}
it('R303 единый вход считает аудиторию ровно один раз и передаёт одних зрителей людям и ботам', { timeout: 5_000 }, async () => {
  const f = fixture(), recorded: unknown[][] = [], done = deferred();
  f.api.configureChannelBots({ record: async (...args) => { recorded.push(args); done.resolve(); } });
  const ev: ChannelMessageEvent = { kind: 'created', message };
  await f.api.publishChannelMessageEvent('s', 'c', ev, 'a'); await done.promise;
  assert.equal(f.audienceCalls(), 1); assert.equal(f.published.length, 1); assert.equal(recorded.length, 1);
  assert.deepEqual(f.published[0].slice(0, 2), ['s', 'c']);
  assert.equal((f.published[0][2] as { t: string }).t, 'message.create');
  assert.strictEqual(f.published[0][3], recorded[0][3]); assert.strictEqual(recorded[0][2], ev); assert.equal(recorded[0][4], 'a');
});
it('R303 исчезнувший или чужой канал не публикует никому, правильный сервер проходит', { timeout: 5_000 }, async () => {
  const f = fixture(); let records = 0;
  f.api.configureChannelBots({ record: async () => { records++; } });
  for (const next of [null, { serverId: 'other', userIds: ['bot'] }]) {
    f.audience(next); await f.api.publishChannelMessageEvent('s', 'c', { kind: 'created', message });
  }
  assert.equal(f.published.length, 0); assert.equal(records, 0);
  f.audience({ serverId: 's', userIds: ['bot'] }); await f.api.publishChannelMessageEvent('s', 'c', { kind: 'created', message });
  await Promise.resolve(); assert.equal(f.published.length, 1); assert.equal(records, 1);
});
async function noPin(raw = source) {
  const f = fixture(raw); const recorded: string[] = [];
  f.api.configureChannelBots({ record: async (_s, _c, ev) => { recorded.push(ev.kind); } });
  for (const kind of ['pinned', 'markup'] as const) await f.api.publishChannelMessageEvent('s', 'c', { kind, message });
  await nextTurn();
  assert.equal(recorded.length, 0, 'R303 закреп и кнопки не превращаются в правку боту');
  assert.equal(f.published.length, 2); for (const row of f.published) assert.equal((row[2] as { t: string }).t, 'message.update');
}
it('R303 закреп и одни кнопки обновляют людей, но не будят ботов', { timeout: 5_000 }, () => noPin());
async function queueCheck(raw = source) {
  const f = fixture(raw), started = deferred(), release = deferred(), edited = deferred(), other = deferred();
  const seen: string[] = [];
  f.api.configureChannelBots({ record: async (_s, channel, ev) => {
    seen.push(`${channel}:${ev.kind}`);
    if (channel === 'c' && ev.kind === 'created') { started.resolve(); await release.promise; }
    if (channel === 'c' && ev.kind === 'edited') edited.resolve();
    if (channel === 'other') other.resolve();
  } });
  await f.api.publishChannelMessageEvent('s', 'c', { kind: 'created', message }); await started.promise;
  await f.api.publishChannelMessageEvent('s', 'c', { kind: 'edited', message });
  await f.api.publishChannelMessageEvent('s', 'other', { kind: 'created', message }); await other.promise;
  try { assert.deepEqual(seen, ['c:created', 'other:created'], 'R303 правка не обгоняет медленное создание'); }
  finally { release.resolve(); }
  await edited.promise; assert.deepEqual(seen, ['c:created', 'other:created', 'c:edited']);
}
it('R303 медленное создание задерживает правку того же канала, но не другого канала', { timeout: 5_000 }, () => queueCheck());
it('R303 сбой крючка логируется и не отравляет следующую правку, людям оба события доставлены', { timeout: 5_000 }, async () => {
  const f = fixture(), done = deferred(); let calls = 0;
  f.api.configureChannelBots({ record: async () => { calls++; if (calls === 1) throw new Error('synthetic hook failure'); done.resolve(); } });
  await f.api.publishChannelMessageEvent('s', 'c', { kind: 'created', message });
  await f.api.publishChannelMessageEvent('s', 'c', { kind: 'edited', message }); await done.promise;
  assert.equal(calls, 2); assert.equal(f.published.length, 2); assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /synthetic hook failure/);
});
it('R303 original-first мутант закрепа ловится точным AssertionError, не сбоем загрузки', { timeout: 5_000 }, async () => {
  await noPin(); const anchor = "h && ev.kind !== 'pinned' && ev.kind !== 'markup'";
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(noPin(source.replace(anchor, 'h')), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION'
    && e.message.startsWith('R303 закреп и кнопки не превращаются в правку боту') && e.operator === 'strictEqual' && e.actual === 2 && e.expected === 0);
});
it('R303 original-first мутант очереди обнаруживает правку, обогнавшую создание', { timeout: 5_000 }, async () => {
  await queueCheck(); const anchor = 'const prev = queues.get(channelId) ?? Promise.resolve();';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(queueCheck(source.replace(anchor, 'const prev = Promise.resolve();')), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION'
    && e.message.startsWith('R303 правка не обгоняет медленное создание') && e.operator === 'deepStrictEqual'
    && JSON.stringify(e.actual) === '["c:created","c:edited","other:created"]'
    && JSON.stringify(e.expected) === '["c:created","other:created"]');
});
it('R303 memberChanged пропускает одинаковый статус, обрабатывает пачку последовательно и переживает ошибку', { timeout: 5_000 }, async () => {
  const warnings: string[] = [], module = { exports: {} as typeof import('../memberEvents.js') };
  runInNewContext(ts.transpileModule(memberSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Array, Error, console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) }, require: (name: string) => assert.fail(`неожиданный импорт ${name}`) });
  const seen: string[] = [], done = deferred();
  module.exports.configureMemberBots({ changed: async c => { seen.push(c.userId); if (c.userId === 'fails') throw new Error('synthetic member failure'); if (c.userId === 'last') done.resolve(); } });
  module.exports.memberChanged([
    { serverId: 's', userId: 'same', actorId: 'a', from: 'member', to: 'member' },
    { serverId: 's', userId: 'fails', actorId: 'a', from: 'left', to: 'member' },
    { serverId: 's', userId: 'last', actorId: 'a', from: 'member', to: 'kicked' },
  ]); await done.promise;
  assert.deepEqual(seen, ['fails', 'last']); assert.equal(warnings.length, 1); assert.match(warnings[0], /synthetic member failure/);
  module.exports.configureMemberBots(null); module.exports.memberChanged({ serverId: 's', userId: 'off', actorId: null, from: 'left', to: 'member' });
  assert.deepEqual(seen, ['fails', 'last']);
});
