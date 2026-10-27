import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../db/schema.js';
import * as rules from '../bots/botRules.js';

const source = readFileSync(new URL('./botPress.ts', import.meta.url), 'utf8');
type Handler = (req: unknown, reply: unknown) => Promise<unknown>;
async function checkLimit(text: string, blocked: string) {
  const routes = new Map<string, Handler>(), io: string[] = [], rates: string[] = [];
  const forbidden = (name: string) => () => { io.push(name); throw new Error(`неожиданный IO ${name}`); };
  const dependencies: Record<string, unknown> = {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/schema.js': schema,
    '../auth.js': { requireAuth: () => {} }, '../guestGuard.js': { requireLocalUser: () => {} },
    '../authGuard.js': { rateHit: async (key: string) => { rates.push(key); return key === blocked ? 9 : 0; } },
    '../bots/botRules.js': rules,
    '../bots/botCallback.js': {}, '../bots/botWire.js': {}, '../bots/webhookDelivery.js': {},
    '../bots/botStore.js': { botById: forbidden('botById') },
    '../conversations.js': { loadAccess: async () => { io.push('loadAccess'); return { kind: 'direct', peerId: 'bot-one', saved: false }; } },
    '../db/index.js': { db: { select: forbidden('select') } },
    './serverBots.js': { serverBotRoutes: () => {} },
    '../permissions.js': {},
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `объявленная IO граница ${id}`); return dependencies[id];
    },
  });
  const app = {
    addHook() {}, get() {}, post(path: string, handler: Handler) { routes.set(path, handler); },
    register(plugin: (app: unknown) => unknown) { return plugin(app); },
  };
  await (module.exports as { botPressRoutes(app: unknown): Promise<void> }).botPressRoutes(app);
  let status = 200, body: unknown;
  const reply = { header() { return this; }, code(n: number) { status = n; return this; }, send(value: unknown) { body = value; return this; } };
  let caught: unknown;
  try { await routes.get('/conv/:id/messages/:mid/callback')!({ user: { sub: 'person' }, params: { id: 'chat', mid: 'message' }, body: { data: 'status' } }, reply); }
  catch (error) { caught = error; }
  assert.deepEqual(io, blocked === 'cbq:person' ? [] : ['loadAccess'], 'R303 предел нажатий срабатывает до лишних выборок');
  assert.equal(caught, undefined); assert.equal(status, 429);
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { error: 'Слишком часто', retryAfter: 9 });
  assert.deepEqual(rates, blocked === 'cbq:person' ? ['cbq:person'] : ['cbq:person', 'cbqbot:bot-one']);
}

it('R303 предел человека останавливает callback до любых выборок', () => checkLimit(source, 'cbq:person'));
it('R303 предел бота допускает только загрузку доступа, но не бота и сообщения', () => checkLimit(source, 'cbqbot:bot-one'));
it('R303 контрфакт переноса пользовательского лимита за SQL ловит лишнюю выборку', async () => {
  await checkLimit(source, 'cbq:person');
  const anchor = '      if (await tooMany(reply, `cbq:${me}`, CALLBACK_USER_RATE)) return reply;';
  // В модуле два входа: канал и ЛС. Мутируем только последний, проверяемый маршрут ЛС.
  const at = source.lastIndexOf(anchor); assert.ok(at >= 0);
  const changed = source.slice(0, at) + source.slice(at).replace(anchor, `      await directAccess(req.params.id, me);\n${anchor}`);
  await assert.rejects(checkLimit(changed, 'cbq:person'), (error: unknown) => error instanceof assert.AssertionError
    && error.message.split(/\r?\n/, 1)[0] === 'R303 предел нажатий срабатывает до лишних выборок'
    && JSON.stringify(error.actual) === '["loadAccess"]' && JSON.stringify(error.expected) === '[]');
});

it('R303 контрфакт инверсии владельца ловится на разрешённом владельце приватного бота', () => {
  const raw = readFileSync(new URL('../../../shared/src/bots.ts', import.meta.url), 'utf8');
  const check = (text: string) => {
    const module = { exports: {} };
    // Полный общий модуль, не копия формулы: мутант меняет тот же предикат, которым пользуются оба HTTP-входа и сводка.
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, require: (id: string) => { assert.equal(id, './permissions'); return shared; },
    });
    const api = module.exports as typeof import('@gusvoice/shared');
    const bot = { ownerId: 'owner', public: false, disabledAt: null };
    assert.equal(api.botUnavailableFor(bot, true, 'owner'), null, 'R303 владелец приватного бота проходит');
    assert.equal(api.botUnavailableFor(bot, true, 'other'), 'private');
    assert.equal(api.botUnavailableFor({ ...bot, public: true }, true, 'other'), null);
    assert.equal(api.botUnavailableFor(bot, false, 'owner'), 'disabled');
    assert.equal(api.botUnavailableFor({ ...bot, disabledAt: new Date() }, true, 'owner'), 'disabled');
  };
  check(raw);
  const anchor = 'bot.ownerId !== me'; assert.equal(raw.split(anchor).length, 2);
  assert.throws(() => check(raw.replace(anchor, 'bot.ownerId === me')), (error: unknown) => error instanceof assert.AssertionError
    && error.message.split(/\r?\n/, 1)[0] === 'R303 владелец приватного бота проходит' && error.actual === 'private' && error.expected === null);
});
