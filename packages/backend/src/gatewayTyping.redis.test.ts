import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { FEATURE_TYPING2, parseTypingAction, typingActionField, typingActionFor } from '@gusvoice/shared';
import { reachesPeer } from './blockRules.js';
import { typingRoute } from './gatewayRules.js';
import { relayTyping, type TypingDeps } from './gatewayTyping.js';

type Message = Parameters<TypingDeps<string>['send']>[1];
type Route = { cap?: string; notCap?: string };
type Relay = typeof relayTyping;

function fixture() {
  const published: { userId: string; msg: Message; route?: Route }[] = [];
  const sent: { socket: string; msg: Message }[] = [];
  const remote: unknown[][] = [];
  const remoteGroup: unknown[][] = [];
  const calls: unknown[][] = [];
  const blocked = new Set<string>();
  const remotes = new Set<string>();
  const sockets = new Map<string, { socket: string; caps?: ReadonlySet<string> }[]>([
    ['bob', [{ socket: 'bob-new', caps: new Set([FEATURE_TYPING2]) }, { socket: 'bob-old' }]],
  ]);
  let limited = false;
  let peer: string | null = 'bob';
  let group: string[] | null = null;
  let shown = true;
  const deps: TypingDeps<string> = {
    rateHit: async (...args) => { calls.push(['rate', ...args]); return limited ? 1 : 0; },
    dmPeerOf: async (...args) => { calls.push(['dm', ...args]); return peer; },
    groupPeersOf: async (...args) => { calls.push(['group', ...args]); return group; },
    isBlockedBy: async (...args) => { calls.push(['block', ...args]); return blocked.has(args[0]); },
    shownTo: async (...args) => { calls.push(['shown', ...args]); return shown; },
    connsOf: id => { calls.push(['conns', id]); return sockets.get(id) ?? []; },
    send: (socket, msg) => { sent.push({ socket, msg: { ...msg } }); },
    // Копии принадлежат realm теста: чужой прототип из VM не должен изображать регрессию доставки.
    publishToUser: async (userId, msg, route) => {
      published.push({ userId, msg: { ...msg }, ...(route === undefined ? {} : { route: { ...route } }) });
    },
    isRemote: id => remotes.has(id),
    remoteTyping: (...args) => { remote.push(args); },
    remoteGroupTyping: (...args) => { remoteGroup.push(args); },
    getChannelAudience: async (...args) => { calls.push(['audience', ...args]); return null; },
    publishToChannel: async (...args) => { calls.push(['channel', ...args]); },
  };
  return {
    deps, published, sent, remote, remoteGroup, calls, blocked, remotes, sockets,
    conn: { userId: 'alice', servers: new Set(['server']) },
    limit: () => { limited = true; },
    hide: () => { shown = false; },
    show: () => { shown = true; },
    group: (value: string[] | null) => { peer = null; group = value; },
  };
}

function frame(dmId = 'dm', action?: Message['action']): Message {
  return { t: 'typing', dmId, userId: 'alice', ...(action === undefined ? {} : { action }) };
}

async function onePublish(relay: Relay = relayTyping) {
  const f = fixture();
  await relay(f.deps, f.conn, { dmId: 'dm', action: 'sticker' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('dm', 'sticker') }], 'ЛС публикуется ровно один раз без отбора устройств');
  assert.deepEqual(f.sent, [], 'Redis исключает прямой send даже при двух местных устройствах');
  assert.deepEqual(f.remote, []);
  assert.deepEqual(f.calls.filter(x => x[0] === 'block' || x[0] === 'shown'), [
    ['block', 'bob', 'alice'], ['shown', 'dm', 'bob'],
  ]);
}

async function noLocalSockets(relay: Relay = relayTyping) {
  const f = fixture();
  f.sockets.clear();
  await relay(f.deps, f.conn, { dmId: 'dm', action: 'voice_upload' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('dm', 'voice_upload') }], 'отсутствие местных сокетов не отменяет публикацию');
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.remote, []);
  assert.deepEqual(f.calls.filter(x => x[0] === 'block' || x[0] === 'shown'), [
    ['block', 'bob', 'alice'], ['shown', 'dm', 'bob'],
  ]);
}

