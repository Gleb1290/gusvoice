import assert from 'node:assert/strict';
import { counterfact } from '../../shared/test/counterfacts.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as zod from 'zod';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { dayKey, seasonId } from '../src/coinRules.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Настоящие route/coins/gameMoney/правила, Zod и SQL; подменены только авторизация, время и внешняя шина.
type Edit = { file: string; from: string; to: string | (() => string) };
const NOW = Date.parse('2026-10-28T20:59:59.999Z');
const NEXT = '2026-10-28T21:00:00.000Z';
let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => {
  await t?.close();
  const { pool } = await import('../src/db/index.js');
  await pool.end();
});
const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function fixture(edit?: Edit) {
  await truncateAll(t.raw);
  await t.db.insert(schema.users).values(['member', 'owner'].map(id => ({
    id, username: id, displayName: id === 'member' ? 'Участник' : 'Владелец', passwordHash: 'fixture', verified: true,
  })));
  await t.db.insert(schema.servers).values({ id: 'server', name: 'Тестовый сервер', ownerId: 'owner' });
  await t.db.insert(schema.serverMembers).values({ serverId: 'server', userId: 'member' });
  await t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true,
    gamesEnabled: true, gamesBetMax: 337, gamesDailyLossMax: 887, gamesFeePercent: 13,
    closedSeasonId: seasonId(new Date(NOW)), gooseMinutes: 0 });
  let manager = false;
  let superAdmin = false;
  const instance = { economyPreviewUsers: [], gamesOpen: true };
  let clock = NOW;
  class TestDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? clock : value instanceof Date ? value.getTime() : value); }
    static override now() { return clock; }
  }
  const errors: string[] = [];
  const writes: unknown[] = [];
  const fail = () => { throw new Error('R326 setup: неожиданный внешний IO'); };
  const values: Record<string, unknown> = {
    'db/index': { db: t.db }, 'db/schema': schema,
    env: { env: instance }, util: { id: randomUUID },
    auth: { requireAuth: async (req: { user: unknown }) => { req.user = { sub: 'member' }; } },
    permissions: { getMemberContext: async () => ({ serverPermissions: manager ? shared.Permission.MANAGE_ECONOMY : 0n, superAdmin }) },
    audit: { writeAudit: async (...args: unknown[]) => { writes.push(['audit', ...args]); } },
    realtime: { publishToUser: fail, publishToServer: async (...args: unknown[]) => { writes.push(['server', ...args]); },
      redisPub: { get: async () => null } },
    shop: { shopFor: async () => [] }, purchase: { buyItem: fail },
    instanceSettings: { avatarPriceMinutes: fail, avatarRentalMaxDays: fail },
    storage: { putMedia: fail, storageConfigured: fail },
  };
  const files = new Set(['coins', 'coinRules', 'streakRules', 'seasons', 'economyDefaults',
    'gooseRules', 'voiceActivityRules', 'levelRules', 'shopRules', 'gameMoney', 'gameMoneyRules', 'routes/economy']);
  const modules = new Map<string, any>();
  function load(name: string): any {
    if (Object.hasOwn(values, name)) return values[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(files.has(name), `R326 setup: закрытый импорт ${name}`);
    let source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (edit?.file === name) {
      assert.equal(source.split(edit.from).length, 2, 'R326 setup: уникальный якорь мутанта');
      source = source.replace(edit.from, typeof edit.to === 'function' ? edit.to() : edit.to);
    }
    const module = { exports: {} };
    modules.set(name, module.exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      module, exports: module.exports, Date: TestDate, Buffer,
      console: { log() {}, error: (...args: unknown[]) => { errors.push(args.join(' ')); } },
      require(id: string) {
        if (id === '@gusvoice/shared') return shared;
        if (id === 'drizzle-orm') return orm;
        if (id === 'zod') return zod;
        assert.ok(id.startsWith('.'), `R326 setup: внешний импорт ${id}`);
        return load(posix.normalize(posix.join(posix.dirname(name), id)).replace(/\.js$/, ''));
      },
    });
    return module.exports;
  }
  const app = Fastify();
  // Тот же тип ошибки Zod→400; bootstrap index.ts и его фоновые процессы не импортируются.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof zod.ZodError) return reply.code(400).send({ error: 'validation', details: error.issues });
    errors.push(String(error));
    return reply.code(500).send({ error: 'unexpected fixture error' });
  });
  try {
    await app.register(load('routes/economy').economyRoutes);
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  return { app, errors, writes, manage: (value: boolean) => { manager = value; },
    instanceOpen: (value: boolean) => { instance.gamesOpen = value; }, super: (value: boolean) => { superAdmin = value; },
    at: (value: number) => { clock = value; },
    rules: load('gameMoneyRules') as typeof import('../src/gameMoneyRules.js') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function wallet(patch: Partial<typeof schema.coinBalances.$inferInsert> = {}) {
  await t.db.insert(schema.coinBalances).values({ serverId: 'server', userId: 'member',
    day: dayKey(new Date(NOW)), seasonId: seasonId(new Date(NOW)), ...patch });
}

async function drift() {
  const rows = await t.raw.query(`SELECT b.user_id FROM coin_balances b
    LEFT JOIN coin_ledger l ON l.server_id=b.server_id AND l.user_id=b.user_id
    GROUP BY b.server_id,b.user_id,b.balance HAVING b.balance <> COALESCE(SUM(l.amount),0)`);
  assert.equal(rows.rows.length, 0, 'R326 HTTP: drift после сценария равен нулю');
}

async function get(f: Fixture) {
  const response = await f.app.inject({ method: 'GET', url: '/servers/server/economy' });
  assert.equal(response.statusCode, 200, 'R326 HTTP: GET снимка доступен');
  return response.json();
}

async function patchMe(f: Fixture, payload: Record<string, unknown>) {
  const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy/me', payload });
  assert.equal(response.statusCode, 200, 'R326 HTTP: PATCH me принят');
  return response.json();
}

function paired(title: string, check: (f: Fixture) => Promise<void>, edit: Edit | Edit[], address = 'R326 HTTP:') {
  test(`R326 ${title}`, async () => {
    const run = async (mutation?: Edit) => {
      const f = await fixture(mutation);
      try { await check(f); await drift(); assert.deepEqual(f.errors, [], 'R326 HTTP: ошибок внешнего IO нет'); }
      finally { await f.app.close(); }
    };
    await run();
    for (const mutation of Array.isArray(edit) ? edit : [edit]) {
      await counterfact(async () => {
      await assert.rejects(run(mutation), e => e instanceof assert.AssertionError && e.message.startsWith(address),
        'изменённый целый модуль должен провалить адресную HTTP/SQL-проверку');
      });
      await run(); // Откат без записи приложения: независимая загрузка исходных модулей и новая чистая БД.
    }
  });
}

const topFields = [
  ['gamesEnabled', true, 'gamesEnabled: (economy?.enabled ?? false) && (economy?.gamesEnabled ?? false),'],
  ['gamesBetMax', 337, 'gamesBetMax: (economy ?? economyDefaults(serverId)).gamesBetMax,'],
  ['gamesDailyLossMax', 887, 'gamesDailyLossMax: (economy ?? economyDefaults(serverId)).gamesDailyLossMax,'],
] as const;
for (const [key, expected, from] of topFields) {
  // Наличие только в settings скрывает игры от обычного участника, у которого settings=null.
  paired(`обычный участник видит верхний ${key}, но не управляющие настройки`, async f => {
    const before = normal(await t.db.select().from(schema.coinBalances));
    const view = await get(f);
    assert.equal(view.canManage, false);
    assert.equal(view.settings, null);
    assert.equal(view[key], expected, `R326 HTTP: публичное поле ${key}`);
    assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'R326 HTTP: GET не заводит кошелёк');
  }, { file: 'routes/economy', from, to: '' });
}

// Включённые игры при отключённой экономике не должны обходить общий выключатель.
paired('выключенная экономика выключает игры даже при gamesEnabled=true', async f => {
  await t.db.update(schema.serverEconomy).set({ enabled: false });
  assert.equal((await get(f)).gamesEnabled, false, 'R326 HTTP: общий выключатель закрывает игры');
}, { file: 'routes/economy', from: '(economy?.enabled ?? false) && (economy?.gamesEnabled ?? false)',
  to: '(economy?.enabled ?? false) || (economy?.gamesEnabled ?? false)' });

// Ненастроенный сервер не получает случайный opt-in и лимиты из другого сервера.
paired('сервер без настроек отдаёт выключенные игры с умолчаниями без записи', async f => {
  await t.db.delete(schema.serverEconomy);
  const view = await get(f);
  assert.equal(view.gamesEnabled, false, 'R326 HTTP: игры по умолчанию выключены');
  assert.equal(view.gamesBetMax, 300, 'R326 HTTP: умолчание ставки');
  assert.equal(view.gamesDailyLossMax, 3000, 'R326 HTTP: умолчание проигрыша');
  assert.deepEqual(view.wallet.games, { optOut: false, lossLimit: null, lossLimitRaise: null, lossToday: 0, effectiveLimit: 3000 },
    'R326 HTTP: games есть даже без строки кошелька');
  assert.equal((await t.db.select().from(schema.serverEconomy)).length, 0, 'R326 HTTP: GET не создаёт настройки');
}, { file: 'routes/economy', from: 'gamesDailyLossMax: (economy ?? economyDefaults(serverId)).gamesDailyLossMax,',
  to: 'gamesDailyLossMax: economy?.gamesDailyLossMax,' });

// Полный снимок, а не набор умолчаний, нужен для сохранения личного ограничения.
paired('GET сохраняет личный предел, отказ и отложенный null в wallet.games', async f => {
  await wallet({ gamesOptOut: true, gamesLossLimit: 120, gamesLossLimitRaise: null, gamesLossLimitRaiseAt: new Date(NEXT) });
  const before = normal(await t.db.select().from(schema.coinBalances));
  assert.deepEqual((await get(f)).wallet.games,
    { optOut: true, lossLimit: 120, lossLimitRaise: { value: null, from: NEXT }, lossToday: 0, effectiveLimit: 120 },
    'R326 HTTP: полный wallet.games');
  assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'R326 HTTP: GET не пишет виртуальное повышение');
}, { file: 'routes/economy',
  from: 'games: await gamesViewOf(serverId, raw, economy?.gamesDailyLossMax ?? economyDefaults(serverId).gamesDailyLossMax, now),',
  to: '' });

