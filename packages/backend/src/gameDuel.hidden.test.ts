import { counterfact as gatedCounterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from './db/schema.js';
import { duelDto } from './gameDuelRules.js';

type Row = typeof schema.gameRounds.$inferSelect;
type Edit = { from: string; to: string };
type Wire = { userId?: string; serverId?: string; channelId?: string; audience?: string[]; message: any };
const normal = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const read = (file: string) => readFileSync(new URL(`./${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const T0 = Date.parse('2026-10-29T12:00:00Z');

function row(): Row {
  return {
    id: 'hidden-fixture', serverId: 's', kind: 'duel', state: 'locked', createdBy: 'a',
    createdAt: new Date(T0), lockAt: new Date(T0 + 30000), settleAt: new Date(T0 + 20000), settledAt: null,
    data: {
      channelId: 'v', challengerId: 'a', targetId: 'b', game: 'greedy', amount: 100, feePercent: 10,
      commit: 'synthetic-commit', seed: 'synthetic-seed', phase: 'moving',
      greedy: { scores: { challenger: 11, target: 7 }, turn: 'target', turnPoints: 9,
        lastRoll: { by: 'target', die: 6 }, burned: 0, timeouts: { challenger: 1, target: 2 },
        seq: 8, n: 5, first: 'challenger', rolls: [4, 1, 3, 5, 6], winner: null },
    },
  };
}

function runtime(participants: string[], edit?: Edit) {
  const wires: Wire[] = [];
  const warnings: unknown[][] = [];
  const values: Record<string, unknown> = {
    // Не поддельные правила или транзакции: DB лишь аварийный IO-адаптер,
    // publishDuel вообще не должна к ней обращаться.
    'db/index': { db: new Proxy({}, { get() { throw new Error('R356 setup: рассылка обратилась к DB'); } }) },
    'db/schema': schema, env: { env: { economyPreviewUsers: [] } },
    realtime: {
      redisPub: { get: async (key: string) => {
        assert.equal(key, 'presence:ch:v', 'R356 setup: presence именно нужного канала');
        return JSON.stringify(participants.map(userId => ({ userId })));
      } },
      publishToUser: async (userId: string, message: any) => { wires.push({ userId, message: normal(message) }); },
      publishToChannel: async (serverId: string, channelId: string, message: any, audience: string[]) => {
        wires.push({ serverId, channelId, audience: [...audience], message: normal(message) });
      },
    },
  };
  const allowed = new Set(['gameDuel', 'gameDuelRules', 'gameMoney', 'gameMoneyRules', 'coins', 'coinRules', 'streakRules', 'economyDefaults', 'voicePresence', 'util']);
  const cache = new Map<string, Record<string, any>>();
  class Clock extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? T0 : value instanceof Date ? value.getTime() : value); }
    static override now() { return T0; }
  }
  function load(file: string): Record<string, any> {
    if (Object.hasOwn(values, file)) return values[file] as Record<string, any>;
    if (cache.has(file)) return cache.get(file)!;
    assert.ok(allowed.has(file), `R356 setup: неизвестный импорт ${file}`);
    let source = read(file);
    if (file === 'gameDuel' && edit) {
      assert.equal(source.split(edit.from).length, 2, 'R356 setup: якорь мутанта единственный');
      source = source.replace(edit.from, edit.to);
    }
    // Только test-access к приватной функции: исполнен ЦЕЛЫЙ production-модуль
    // с настоящими money/rules/presence; тело функции не извлекается и не заменяется.
    if (file === 'gameDuel') source += '\nexport { publishDuel as __publishDuel };\n';
    const module = { exports: {} as Record<string, any> };
    cache.set(file, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, {
      module, exports: module.exports, Date: Clock, Buffer, Error, Uint8Array,
      console: { warn: (...args: unknown[]) => warnings.push(args) },
      setInterval() { throw new Error('R356 setup: worker не должен запускаться'); },
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        if (id === '@gusvoice/shared') return shared;
        if (id === 'node:crypto') return crypto;
        assert.ok(id.startsWith('.'), `R356 setup: неизвестный внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(file), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const duel = load('gameDuel');
  return { wires, warnings, publish: (r: Row) => duel.__publishDuel(r) as Promise<void> };
}

function expected(viewer: 'a' | 'b' | null) {
  return {
    scores: { challenger: viewer === 'a' ? 11 : 0, target: viewer === 'b' ? 7 : 0 },
    turn: 'target', turnPoints: viewer === 'b' ? 9 : 0,
    lastRoll: viewer === 'b' ? { by: 'target', die: 6 } : null, burned: 0,
    timeouts: { challenger: 1, target: 2 }, seq: 8, first: 'challenger', rolls: [0, 1, 0, 0, 0],
    hidden: { challenger: viewer !== 'a', target: viewer !== 'b' },
  };
}

async function moving(edit?: Edit) {
  const p = 'R356 рассылка:';
  const f = runtime(['b', 'c', 'a', 'c', 'd'], edit); const r = row(); const before = normal(r);
  await f.publish(r);
  assert.deepEqual(f.warnings, [], `${p} ошибки шины не проглочены`);
  assert.equal(f.wires.length, 3, `${p} два личных DTO и один зрительский`);
  for (const userId of ['a', 'b'] as const) {
    const personal = f.wires.filter(w => w.userId === userId);
    assert.equal(personal.length, 1, `${p} ровно одно личное событие ${userId}`);
    assert.deepEqual(personal[0].message.duel.greedy, expected(userId), `${p} ${userId} получает свою открытую сторону`);
  }
  const channel = f.wires.filter(w => w.audience);
  assert.equal(channel.length, 1, `${p} зрителям один пакет`);
  assert.deepEqual(channel[0].audience!.sort(), ['c', 'd'], `${p} аудитория без обоих игроков и дублей`);
  assert.deepEqual(channel[0].message.duel.greedy, expected(null), `${p} зритель не видит ни одной стороны`);
  for (const w of f.wires) {
    assert.deepEqual({ t: w.message.t, serverId: w.message.serverId, channelId: w.message.channelId, serverNow: w.message.serverNow },
      { t: 'duel.state', serverId: 's', channelId: 'v', serverNow: new Date(T0).toISOString() }, `${p} настоящий envelope события`);
    assert.equal(w.message.duel.seed, null, `${p} seed тоже не утекает`);
  }
  assert.deepEqual(normal(r), before, `${p} рассылка не маскирует данные самой партии`);
}

async function proof(prefix: string, scenario: (edit?: Edit) => Promise<void>, edits: Edit[]) {
  await scenario();
  for (const edit of edits) {
await gatedCounterfact(async () => {
    const source = read('gameDuel');
    await assert.rejects(scenario(edit), e => e instanceof assert.AssertionError && e.message.startsWith(prefix));
    assert.equal(read('gameDuel'), source, 'R356 setup: production на диск не записан');
});
    await scenario();
  }
}

test('R356 в ходу игроки получают разные личные DTO, зрители — общую маску без игроков в аудитории', () => proof('R356 рассылка:', moving, [
  { from: 'duel: duelDtoFor(row, viewerId), serverNow', to: 'duel: duelDto(row), serverNow' },
  { from: 'duel: duelDtoFor(row, viewerId), serverNow', to: 'duel: duelDtoFor(row, data.challengerId), serverNow' },
  { from: 'audience.delete(data.challengerId);', to: 'audience.add(data.challengerId);' },
  { from: 'audience.delete(data.targetId);', to: 'audience.add(data.targetId);' },
]));

async function noSpectators(edit?: Edit) {
  const p = 'R356 без зрителей:';
  for (const people of [[], ['a'], ['b'], ['a', 'b', 'a']]) {
    const f = runtime(people, edit); await f.publish(row());
    assert.deepEqual(f.warnings, [], `${p} без проглоченных ошибок`);
    assert.deepEqual(f.wires.map(w => w.userId).sort(), ['a', 'b'], `${p} только два личных события, channel не вызван`);
    assert.equal(f.wires.filter(w => w.audience).length, 0, `${p} нет channel даже с пустой аудиторией`);
  }
}
test('R356 пустой голос и голос только с игроками не вызывают publishToChannel', () => proof('R356 без зрителей:', noSpectators, [
  { from: 'if (audience.size > 0) await publishToChannel', to: 'if (audience.size >= 0) await publishToChannel' },
]));

async function outsideMoving(edit?: Edit) {
  const p = 'R356 вне хода:';
  for (const variant of ['done', 'settled', 'cancelled', 'dice', 'rps'] as const) {
    const f = runtime(['c', 'c'], edit); const r = row();
    if (variant === 'done') r.data.phase = 'done';
    else if (variant === 'settled' || variant === 'cancelled') { r.state = variant; r.settledAt = new Date(T0); }
    else {
      r.data.game = variant;
      if (variant === 'dice') r.data.phase = 'playing';
      else r.data.rps = { rounds: [], ready: { challenger: false, target: false }, wins: { challenger: 0, target: 0 } };
    }
    await f.publish(r);
    assert.deepEqual(f.warnings, [], `${p} без проглоченных ошибок`);
    assert.equal(f.wires.length, 1, `${p} ${variant}: одна общая рассылка`);
    assert.deepEqual(f.wires[0].audience!.sort(), ['a', 'b', 'c'], `${p} ${variant}: игроки добавлены, даже если вышли из голоса`);
    assert.deepEqual(f.wires[0].message.duel, normal(duelDto(r)), `${p} ${variant}: полный DTO без маски`);
  }
}
test('R356 done/settled/cancelled, КНБ и кубики сохраняют единственную общую рассылку с игроками', () => proof('R356 вне хода:', outsideMoving, [
  { from: "data.game === 'greedy' && row.state === 'locked' && data.phase === 'moving'", to: "data.game === 'greedy' && row.state === 'locked'" },
  { from: "data.game === 'greedy' && row.state === 'locked' && data.phase === 'moving'", to: "row.state === 'locked' && data.phase === 'moving'" },
]));