async function roundEnvelopes(relay: Relay = relayTyping) {
  for (const group of [false, true]) {
    const f = fixture();
    if (group) f.group(['bob', 'offline']);
    await relay(f.deps, f.conn, { dmId: 'dm', action: 'round' });
    assert.deepEqual(f.published, (group ? ['bob', 'offline'] : ['bob']).flatMap(userId => [
      { userId, msg: frame('dm', 'round'), route: { cap: FEATURE_TYPING2 } },
      { userId, msg: frame('dm', 'voice'), route: { notCap: FEATURE_TYPING2 } },
    ]), 'кружок имеет два непересекающихся конверта cap/notCap для каждого получателя');
    assert.deepEqual(f.sent, []);
  }
}

async function groupBlock(relay: Relay = relayTyping) {
  const f = fixture();
  f.group(['bob', 'offline', 'blocked']);
  f.blocked.add('blocked');
  await relay(f.deps, f.conn, { dmId: 'group', action: 'file' });
  assert.deepEqual(f.published.map(x => x.userId), ['bob', 'offline'], 'групповой блок исключает публикацию заблокировавшему');
  assert.deepEqual(f.published.map(x => x.msg), [frame('group', 'file'), frame('group', 'file')]);
  assert.deepEqual(f.calls.filter(x => x[0] === 'block'), [
    ['block', 'bob', 'alice'], ['block', 'offline', 'alice'], ['block', 'blocked', 'alice'],
  ]);
  assert.deepEqual(f.sent, []);
  // Парный допуск: отсутствие сокетов не означает запрет, снятие блока возвращает адресата.
  f.blocked.clear(); f.published.length = 0;
  await relay(f.deps, f.conn, { dmId: 'group', action: 'file' });
  assert.deepEqual(f.published.map(x => x.userId), ['bob', 'offline', 'blocked']);
}

async function groupRemote(relay: Relay = relayTyping) {
  const f = fixture();
  f.group(['bob', 'remote']);
  f.remotes.add('remote');
  f.sockets.set('remote', [{ socket: 'remote-guest' }]);
  await relay(f.deps, f.conn, { dmId: 'group', action: 'photo' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('group', 'photo') }], 'чужому инстансу не публикуем в местный пользовательский канал');
  assert.deepEqual(f.remoteGroup, [['group', 'alice', 'photo']]);
  assert.deepEqual(f.remote, []);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.calls.filter(x => x[0] === 'block'), [['block', 'bob', 'alice']]);
  f.remotes.clear(); f.published.length = 0;
  await relay(f.deps, f.conn, { dmId: 'group', action: 'photo' });
  assert.deepEqual(f.published.map(x => x.userId), ['bob', 'remote']);
}

it('R259 ЛС с местными устройствами публикуется однажды и не дублируется прямой отправкой', async () => {
  await onePublish();
});

it('R259 местный собеседник без сокетов всё равно получает публикацию после проверок доступа', async () => {
  await noLocalSockets();
});

it('R259 удалённый собеседник даже с гостевыми сокетами получает только федеративную пересылку', async () => {
  for (const online of [false, true]) {
    const f = fixture(); f.remotes.add('bob');
    if (!online) f.sockets.clear();
    await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'round' });
    assert.deepEqual(f.remote, [['dm', 'alice', 'bob', 'round']]);
    assert.deepEqual(f.published, []);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.calls.filter(x => x[0] === 'block' || x[0] === 'shown'), []);
    f.remotes.clear(); f.remote.length = 0;
    await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
    assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('dm', 'voice') }]);
    assert.deepEqual(f.remote, []);
  }
});

it('R259 блок в ЛС запрещает публикацию, снятие блока разрешает её без местных сокетов', async () => {
  const f = fixture(); f.sockets.clear(); f.blocked.add('bob');
  await relayTyping(f.deps, f.conn, { dmId: 'dm' });
  assert.deepEqual(f.published, []); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.calls.filter(x => x[0] === 'shown'), []);
  f.blocked.clear();
  await relayTyping(f.deps, f.conn, { dmId: 'dm' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame() }]);
});