// Сутки считаются по Москве: вчерашний дебет не должен лишать человека сегодняшнего предела.
paired('lossToday суммирует ставки, выплаты и возвраты только текущих суток МСК', async f => {
  await wallet();
  await t.db.insert(schema.coinLedger).values([
    { id: 'yesterday', serverId: 'server', userId: 'member', amount: -999, reason: 'wheel.bet', createdAt: new Date('2026-10-27T20:59:59.999Z') },
    { id: 'stake', serverId: 'server', userId: 'member', amount: -80, reason: 'duel.stake', createdAt: new Date('2026-10-27T21:00:00.000Z') },
    { id: 'win', serverId: 'server', userId: 'member', amount: 20, reason: 'duel.win', createdAt: new Date(NOW) },
    { id: 'refund', serverId: 'server', userId: 'member', amount: 15, reason: 'prediction.refund', createdAt: new Date(NOW) },
    { id: 'non-game', serverId: 'server', userId: 'member', amount: 1044, reason: 'grant', createdAt: new Date(NOW) },
  ]);
  assert.equal((await get(f)).wallet.games.lossToday, 45, 'R326 HTTP: проигрыш за сутки МСК =80−20−15');
  f.at(Date.parse(NEXT));
  assert.equal((await get(f)).wallet.games.lossToday, 0, 'R326 HTTP: новая полночь обнуляет проигрыш виртуально');
}, { file: 'gameMoney', from: 'gte(coinLedger.createdAt, dayStart(now)),', to: '' });

