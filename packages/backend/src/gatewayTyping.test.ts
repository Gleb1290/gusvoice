import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { relayTyping, type TypingDeps } from './gatewayTyping.js';
import { parseTypingAction, typingActionField, typingActionFor } from '@gusvoice/shared';
import { reachesPeer } from './blockRules.js';
import { typingRoute } from './gatewayRules.js';

function fixture() {
  const sent: { socket: string; msg: unknown }[] = [];
  const published: { serverId: string; channelId: string; msg: unknown; audience: string[] }[] = [];
  const lookedUp: string[] = [];
  let limited = false;
  let peer: string | null = 'bob';
  let blocked = false;
  let shown: boolean | undefined = undefined;
  const shownChecks: string[] = [];
  let audience: { serverId: string; userIds: string[] } | null = { serverId: 'server', userIds: ['alice', 'bob'] };
  const deps: TypingDeps<string> = {
    rateHit: async () => limited ? 1 : 0,
    dmPeerOf: async (dmId, senderId) => { lookedUp.push(`${dmId}:${senderId}`); return peer; },
    isBlockedBy: async (blockerId, blockedId) => {
      assert.deepEqual([blockerId, blockedId], ['bob', 'alice']);
      return blocked;
    },
    shownTo: async (dmId, userId) => { shownChecks.push(`${dmId}:${userId}`); return shown ?? true; },
    connsOf: (userId) => {
      assert.equal(userId, 'bob');
      return [{ socket: 'bob-phone' }, { socket: 'bob-desktop' }];
    },
    send: (socket, msg) => { sent.push({ socket, msg }); },
    getChannelAudience: async () => audience,
    publishToChannel: async (serverId, channelId, msg, userIds) => {
      published.push({ serverId, channelId, msg, audience: userIds });
    },
  };
  const conn = { userId: 'alice', servers: new Set(['server']) };
  return {
    deps, conn, sent, published, lookedUp,
    limit: () => { limited = true; },
    setPeer: (value: string | null) => { peer = value; },
    block: () => { blocked = true; },
    unblock: () => { blocked = false; },
    setAudience: (value: typeof audience) => { audience = value; },
    setShown: (value: boolean | undefined) => { shown = value; },
    shownChecks,
  };
}

async function remoteTypingScenario(relay = relayTyping) {
  const f = fixture();
  const remote: unknown[][] = [];
  f.deps.remoteTyping = (...args) => { remote.push(args); };
  f.deps.connsOf = () => [];
  for (const action of [undefined, 'typing', 'unknown', 'voice_upload', 'round']) {
    await relay(f.deps, f.conn, { dmId: 'dm', action });
  }
  assert.deepEqual(remote, [
    ['dm', 'alice', 'bob', 'typing'], ['dm', 'alice', 'bob', 'typing'], ['dm', 'alice', 'bob', 'typing'],
    ['dm', 'alice', 'bob', 'voice_upload'], ['dm', 'alice', 'bob', 'round'],
  ], 'удалённый набор получает нормализованное действие');
  assert.equal(f.sent.length, 0);
  remote.length = 0;
  f.deps.connsOf = () => [{ socket: 'bob-pc' }];
  await relay(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
  assert.equal(remote.length, 0, 'живой местный сокет исключает удалённую пересылку');
  assert.equal(f.sent.length, 1);
}

it('R197 удалённый набор уходит только без сокетов и сохраняет обычное typing без поля action', async () => {
  await remoteTypingScenario();
});

it('R197 удалённая пересылка до проверки сокетов поймана на парной местной доставке', async () => {
  const original = readFileSync(new URL('./gatewayTyping.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const from = "if (conns.length === 0 || deps.isRemote?.(route.peerId)) {\n      deps.remoteTyping?.(route.dmId, uid, route.peerId, extra.action ?? 'typing');";
  assert.equal(original.split(from).length, 2, 'уникальный якорь remoteTyping');
  const mutated = original.replace(from, "deps.remoteTyping?.(route.dmId, uid, route.peerId, extra.action ?? 'typing');\n    if (conns.length === 0) {");
  const load = (source: string) => {
    const module = { exports: {} as typeof import('./gatewayTyping.js') };
    const deps: Record<string, unknown> = {
      '@gusvoice/shared': { parseTypingAction, typingActionField, typingActionFor },
      './blockRules.js': { reachesPeer }, './gatewayRules.js': { typingRoute },
    };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `явный импорт ${id}`); return deps[id]; },
    });
    return module.exports.relayTyping;
  };
  await remoteTypingScenario(load(original));
  await assert.rejects(remoteTypingScenario(load(mutated)), e => e instanceof assert.AssertionError && e.message.includes('живой местный сокет исключает'));
});