it('R259 скрытая беседа не раскрывается набором, показанная беседа публикуется', async () => {
  const f = fixture(); f.hide();
  await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
  assert.deepEqual(f.published, []); assert.deepEqual(f.sent, []);
  f.show();
  await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('dm', 'voice') }]);
});

it('R259 старый вызывающий без shownTo сохраняет разрешённую публикацию', async () => {
  const f = fixture(); delete f.deps.shownTo;
  await relayTyping(f.deps, f.conn, { dmId: 'dm' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame() }]);
});

it('R259 кружок в ЛС и группе разделяется на typing2 round и прежний voice', async () => {
  await roundEnvelopes();
});

it('R259 остальные действия ЛС и группы сохраняются без фильтра, обычный и неизвестный набор не имеют action', async () => {
  for (const group of [false, true]) {
    for (const action of ['voice', 'photo', 'video', 'file', 'voice_upload', 'sticker'] as const) {
      const f = fixture(); if (group) f.group(['bob']);
      await relayTyping(f.deps, f.conn, { dmId: 'dm', action });
      assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('dm', action) }]);
      assert.deepEqual(f.sent, []);
    }
    for (const action of [undefined, 'typing', 'unknown', '', null, 7, { action: 'round' }]) {
      const f = fixture(); if (group) f.group(['bob']);
      await relayTyping(f.deps, f.conn, { dmId: 'dm', action });
      assert.deepEqual(f.published, [{ userId: 'bob', msg: frame() }]);
      assert.equal(Object.hasOwn(f.published[0].msg, 'action'), false);
      assert.deepEqual(f.sent, []);
    }
  }
});

it('R259 группа публикует каждому разрешённому местному участнику, в том числе без сокетов', async () => {
  await groupBlock();
});

it('R259 группа пропускает remote-участника с гостевым сокетом и сохраняет пересылку хосту', async () => {
  await groupRemote();
});

it('R259 набор группы от тени не возвращается в федерацию, местный отправитель пересылается', async () => {
  for (const remoteSender of [true, false]) {
    const f = fixture(); f.group(['bob']);
    if (remoteSender) f.remotes.add('alice');
    await relayTyping(f.deps, f.conn, { dmId: 'group', action: 'unknown' });
    assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('group') }]);
    assert.deepEqual(f.remoteGroup, remoteSender ? [] : [['group', 'alice', 'typing']]);
  }
});

it('R259 отсутствие участия в группе не раскрывает набор ни местным, ни федерации', async () => {
  const f = fixture(); f.group(null);
  await relayTyping(f.deps, f.conn, { dmId: 'foreign', action: 'round' });
  assert.deepEqual(f.published, []); assert.deepEqual(f.sent, []); assert.deepEqual(f.remoteGroup, []);
  f.group(['bob']);
  await relayTyping(f.deps, f.conn, { dmId: 'group' });
  assert.deepEqual(f.published, [{ userId: 'bob', msg: frame('group') }]);
});

it('R259 лимит typing отправителя 20 за 10 секунд режет ЛС, группу и канал до SQL и доставки', async () => {
  for (const msg of [{ dmId: 'dm' }, { dmId: 'group' }, { serverId: 'server', channelId: 'channel' }]) {
    const f = fixture(); if (msg.dmId === 'group') f.group(['bob']); f.limit();
    await relayTyping(f.deps, f.conn, msg);
    assert.deepEqual(f.calls, [['rate', 'typing:alice', 20, 10]]);
    assert.deepEqual(f.published, []); assert.deepEqual(f.sent, []);
    assert.deepEqual(f.remote, []); assert.deepEqual(f.remoteGroup, []);
  }
  const allowed = fixture();
  await relayTyping(allowed.deps, allowed.conn, { dmId: 'dm' });
  assert.deepEqual(allowed.calls[0], ['rate', 'typing:alice', 20, 10]);
  assert.equal(allowed.published.length, 1);
});