const settings: Array<{ key: string; low: number; high: number }> = [
  { key: 'gamesBetMax', low: 1, high: 1_000_000 },
  { key: 'gamesDailyLossMax', low: 0, high: 1_000_000 },
  { key: 'gamesFeePercent', low: 0, high: 50 },
];
for (const { key, low, high } of settings) {
  const line = `${key}: z.number().int().min(${low}).max(${high === 1_000_000 ? '1_000_000' : high}).optional(),`;
  const edits = [
    ['нижняя граница', () => line.replace(`.min(${low})`, '')],
    ['верхняя граница', () => line.replace(`.max(${high === 1_000_000 ? '1_000_000' : high})`, '')],
    ['целые монеты', () => line.replace('.int()', '')],
  ] as const;
  for (const [label, to] of edits) {
    // Обе стороны границы проверяются через route и SQL, не только через отдельный Zod parse.
    paired(`настройка ${key}: ${label}, края принимаются и невалидный PATCH не пишет`, async f => {
      f.manage(true);
      for (const value of [...new Set([low, low+1, high-1, high])]) {
        const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { [key]: value } });
        assert.equal(response.statusCode, 200, `R326 HTTP: ${key}=${value} принимается`);
        assert.equal(response.json()[key], value, `R326 HTTP: ${key} не потерян в ответе`);
        const [saved] = await t.db.select().from(schema.serverEconomy);
        assert.equal((saved as Record<string, unknown>)[key], value, `R326 HTTP: ${key} записан в SQL`);
      }
      for (const value of [low-1, high+1, low+0.5]) {
        const before = normal(await t.db.select().from(schema.serverEconomy));
        const events = normal(f.writes);
        const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { [key]: value } });
        assert.equal(response.statusCode, 400, `R326 HTTP: ${key}=${value} отклоняется`);
        assert.ok(response.json().details.some((issue: { path: string[] }) => issue.path.join('.') === key), 'R326 HTTP: отказ по нужному полю');
        assert.deepEqual(normal(await t.db.select().from(schema.serverEconomy)), before, 'R326 HTTP: невалидное поле не пишет SQL');
        assert.deepEqual(normal(f.writes), events, 'R326 HTTP: невалидное поле не рассылается');
      }
      await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { currencyName: 'Монеты' } });
      assert.equal((await get(f)).settings[key], high, 'R326 HTTP: старый PATCH не сбрасывает новое поле');
    }, { file: 'routes/economy', from: line, to },
    `R326 HTTP: ${key}=${label === 'нижняя граница' ? low-1 : label === 'верхняя граница' ? high+1 : low+0.5} отклоняется`);
  }
}

