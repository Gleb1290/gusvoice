import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as orm from 'drizzle-orm';
import ts from 'typescript';
import { dayKey, dayStart, seasonId } from '../src/coinRules.js';
import * as schema from '../src/db/schema.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Целые production-модули: настоящий SQL и rollPeriods, закрыты только db и генератор id.
type ModuleName = 'transferCoins' | 'coinRules' | 'economyStats';
type Edit = { file: ModuleName; from: string; to: string };
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });

function modules(edit?: Edit) {
  const cache = new Map<string, any>();
  const allowed = new Set<ModuleName>(['transferCoins', 'coinRules', 'economyStats']);
  function load(name: string): any {
    if (name === 'db/index') return { db: t.db };
    if (name === 'db/schema') return schema;
    if (name === 'util') return { id: randomUUID };
    if (cache.has(name)) return cache.get(name);
    assert.ok(allowed.has(name as ModuleName), `закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) {
      assert.equal(source.split(edit.from).length, 2, `уникальный якорь ${name}`);
      source = source.replace(edit.from, edit.to);
    }
    const module = { exports: {} };
    cache.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      module, exports: module.exports, Date,
      require(id: string) {
        if (id === 'drizzle-orm') return orm;
        assert.ok(id.startsWith('.'), `внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  return {
    transfer: load('transferCoins') as typeof import('../src/transferCoins.js'),
    stats: load('economyStats') as typeof import('../src/economyStats.js'),
  };
}

async function fixture() {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['sender', 'recipient'].map(id => ({
    id, username: id, displayName: id, passwordHash: 'fixture',
  })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Сервер', ownerId: 'sender' });
}

const phases = {
  same: { before: '2026-10-28T20:59:58Z', now: '2026-10-28T20:59:59Z', day: false, season: false },
  midnight: { before: '2026-10-28T20:59:59Z', now: '2026-10-28T21:00:00Z', day: true, season: false },
  month: { before: '2026-10-31T20:59:59Z', now: '2026-10-31T21:00:00Z', day: true, season: true },
} as const;

async function transferScenario(phase: keyof typeof phases, edit?: Edit) {
  await fixture();
  const p = phases[phase];
  const now = new Date(p.now);
  const original = ['sender', 'recipient'].map((userId, n) => ({
    serverId: 'server', userId, balance: 200 + n, earnedTotal: 621 + n,
    seasonId: seasonId(new Date(p.before), 'month'), seasonEarned: 313 + n,
    day: dayKey(new Date(p.before)), secondsToday: 9_001 + n, earnedToday: 23 + n,
    aloneEarnedMilli: 90_123 + n, pendingMilli: 1_337 + n, pendingSeconds: 17 + n,
    baseMilli: 3_000 + n, deltaPresenceMilli: -1_000, deltaCompanyMilli: -500, deltaDecayMilli: -163,
    givenToday: 31 + n, receivedToday: 41 + n, recognitionToday: 2 + n,
    recognitionTippers: 9 + n, secondsTotal: 42_000 + n,
  }));
  await t.db.insert(schema.coinBalances).values(original);
  const result = await modules(edit).transfer.transferCoins({
    serverId: 'server', fromUserId: 'sender', toUserId: 'recipient', debit: 10, credit: 8, burned: 2,
    dailyOut: 0, dailyIn: 0, dailyPair: 0, maxTippersPerDay: 5, seasonLength: 'month', now,
  });
  assert.equal(result.block, null, 'R317 перевод разрешён');
  assert.equal(result.receivedBefore, p.day ? 0 : 42, 'R317 входящие считают по текущим суткам');
  assert.equal(result.receivedAfter, (p.day ? 0 : 42) + 8);
  const rows = await t.db.select().from(schema.coinBalances);
  for (const old of original) {
    const row = rows.find(r => r.userId === old.userId)!;
    assert.ok(row, `R317 кошелёк ${old.userId} сохранён`);
    assert.equal(row.aloneEarnedMilli, p.day ? 0 : old.aloneEarnedMilli,
      `R317 ${old.userId}: aloneEarnedMilli сбрасывается только в полночь МСК`);
    assert.equal(row.day, dayKey(now));
    assert.equal(row.secondsToday, p.day ? 0 : old.secondsToday, 'R317 счётчик компании катится вместе с сутками');
    assert.equal(row.earnedToday, p.day ? 0 : old.earnedToday);
    assert.equal(row.seasonId, seasonId(now, 'month'));
    assert.equal(row.seasonEarned, p.season ? 0 : old.seasonEarned, 'R317 тип не стирает текущий сезон');
    for (const field of ['earnedTotal', 'pendingMilli', 'pendingSeconds', 'baseMilli',
      'deltaPresenceMilli', 'deltaCompanyMilli', 'deltaDecayMilli', 'secondsTotal'] as const) {
      assert.equal(row[field], old[field], `R317 ${field} переживает тип и полночь`);
    }
    assert.equal(row.balance, old.balance + (old.userId === 'sender' ? -10 : 8));
  }
  assert.equal((await t.db.select().from(schema.coinLedger)).length, 2, 'R317 обе стороны перевода попали в журнал');
}

test('R317 перевод в те же сутки сохраняет aloneEarnedMilli и накопленную компанию обоих людей', () => transferScenario('same'));
test('R317 перевод ровно в полночь МСК обнуляет aloneEarnedMilli обоим, не теряя сезон и невыплаченное', () => transferScenario('midnight'));
test('R317 перевод на границе месяца сбрасывает сутки и сезон, но не баланс и накопленную ценность', () => transferScenario('month'));

test('R317 контрфакт: перевод забыл сброс aloneEarnedMilli в обоих кошельках', async () => {
  await transferScenario('midnight');
  await counterfact(() => assert.rejects(transferScenario('midnight', { file: 'transferCoins',
    from: 'earnedToday: 0, aloneEarnedMilli: 0', to: 'earnedToday: 0' }),
  e => e instanceof assert.AssertionError && e.message.includes('aloneEarnedMilli')));
});
test('R317 контрфакт: перевод обнуляет одиночный заработок даже в те же сутки', async () => {
  await transferScenario('same');
  await counterfact(() => assert.rejects(transferScenario('same', { file: 'transferCoins',
    from: '...dayFields(rolledMine),', to: '...dayFields(rolledMine), aloneEarnedMilli: 0,' }),
  e => e instanceof assert.AssertionError && e.message.includes('aloneEarnedMilli')));
});

type Slice = { minutes: number; peers: number; deafened?: boolean };
async function statsScenario(slices: Slice[], expected: { earn: number; sit: number; hours: number }, edit?: Edit) {
  await fixture();
  // Вчерашние ПОЛНЫЕ московские сутки: часы машины не делают сценарий зависимым от часа прогона.
  const start = dayStart(new Date(Date.now() - 86_400_000));
  let minute = 0;
  const rows = slices.flatMap(s => Array.from({ length: s.minutes }, () => ({
    id: randomUUID(), serverId: 'server', userId: 'sender', channelId: 'voice', seconds: 60,
    peers: s.peers, deafened: s.deafened ?? false,
    createdAt: new Date(start.getTime() + minute++ * 60_000),
  })));
  await t.db.insert(schema.voiceActivity).values(rows);
  const result = await modules(edit).stats.economyStats(30);
  assert.equal(result.people, 1, 'R317 статистика видит человека');
  assert.equal(result.userDays, 1, 'R317 статистика группирует одни московские сутки');
  assert.equal(result.hours, expected.hours, 'R317 сырые часы не исчезают из статистики');
  assert.equal(result.avgSitMinutes, expected.sit);
  assert.equal(result.avgEarnMinutes, expected.earn, 'R317 заработанные минуты реального SQL');
  assert.equal(result.avgGooseMinutes, 0, 'R317 статистика не выдумывает пойманных гусей');
}

async function soloDeafScenario(edit?: Edit) {
  await statsScenario([{ minutes: 60, peers: 0, deafened: true }], { earn: 0, sit: 60, hours: 1 }, edit);
  await statsScenario([{ minutes: 60, peers: 0 }], { earn: 15, sit: 60, hours: 1 }, edit);
}
test('R317 SQL: один в деафене не зарабатывает, один слышащий получает положительные 15 минут', () => soloDeafScenario());
test('R317 контрфакт SQL: фильтр NOT deafened пропал у одиночного времени', async () => {
  await soloDeafScenario();
  await counterfact(() => assert.rejects(soloDeafScenario({ file: 'economyStats',
    from: 'FILTER (WHERE peers = 0 AND NOT deafened)', to: 'FILTER (WHERE peers = 0)' }),
  e => e instanceof assert.AssertionError && e.message.includes('заработанные минуты')));
});

async function companyScenario(edit?: Edit) {
  await statsScenario([{ minutes: 120, peers: 1 }], { earn: 120, sit: 120, hours: 2 }, edit);
  // 3 ч ожидания дают 45 минут прайса, затем 2 ч вдвоём дают прежние 120, без затухания.
  await statsScenario([{ minutes: 180, peers: 0 }, { minutes: 120, peers: 1 }],
    { earn: 165, sit: 300, hours: 5 }, edit);
}
test('R317 SQL: ожидание одному не сдвигает затухание последующей компании', () => companyScenario());
test('R317 контрфакт SQL: одиночные секунды снова попали в окно затухания', async () => {
  await companyScenario();
  await counterfact(() => assert.rejects(companyScenario({ file: 'economyStats',
    from: 'sum(CASE WHEN peers > 0 THEN seconds ELSE 0 END) OVER', to: 'sum(seconds) OVER' }),
  e => e instanceof assert.AssertionError && e.message.includes('заработанные минуты')));
});

async function capScenario(edit?: Edit) {
  // Значения в МИНУТАХ ПРАЙСА, не монетах и не тысячных: 90 монет / (10 / 5) = 45.
  await statsScenario([{ minutes: 176, peers: 0 }], { earn: 44, sit: 176, hours: 3 }, edit);
  await statsScenario([{ minutes: 180, peers: 0 }], { earn: 45, sit: 180, hours: 3 }, edit);
  await statsScenario([{ minutes: 184, peers: 0 }], { earn: 45, sit: 184, hours: 3 }, edit);
  await statsScenario([{ minutes: 720, peers: 0 }], { earn: 45, sit: 720, hours: 12 }, edit);
}
test('R317 SQL REF: до порога растёт, на 45 взвешенных минутах и после него останавливается', () => capScenario());
test('R317 контрфакт REF: 90 монет ошибочно стали 90 взвешенными минутами', async () => {
  await capScenario();
  await counterfact(() => assert.rejects(capScenario({ file: 'economyStats', from: 'aloneCapWeightedMinutes: 45,', to: 'aloneCapWeightedMinutes: 90,' }),
    e => e instanceof assert.AssertionError && e.message.includes('заработанные минуты')));
});