it('R259 без publishToUser прежняя прямая доставка ЛС и группы различает возможности устройств', async () => {
  for (const group of [false, true]) {
    const f = fixture(); delete f.deps.publishToUser;
    if (group) f.group(['bob', 'offline', 'blocked']);
    f.blocked.add('blocked');
    await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'round' });
    assert.deepEqual(f.sent, [
      { socket: 'bob-new', msg: frame('dm', 'round') },
      { socket: 'bob-old', msg: frame('dm', 'voice') },
    ]);
    assert.deepEqual(f.published, []);
    f.sockets.clear(); f.sent.length = 0; f.calls.length = 0;
    await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.calls.filter(x => x[0] === 'block' || x[0] === 'shown'), []);
    assert.deepEqual(f.remote, group ? [] : [['dm', 'alice', 'bob', 'voice']]);
  }
});

const source = readFileSync(new URL('./gatewayTyping.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function loadRelay(code: string): Relay {
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
    fileName: 'gatewayTyping.ts',
  });
  assert.deepEqual(output.diagnostics?.filter(x => x.category === ts.DiagnosticCategory.Error) ?? [], [], 'мутант обязан оставаться синтаксически корректным');
  const module = { exports: {} as typeof import('./gatewayTyping.js') };
  const imports: Record<string, unknown> = {
    '@gusvoice/shared': { FEATURE_TYPING2, parseTypingAction, typingActionField, typingActionFor },
    './blockRules.js': { reachesPeer },
    './gatewayRules.js': { typingRoute },
  };
  // Исполняется весь модуль; неожиданный импорт — ошибка стенда, не победа над мутантом.
  runInNewContext(output.outputText, {
    module, exports: module.exports,
    require(id: string) {
      assert.ok(Object.hasOwn(imports, id), `неописанный импорт gatewayTyping: ${id}`);
      return imports[id];
    },
  });
  assert.equal(typeof module.exports.relayTyping, 'function');
  return module.exports.relayTyping;
}

async function kills(from: string, to: string, scenario: (relay: Relay) => Promise<void>, marker: string) {
  assert.equal(source.split(from).length, 2, `единственный якорь мутации: ${from}`);
  await scenario(loadRelay(source));
  const mutated = loadRelay(source.replace(from, to));
  await assert.rejects(() => scenario(mutated), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.includes(marker),
  );
}

it('R259 мутант с send рядом с Redis пойман реальным дублем, а не ошибкой загрузки', async () => {
  await kills(
    'if (deps.publishToUser) await publishTo(route.peerId, route.dmId);',
    "if (deps.publishToUser) { await publishTo(route.peerId, route.dmId); for (const c of conns) deps.send(c.socket, { t: 'typing', dmId: route.dmId, userId: uid, ...extraFor(c.caps) }); }",
    onePublish, 'Redis исключает прямой send',
  );
});

it('R259 мутант с ранним выходом без местных сокетов теряет адресную публикацию', async () => {
  await kills(
    'if (deps.publishToUser) {\n      // #225:',
    'if (deps.publishToUser) {\n      if (conns.length === 0) return;\n      // #225:',
    noLocalSockets, 'отсутствие местных сокетов не отменяет публикацию',
  );
});

it('R259 мутант без notCap пойман пересечением конвертов кружка', async () => {
  await kills(', { notCap: FEATURE_TYPING2 }', '', roundEnvelopes, 'кружок имеет два непересекающихся конверта');
});

it('R259 мутант без групповой блокировки пойман лишним получателем публикации', async () => {
  await kills(
    '        if (!reachesPeer(await deps.isBlockedBy(p, uid))) continue;',
    '        // Мутант: блокировка ошибочно пропущена.',
    groupBlock, 'групповой блок исключает публикацию заблокировавшему',
  );
});

it('R259 мутант с местной публикацией remote-участнику пойман утечкой в чужой маршрут', async () => {
  await kills(
    '        if (deps.isRemote?.(p)) continue;',
    '        // Мутант: участник чужого инстанса ошибочно местный.',
    groupRemote, 'чужому инстансу не публикуем в местный пользовательский канал',
  );
});