for (const [key, value] of [['gamesEnabled', true], ['gamesBetMax', 421], ['gamesDailyLossMax', 902], ['gamesFeePercent', 17]] as const) {
  // Ручной toEconomy способен сохранить колонку, но тихо потерять её в JSON и расчётах.
  paired(`настройка ${key} проходит через toEconomy в PATCH и GET`, async f => {
    f.manage(true);
    const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { [key]: value } });
    assert.equal(response.statusCode, 200, 'R326 HTTP: настройка принята');
    assert.equal(response.json()[key], value, `R326 HTTP: toEconomy сохраняет ${key} в PATCH`);
    assert.equal((await get(f)).settings[key], value, `R326 HTTP: toEconomy сохраняет ${key} в GET`);
  }, { file: 'coins', from: `${key}: row.${key},`, to: '' });
}

// Иначе тест true→true не поймает проигнорированный PATCH переключателя.
paired('gamesEnabled действительно переключается false→true в SQL и общем снимке', async f => {
  f.manage(true);
  for (const value of [false, true]) {
    const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { gamesEnabled: value } });
    assert.equal(response.statusCode, 200, 'R326 HTTP: переключатель игр принят');
    const [saved] = await t.db.select().from(schema.serverEconomy);
    assert.equal(saved.gamesEnabled, value, 'R326 HTTP: переключатель игр записан в SQL');
    assert.equal(response.json().gamesEnabled, value);
    assert.equal((await get(f)).gamesEnabled, value);
  }
}, { file: 'routes/economy', from: 'gamesEnabled: z.boolean().optional(),', to: '' },
'R326 HTTP: переключатель игр записан в SQL');