async function guestTypingScenario(relay = relayTyping) {
  const f = fixture(); const remote: unknown[][] = [];
  f.deps.remoteTyping = (...args) => { remote.push(args); };
  f.deps.isRemote = id => id === 'bob';
  await relay(f.deps, f.conn, { dmId: 'dm', action: 'round' });
  assert.equal(f.sent.length, 0, 'гостевые сокеты тени не заменяют дом при наборе в ЛС');
  assert.deepEqual(remote, [['dm', 'alice', 'bob', 'round']]);
  f.deps.isRemote = () => false; remote.length = 0;
  await relay(f.deps, f.conn, { dmId: 'dm', action: 'voice' });
  assert.equal(f.sent.length, 2); assert.deepEqual(remote, []);
}
it('R201 набор тени с гостевыми сокетами всё равно уходит дому, местный собеседник получает обычную доставку', async () => {
  await guestTypingScenario();
});
it('R201 мутант без isRemote ловится утечкой набора в гостевые сокеты', async () => {
  const original = readFileSync(new URL('./gatewayTyping.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const from = 'if (conns.length === 0 || deps.isRemote?.(route.peerId))'; assert.equal(original.split(from).length, 2);
  const load = (code: string) => {
    const module = { exports: {} as typeof import('./gatewayTyping.js') };
    const deps: Record<string, unknown> = { '@gusvoice/shared': { parseTypingAction, typingActionField, typingActionFor }, './blockRules.js': { reachesPeer }, './gatewayRules.js': { typingRoute } };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id)); return deps[id]; },
    });
    return module.exports.relayTyping;
  };
  await guestTypingScenario(load(original));
  await assert.rejects(guestTypingScenario(load(original.replace(from, 'if (conns.length === 0)'))), e => e instanceof assert.AssertionError && e.message.includes('гостевые сокеты тени'));
});

it('кружок в ЛС и группе выбирает action отдельно для каждого устройства, канал не понижает вид', async () => {
  const source = readFileSync(new URL('./gatewayTyping.ts', import.meta.url), 'utf8');
  const load = (code: string) => {
    const module = { exports: {} as typeof import('./gatewayTyping.js') };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      module, exports: module.exports,
      require(id: string) {
        if (id === '@gusvoice/shared') return { parseTypingAction, typingActionField, typingActionFor };
        if (id === './blockRules.js') return { reachesPeer };
        if (id === './gatewayRules.js') return { typingRoute };
        throw new Error(id);
      },
    });
    return module.exports.relayTyping;
  };
  const check = async (relay: typeof relayTyping) => {
    for (const group of [false, true]) {
      const f = fixture();
      f.deps.connsOf = id => [{ socket: id + '-new', caps: new Set(['typing2']) }, { socket: id + '-old', caps: new Set(['typing1']) }, { socket: id + '-legacy' }];
      if (group) { f.setPeer(null); f.deps.groupPeersOf = async () => ['bob', 'carol']; f.deps.isBlockedBy = async () => false; }
      await relay(f.deps, f.conn, { dmId: 'dm', action: 'round' });
      assert.equal(f.sent.length, group ? 6 : 3);
      assert.deepEqual(f.sent.map(({ msg }) => (msg as { action: string }).action), group ? ['round', 'voice', 'voice', 'round', 'voice', 'voice'] : ['round', 'voice', 'voice']);
    }
    const f = fixture();
    await relay(f.deps, f.conn, { serverId: 'server', channelId: 'ch', action: 'round' });
    assert.equal((f.published[0].msg as { action: string }).action, 'round');
  };
  await check(relayTyping);
  await check(load(source));
  for (const replacement of ['undefined', "new Set(['typing2'])"]) {
    const mutated = source.replaceAll('extraFor(c.caps)', `extraFor(${replacement})`);
    assert.notEqual(mutated, source);
    await assert.rejects(check(load(mutated)), assert.AssertionError);
  }
});

it('группа доставляет выбор стикера всем устройствам участников в сети, кроме заблокировавших', async () => {
  // Ловит одноадресную доставку группы и раскрытие набора заблокировавшему участнику.
  const f = fixture(); const checks: string[] = [];
  f.deps.dmPeerOf = async () => null;
  f.deps.groupPeersOf = async (id, sender) => { assert.equal(id,'group'); assert.equal(sender,'alice'); return ['bob','carol','offline']; };
  f.deps.connsOf = id => id==='offline' ? [] : [{socket:id+'-phone'},{socket:id+'-pc'}];
  f.deps.isBlockedBy = async (blocker,sender) => { assert.equal(sender,'alice'); checks.push(blocker); return blocker==='carol'; };
  await relayTyping(f.deps,f.conn,{dmId:'group',action:'sticker'});
  assert.deepEqual(checks,['bob','carol']);
  assert.deepEqual(f.sent.map(s=>s.socket),['bob-phone','bob-pc']);
  assert.ok(f.sent.every(s=>(s.msg as {action:string}).action==='sticker'));
  f.sent.length=0; f.deps.groupPeersOf=async()=>null;
  await relayTyping(f.deps,f.conn,{dmId:'foreign',action:'sticker'});
  assert.deepEqual(f.sent,[]);
});

