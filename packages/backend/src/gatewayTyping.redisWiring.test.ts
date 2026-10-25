import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { GatewayServerMessage } from '@gusvoice/shared';
import { relayTyping, type TypingDeps } from './gatewayTyping.js';
import { capAllows } from './gatewayRules.js';

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const gatewaySource = read('gateway.ts'), realtimeSource = read('realtime.ts');

function descendants(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = [];
  function visit(n: ts.Node) { if (predicate(n)) nodes.push(n); ts.forEachChild(n, visit); }
  visit(node); return nodes;
}
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');

function publisherGuard(raw = gatewaySource) {
  // Только AST реального gateway: исходник со стором/Redis не импортируется, фрагменты не исполняются.
  const file = ts.createSourceFile('gateway.ts', raw, ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration).filter((n) =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === './realtime.js');
  assert.equal(imports.length, 1);
  const names = imports[0].importClause?.namedBindings;
  assert.ok(names && ts.isNamedImports(names));
  assert.ok(names.elements.some((n) => n.name.text === 'publishToUser' && (!n.propertyName || n.propertyName.text === 'publishToUser')),
    'R259 публикация шлюза импортирована из realtime');
  const declarations = descendants(file, (n) => ts.isVariableDeclaration(n) && n.name.getText() === 'typingDeps') as ts.VariableDeclaration[];
  assert.equal(declarations.length, 1);
  const deps = declarations[0].initializer;
  assert.ok(deps && ts.isObjectLiteralExpression(deps));
  const properties = deps.properties.filter((n) => ts.isPropertyAssignment(n) && n.name.getText() === 'publishToUser') as ts.PropertyAssignment[];
  assert.equal(properties.length, 1, 'R259 typingDeps получает публикацию Redis');
  const publish = properties[0].initializer;
  assert.ok(ts.isArrowFunction(publish));
  assert.deepEqual(publish.parameters.map((n) => n.name.getText()), ['userId', 'msg', 'route']);
  assert.equal(compact(publish.body), 'publishToUser(userId,msg,route)', 'R259 typingDeps не теряет cap/notCap при передаче');
  const calls = descendants(file, (n) => ts.isCallExpression(n) && n.expression.getText() === 'relayTyping') as ts.CallExpression[];
  assert.equal(calls.length, 2, 'местный и федеративный набор проходят один relay');
  for (const call of calls) assert.equal(call.arguments[0]?.getText(), 'typingDeps', 'оба входа используют зависимости с Redis');
}

type Envelope = { m: GatewayServerMessage; cap?: string; notCap?: string };
function fixture(raw = realtimeSource) {
  const records: { channel: string; payload: string }[] = [];
  let connections = 0;
  class Redis {
    constructor(url: string) { assert.equal(url, 'test-transport-only'); connections++; }
    async publish(channel: string, payload: string) { records.push({ channel, payload }); return 1; }
  }
  const dependencies: Record<string, unknown> = {
    ioredis: { __esModule: true, default: Redis }, './env.js': { env: { redisUrl: 'test-transport-only' } },
    './permissions.js': { getChannelAudience: () => assert.fail('адресный typing не читает аудиторию канала') },
  };
  const module = { exports: {} as typeof import('./realtime.js') };
  // Целый realtime, настоящий publishToUser/JSON-конверт; вместо соединения с Redis — запись аргументов publish.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, require: (id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), `Неописанная граница realtime ${id}`); return dependencies[id];
  } });
  assert.equal(connections, 1);
  const deps: TypingDeps<string> = {
    rateHit: async () => 0, dmPeerOf: async () => 'recipient', isBlockedBy: async () => false, shownTo: async () => true,
    connsOf: () => [], publishToUser: module.exports.publishToUser,
    send: () => assert.fail('локальный send дал бы дубль опубликованного typing'),
    getChannelAudience: async () => assert.fail('ЛС не читают аудиторию канала'),
    publishToChannel: async () => assert.fail('ЛС не публикуются в серверный канал'),
  };
  return { deps, records, envelopes: () => records.map((r) => JSON.parse(r.payload) as Envelope) };
}
const conn = { userId: 'sender', servers: new Set<string>() };

it('R259 шлюз передаёт в оба входа relay настоящий publishToUser вместе с маршрутом возможностей', () => {
  // Проверка правил не заметит, если dependency забыли подключить к живому шлюзу.
  publisherGuard();
});

it('R259 настоящий realtime публикует один адресный кадр ЛС в gw:user, а не в канал сервера', async () => {
  // Нет местных соединений, но фактический формат публикации всё равно обязан дойти до шины.
  for (const action of [undefined, 'voice_upload']) {
    const f = fixture();
    await relayTyping(f.deps, conn, { dmId: 'dm', action });
    assert.deepEqual(f.records.map((r) => r.channel), ['gw:user:recipient']);
    assert.deepEqual(f.envelopes(), [{ m: { t: 'typing', dmId: 'dm', userId: 'sender', ...(action ? { action } : {}) } }]);
    assert.ok(!Object.hasOwn(f.envelopes()[0], 'to'), 'адресная публикация не раскрывает аудиторию сервера');
  }
});

async function roundProbe(raw = realtimeSource) {
  const f = fixture(raw);
  await relayTyping(f.deps, conn, { dmId: 'dm', action: 'round' });
  assert.deepEqual(f.records.map((r) => r.channel), ['gw:user:recipient', 'gw:user:recipient']);
  assert.deepEqual(f.envelopes(), [
    { m: { t: 'typing', dmId: 'dm', userId: 'sender', action: 'round' }, cap: 'typing2' },
    { m: { t: 'typing', dmId: 'dm', userId: 'sender', action: 'voice' }, notCap: 'typing2' },
  ], 'R259 JSON Redis сохраняет оба фильтра round/voice');
  for (const [caps, action] of [[new Set(['typing2']), 'round'], [new Set(['typing1']), 'voice'], [undefined, 'voice']] as const) {
    const delivered = f.envelopes().filter((envelope) => capAllows(envelope, caps)).map((envelope) => envelope.m);
    assert.deepEqual(delivered, [{ t: 'typing', dmId: 'dm', userId: 'sender', action }],
      'один подходящий конверт на соединение, включая legacy без caps');
  }
}
it('R259 два конверта кружка проходят настоящий JSON и дают по одному событию новым и старым caps', async () => {
  // Наличие notCap в spy вызова недостаточно: потеря поля при сериализации удвоила бы кадр у новых клиентов.
  await roundProbe();
});

it('R259 страж проводки ловит потерю publisher и потерю route после проверки оригинала', () => {
  const anchor = 'publishToUser: (userId, msg, route) => publishToUser(userId, msg, route),';
  assert.equal(gatewaySource.split(anchor).length - 1, 1);
  for (const [replacement, marker] of [
    ['', 'R259 typingDeps получает публикацию Redis'],
    ['publishToUser: (userId, msg, route) => publishToUser(userId, msg),', 'R259 typingDeps не теряет cap/notCap'],
  ]) {
    publisherGuard();
    assert.throws(() => publisherGuard(gatewaySource.replace(anchor, replacement)),
      (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(marker));
  }
});

it('R259 контрфакт потери notCap в Redis-конверте ловится после original-first сценария', async () => {
  await roundProbe();
  const anchor = 'if (route?.notCap !== undefined) env.notCap = route.notCap;';
  assert.equal(realtimeSource.split(anchor).length - 1, 1);
  await assert.rejects(() => roundProbe(realtimeSource.replace(anchor, '/* фильтр потерян */')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('R259 JSON Redis сохраняет оба фильтра round/voice'));
});