paired('R343 закрытый замок запрещает включение управляющему, но разрешает супер-админу и не мешает выключению', async f => {
  f.manage(true); f.instanceOpen(false);
  const patch = (gamesEnabled: boolean) => f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { gamesEnabled } });
  assert.equal((await get(f)).gamesLocked, true, 'R343 замок PATCH: управляющий видит замок');
  assert.equal((await patch(true)).statusCode, 200, 'R343 замок PATCH: полное сохранение уже включённых игр не запрещено');
  assert.equal((await patch(false)).statusCode, 200, 'R343 замок PATCH: выключение разрешено');
  const before = normal(await t.db.select().from(schema.serverEconomy));
  const writes = normal(f.writes);
  const denied = await patch(true);
  assert.equal(denied.statusCode, 403, 'R343 замок PATCH: управляющему отказано');
  assert.equal(denied.json().reason, 'games-locked', 'R343 замок PATCH: код отказа не потерян');
  assert.deepEqual(normal(await t.db.select().from(schema.serverEconomy)), before, 'R343 замок PATCH: отказ не пишет настройки');
  assert.deepEqual(normal(f.writes), writes, 'R343 замок PATCH: отказ не рассылает и не аудирует');
  f.super(true);
  assert.equal((await patch(true)).statusCode, 200, 'R343 замок PATCH: супер-админ обходит закрытый флаг');
  assert.equal((await get(f)).gamesEnabled, true, 'R343 замок PATCH: супер-админ действительно включает игры');
  assert.equal((await get(f)).gamesLocked, false, 'R343 замок PATCH: супер-админ не видит замок');
}, [
  { file: 'routes/economy', from: 'if (refuseGamesToggle({ want: patch.gamesEnabled, wasEnabled: !!current?.gamesEnabled, locked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true) })) {',
    to: 'if (false) {' },
  { file: 'routes/economy', from: 'if (refuseGamesToggle({ want: patch.gamesEnabled, wasEnabled: !!current?.gamesEnabled, locked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true) })) {',
    to: 'if (refuseGamesToggle({ want: patch.gamesEnabled, wasEnabled: !!current?.gamesEnabled, locked: gamesLockedFor(gamesOpenOnInstance(), false) })) {' },
], 'R343 замок PATCH:');

// Разрешение участнику менять личный предел не даёт права включать игры для всех.
paired('неуправляющий не может менять игры сервера', async f => {
  const before = normal(await t.db.select().from(schema.serverEconomy));
  const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy', payload: { gamesEnabled: false } });
  assert.equal(response.statusCode, 403, 'R326 HTTP: настройки игр требуют MANAGE_ECONOMY');
  assert.deepEqual(normal(await t.db.select().from(schema.serverEconomy)), before, 'R326 HTTP: чужие настройки не изменены');
}, { file: 'routes/economy', from: "const patch = settingsSchema.parse(req.body ?? {});\n    const ctx = await getMemberContext(serverId, req.user!.sub);\n    if (!ctx) return reply.code(404).send({ error: 'not a member' });\n    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });\n\n    // 🔴 Чтение старой ставки",
  to: "const patch = settingsSchema.parse(req.body ?? {});\n    const ctx = await getMemberContext(serverId, req.user!.sub);\n    if (!ctx) return reply.code(404).send({ error: 'not a member' });\n\n    // 🔴 Чтение старой ставки" });

// Смена одного отказа не должна тайно менять общий отказ или личный денежный предел.
paired('участник включает и снимает gamesOptOut, не трогая прочие отказы', async f => {
  await wallet({ tipsOptOut: true, gamesLossLimit: 300 });
  for (const gamesOptOut of [true, false]) {
    const response = await patchMe(f, { gamesOptOut });
    assert.equal(response.games.optOut, gamesOptOut, 'R326 HTTP: ответ сохраняет gamesOptOut');
    assert.equal(response.optedOut, false);
    assert.equal(response.tipsOptOut, true);
    assert.equal(response.games.lossLimit, 300);
    const [saved] = await t.db.select().from(schema.coinBalances);
    assert.equal(saved.gamesOptOut, gamesOptOut, 'R326 HTTP: отказ игр сохранён в SQL');
  }
}, { file: 'routes/economy', from: 'if (gamesOptOut !== undefined) set.gamesOptOut = gamesOptOut;', to: '' });