describe('доставка события «печатает»', () => {
  it('без соединений получателя не проверяет блокировки и скрытие, voice_upload доставляется без подмены', async () => {
    // Бесполезные запросы к базе не должны выполняться на каждый набор офлайн-пользователю.
    const f = fixture();
    f.deps.connsOf = () => [];
    f.deps.isBlockedBy = async () => { assert.fail('офлайн не требует проверки блока'); };
    f.deps.shownTo = async () => { assert.fail('офлайн не требует проверки видимости'); };
    await relayTyping(f.deps, f.conn, { dmId: 'dm', action: 'voice_upload' });
    assert.equal(f.sent.length, 0);
    const online = fixture();
    await relayTyping(online.deps, online.conn, { dmId: 'dm', action: 'voice_upload' });
    assert.equal(online.sent.length, 2);
    assert.ok(online.sent.every((s) => (s.msg as { action: string }).action === 'voice_upload'));
  });
  it('исчерпанный лимит прекращает обработку до чтения беседы', async () => {
    // Ловит обход rate-limit через частые эфемерные кадры.
    const f = fixture();
    f.limit();
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.deepEqual(f.lookedUp, []);
    assert.deepEqual(f.sent, []);
  });

  it('чужая беседа не выдаёт событие никакому соединению', async () => {
    // Ловит подмену dmId для слежения за набором в чужой личной беседе.
    const f = fixture();
    f.setPeer(null);
    await relayTyping(f.deps, f.conn, { dmId: 'foreign' });
    assert.deepEqual(f.lookedUp, ['foreign:alice']);
    assert.deepEqual(f.sent, []);
  });

  it('присланный recipientId игнорируется, а заблокировавшему набор не доходит', async () => {
    // Ловит подмену адресата клиентом и прежнюю инверсию признака блокировки.
    const f = fixture();
    f.block();
    const spoofed = { dmId: 'dm', recipientId: 'mallory' };
    await relayTyping(f.deps, f.conn, spoofed);
    assert.deepEqual(f.sent, []);
  });

  it('обычный набор доходит каждому устройству настоящего собеседника, но не автору', async () => {
    // Ловит потерю одного из устройств собеседника или отражение своего набора отправителю.
    const f = fixture();
    const spoofed = { dmId: 'dm', recipientId: 'mallory' };
    await relayTyping(f.deps, f.conn, spoofed);
    assert.deepEqual(f.sent, [
      { socket: 'bob-phone', msg: { t: 'typing', dmId: 'dm', userId: 'alice' } },
      { socket: 'bob-desktop', msg: { t: 'typing', dmId: 'dm', userId: 'alice' } },
    ]);
  });

  it('скрытая пустая беседа не раскрывается набором, а показанная доходит адресату', async () => {
    // Ловит утечку существования ещё не раскрытой беседы и ложный отказ для уже видимой.
    const f = fixture();
    f.setShown(false);
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.deepEqual(f.sent, []);
    f.setShown(true);
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.shownChecks, ['dm:bob', 'dm:bob']);
  });

  it('блокировка останавливает проверку видимости, а старые зависимости без неё сохраняют доставку', async () => {
    // Ловит вызов visibility для уже запрещённого адресата и несовместимость шлюза до появления shownTo.
    const f = fixture();
    f.block();
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.deepEqual(f.shownChecks, []);
    assert.deepEqual(f.sent, []);
    f.deps.shownTo = undefined;
    f.unblock();
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.equal(f.sent.length, 2);
  });

  it('канал без подписки или подходящей аудитории молчит', async () => {
    // Ловит рассылку в чужой сервер, несуществующий канал и канал, который автор сам не видит.
    const f = fixture();
    await relayTyping(f.deps, f.conn, { serverId: 'foreign', channelId: 'ch' });
    f.setAudience(null);
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    f.setAudience({ serverId: 'foreign', userIds: ['alice', 'bob'] });
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    f.setAudience({ serverId: 'server', userIds: ['bob'] });
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    assert.deepEqual(f.published, []);
  });

  it('канал получает только зрителей без автора', async () => {
    // Ловит эхо собственного набора и утечку события за границу видимости канала.
    const f = fixture();
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    assert.deepEqual(f.published, [{
      serverId: 'server', channelId: 'ch', msg: { t: 'typing', channelId: 'ch', userId: 'alice' }, audience: ['bob'],
    }]);
  });

  it('пересылает только известный action и сохраняет обратную совместимость в ЛС и канале', async () => {
    // Старые peers игнорируют неизвестное поле, а канал и ЛС обязаны одинаково сохранить каждый новый вид сигнала.
    for (const action of ['voice', 'photo', 'video', 'file'] as const) {
      const dm = fixture();
      await relayTyping(dm.deps, dm.conn, { dmId: 'dm', action });
      assert.equal((dm.sent[0]?.msg as { action?: string } | undefined)?.action, action, `ЛС передаёт ${action}`);

      const channel = fixture();
      await relayTyping(channel.deps, channel.conn, { serverId: 'server', channelId: 'ch', action });
      assert.equal((channel.published[0]?.msg as { action?: string } | undefined)?.action, action, `канал передаёт ${action}`);
    }
    for (const action of [undefined, 'typing', 'unexpected', '__proto__']) {
      const f = fixture();
      await relayTyping(f.deps, f.conn, { dmId: 'dm', action });
      assert.ok(f.sent.every(({ msg }) => !Object.hasOwn(msg as object, 'action')), `ЛС опускает ${String(action)}`);
      const c = fixture();
      await relayTyping(c.deps, c.conn, { serverId: 'server', channelId: 'ch', action });
      assert.ok(c.published.every(({ msg }) => !Object.hasOwn(msg as object, 'action')), `канал опускает ${String(action)}`);
    }
  });

  it('реальный шлюзовый тест ловит передачу неизвестного, явного typing и потерю channel extra', async () => {
    // Эти три мелкие регрессии либо ломают старые клиенты, либо теряют новые типы в одном из маршрутов.
    const source = readFileSync(fileURLToPath(new URL('./gatewayTyping.ts', import.meta.url)), 'utf8');
    const load = (code: string) => {
      const module = { exports: {} as Record<string, unknown> };
      runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module, exports: module.exports,
        require(id: string) {
          if (id === '@gusvoice/shared') return { parseTypingAction, typingActionField };
          if (id === './blockRules.js') return { reachesPeer };
          if (id === './gatewayRules.js') return { typingRoute };
          throw new Error(`unexpected gatewayTyping dependency ${id}`);
        },
      });
      return module.exports as typeof import('./gatewayTyping.js');
    };
    const assertMutantRejected = async (code: string, input: { dmId?: string; serverId?: string; channelId?: string; action?: unknown }, expected: (f: ReturnType<typeof fixture>) => void, message: string) => {
      const mutant = load(code);
      const f = fixture();
      await mutant.relayTyping(f.deps, f.conn, input);
      assert.throws(() => expected(f), assert.AssertionError, message);
    };

    const rawAction = source.replace('const extra = typingActionField(parseTypingAction(msg.action));', 'const extra = { action: msg.action as any };');
    assert.notEqual(rawAction, source, 'мутация заменяет валидацию сырым полем');
    await assertMutantRejected(rawAction, { dmId: 'dm', action: '__proto__' }, (f) => assert.ok(f.sent.every(({ msg }) => !Object.hasOwn(msg as object, 'action')), 'неизвестное поле должно отбрасываться'), 'сырой action нарушает whitelist');

    const explicitTyping = source.replace('const extra = typingActionField(parseTypingAction(msg.action));', "const extra = { action: 'typing' as const };");
    assert.notEqual(explicitTyping, source, 'мутация пишет legacy typing как явное поле');
    await assertMutantRejected(explicitTyping, { dmId: 'dm', action: 'typing' }, (f) => assert.ok(f.sent.every(({ msg }) => !Object.hasOwn(msg as object, 'action')), 'обычный typing должен опускать поле'), 'явный typing нарушает совместимость');

    const channelDropsExtra = source.replace("{ t: 'typing', channelId: route.channelId, userId: uid, ...extra }", "{ t: 'typing', channelId: route.channelId, userId: uid }");
    assert.notEqual(channelDropsExtra, source, 'мутация теряет дополнительное поле только в канале');
    await assertMutantRejected(channelDropsExtra, { serverId: 'server', channelId: 'ch', action: 'video' }, (f) => assert.equal((f.published[0]?.msg as { action?: string } | undefined)?.action, 'video', 'видео-сигнал должен пройти в канал'), 'потеря extra нарушает channel wire contract');
  });
});