// Снижение важно применять в том же запросе, а не на следующие сутки.
paired('понижение личного предела действует сразу и отменяет ждущее повышение', async f => {
  await wallet({ gamesLossLimit: 300, gamesLossLimitRaise: 500, gamesLossLimitRaiseAt: new Date(NEXT) });
  const response = await patchMe(f, { gamesLossLimit: 299 });
  assert.deepEqual(response.games, { optOut: false, lossLimit: 299, lossLimitRaise: null, lossToday: 0, effectiveLimit: 299 },
    'R326 HTTP: понижение применено и старое повышение отменено');
  const [saved] = await t.db.select().from(schema.coinBalances);
  assert.equal(saved.gamesLossLimit, 299, 'R326 HTTP: новый предел в SQL');
  assert.equal(saved.gamesLossLimitRaiseAt, null, 'R326 HTTP: срок старого повышения очищен');
}, { file: 'routes/economy', from: 'set.gamesLossLimit = plan.lossLimit;', to: '' });

// Повысить в азарте нельзя немедленно; точно на полуночи разрешено без записи из GET.
paired('повышение личного предела ждёт следующей полуночи МСК и виртуально вступает ровно в срок', async f => {
  await wallet({ gamesLossLimit: 300 });
  const response = await patchMe(f, { gamesLossLimit: 301 });
  assert.deepEqual(response.games.lossLimitRaise, { value: 301, from: NEXT }, 'R326 HTTP: повышение отложено до полуночи МСК');
  assert.equal(response.games.effectiveLimit, 300, 'R326 HTTP: до полуночи старый предел');
  f.at(Date.parse(NEXT));
  assert.deepEqual((await get(f)).wallet.games, { optOut: false, lossLimit: 301, lossLimitRaise: null, lossToday: 0, effectiveLimit: 301 },
    'R326 HTTP: ровно в срок новый предел');
  const [saved] = await t.db.select().from(schema.coinBalances);
  assert.equal(saved.gamesLossLimit, 300, 'R326 HTTP: GET не пишет повышение в кошелёк');
}, { file: 'routes/economy', from: 'set.gamesLossLimitRaiseAt = plan.raiseAt;', to: '' });

// null означает будущий серверный потолок, а не отмену ограничения в этом же ответе.
paired('как на сервере отправляет отложенный null при меньшем личном пределе', async f => {
  await wallet({ gamesLossLimit: 300 });
  const response = await patchMe(f, { gamesLossLimit: null });
  assert.equal(response.games.lossLimit, 300, 'R326 HTTP: null не снимает текущий предел раньше времени');
  assert.deepEqual(response.games.lossLimitRaise, { value: null, from: NEXT }, 'R326 HTTP: null имеет срок повышения');
  f.at(Date.parse(NEXT));
  const view = (await get(f)).wallet.games;
  assert.equal(view.lossLimit, null);
  assert.equal(view.effectiveLimit, 887, 'R326 HTTP: null после полуночи берёт серверный потолок');
}, { file: 'routes/economy', from: 'if (gamesLossLimit !== undefined && cur)', to: 'if (gamesLossLimit != null && cur)' });

// Общий отказ запрещает играть даже если личный выключатель игр не установлен.
paired('optedOut из PATCH me запрещает ставку, но не подменяет личный gamesOptOut', async f => {
  const response = await patchMe(f, { optedOut: true });
  assert.equal(response.optedOut, true, 'R326 HTTP: общий отказ сохранён');
  assert.equal(response.games.optOut, false, 'R326 HTTP: независимый отказ игр не переставлен');
  const [saved] = await t.db.select().from(schema.coinBalances);
  const block = f.rules.stakeBlock({ economyEnabled: true, gamesEnabled: true, isBot: false,
    optedOut: saved.optedOut, gamesOptOut: saved.gamesOptOut, amount: 1, pick: 'red',
    betMax: 337, balance: 100, lossToday: 0, effectiveLimit: 887 });
  assert.equal(block, 'opted-out', 'R326 HTTP: общий отказ выключает игры');
}, { file: 'gameMoneyRules', from: "if (c.optedOut) return 'opted-out';", to: '' });

const personalLine = 'gamesLossLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),';
for (const [label, to, wrong] of [
  ['нижняя граница', () => personalLine.replace('.min(0)', ''), -1],
  ['верхняя граница', () => personalLine.replace('.max(1_000_000)', ''), 1_000_001],
  ['целочисленный предел', () => personalLine.replace('.int()', ''), 0.5],
] as const) {
  // Невалидная просьба не может менять ни текущий предел, ни уже запланированное повышение.
  paired(`PATCH me: ${label}, ноль/миллион/null принимаются, неверный предел не пишет`, async f => {
    await wallet();
    for (const value of [0, 1, 999_999, 1_000_000, null]) {
      const response = await patchMe(f, { gamesLossLimit: value });
      assert.ok(response.games, 'R326 HTTP: валидный личный предел возвращает games');
    }
    for (const value of [-1, 1_000_001, 0.5, '12', false]) {
      const before = normal(await t.db.select().from(schema.coinBalances));
      const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy/me', payload: { gamesLossLimit: value } });
      assert.equal(response.statusCode, 400, `R326 HTTP: личный предел ${value} отклоняется`);
      assert.ok(response.json().details.some((issue: { path: string[] }) => issue.path.join('.') === 'gamesLossLimit'));
      assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before, 'R326 HTTP: неверный предел не меняет кошелёк');
    }
  }, { file: 'routes/economy', from: personalLine, to }, `R326 HTTP: личный предел ${wrong} отклоняется`);
}

// Строка «false» не должна оказаться истинным значением из-за приведения типов на пути в БД.
paired('PATCH me принимает только boolean gamesOptOut, строка не меняет отказ', async f => {
  await wallet();
  for (const value of [true, false]) assert.equal((await patchMe(f, { gamesOptOut: value })).games.optOut, value);
  for (const value of ['false', 1, null]) {
    const before = normal(await t.db.select().from(schema.coinBalances));
    const response = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy/me', payload: { gamesOptOut: value } });
    assert.equal(response.statusCode, 400, `R326 HTTP: отказ игр ${value} не boolean`);
    assert.deepEqual(normal(await t.db.select().from(schema.coinBalances)), before);
  }
}, { file: 'routes/economy', from: 'gamesOptOut: z.boolean().optional(),', to: 'gamesOptOut: z.any().optional(),' },
'R326 HTTP: отказ игр false не boolean');

test('новый потолок сервера виден в общем снимке сразу, личное повышение ждёт следующих суток МСК', async () => {
  const f = await fixture();
  try {
    await wallet({ gamesLossLimit: 300 });
    await patchMe(f, { gamesLossLimit: 12000 });
    f.manage(true);
    const changed = await f.app.inject({ method: 'PATCH', url: '/servers/server/economy',
      payload: { gamesDailyLossMax: 15000 } });
    assert.equal(changed.statusCode, 200);
    assert.ok(f.writes.some((entry: any) => entry[0] === 'server' && entry[2]?.t === 'server.invalidate'),
      'сохранение настроек уведомляет подключённые клиенты');
    f.manage(false);
    let view = await get(f);
    assert.equal(view.gamesDailyLossMax, 15000, 'обычный участник видит актуальный потолок');
    assert.equal(view.wallet.games.effectiveLimit, 300, 'серверное повышение не обходит самоограничение');
    assert.deepEqual(view.wallet.games.lossLimitRaise, { value: 12000, from: NEXT });
    f.at(Date.parse(NEXT)); view = await get(f);
    assert.equal(view.wallet.games.effectiveLimit, 12000);
    assert.equal(view.wallet.games.lossLimitRaise, null);
    assert.deepEqual(f.errors, []); await drift();
  } finally { await f.app.close(); }
});
