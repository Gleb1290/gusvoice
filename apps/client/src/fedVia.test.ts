import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ConvMessage, DmChannel } from '@gusvoice/shared';
import type { FedViaHooks } from './convStore';
import * as rules from './fedViaRules';
import * as sync from './convSyncRules';

const source = readFileSync(new URL('./fedVia.ts', import.meta.url), 'utf8');
const startAt = 1_760_000_000_000;
const creds: rules.ViaCreds = { instanceId: 'neighbor', apiBase: 'https://neighbor.test/api', userId: 'shadow', token: 'fixture-session', expiresAt: startAt + 8 * 24 * 60 * 60 * 1000 };
const dm = { id: 'c', otherUser: { id: 'peer', homeInstance: { instanceId: 'neighbor', name: 'Сосед', domain: 'neighbor.test' } } } as DmChannel;
const responseMessage = { id: 'msg', conversationId: 'c', clientId: 'client' } as ConvMessage;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Options = { stored?: boolean; fallbackError?: number | 'network'; reportError?: number; sendError?: number; raw?: string; sendMessage?: ConvMessage; historyMessage?: ConvMessage; initialState?: Record<string, unknown> };
function fixture(options: Options = {}) {
  let now = startAt, live = true;
  let state: Record<string, any> = { user: { id: 'me' }, currentDmId: null, dms: [dm], serverFeatures: ['fedm5'], conv: { summaries: {} },
    fedVia: { down: false, self: '', ready: [] }, convViaRefresh: (id: string) => polls.push(id), ...options.initialState };
  const polls: string[] = [];
  const fallbackCalls: string[] = []; const reports: Array<Array<{ clientId: string; payloadHash: string }>> = [];
  const viaBodies: Array<Record<string, any>> = []; const probes: string[] = [];
  const subscriptions: Array<(next: typeof state, previous: typeof state) => void> = [];
  const connListeners: Array<(state: string) => void> = [];
  const storage = new Map<string, string>();
  if (options.stored) storage.set('gv_fedvia', JSON.stringify({ home: { c: creds }, other: { keep: creds } }));
  let hooks: FedViaHooks | undefined;
  const timers = new Map<number, { at: number; fn: () => void; interval?: number }>(); let nextTimer = 0;
  const arm = (fn: () => void, ms: number, interval = false) => {
    const id = ++nextTimer; timers.set(id, { at: now + ms, fn, ...(interval ? { interval: ms } : {}) }); return id;
  };
  const change = (patch: Record<string, unknown>) => {
    const previous = state; state = { ...state, ...patch }; for (const fn of subscriptions) fn(state, previous);
  };
  const deps: Record<string, unknown> = {
    './api': { api: { convFallback: async (id: string) => {
      fallbackCalls.push(id);
      if (options.fallbackError) throw options.fallbackError === 'network' ? new TypeError('фиктивная сеть') : Object.assign(new Error('фиктивный отказ'), { status: options.fallbackError });
      return creds;
    }, convViaClaims: async (items: Array<{ clientId: string; payloadHash: string }>) => {
      reports.push(items.map(row => ({ ...row })));
      if (options.reportError) throw Object.assign(new Error('фиктивный отказ отчёта'), { status: options.reportError });
    } }, apiVia: (c: rules.ViaCreds) => {
      assert.equal(c.token, creds.token, 'используется фиктивная сессия собеседника');
      return { convSend: async (_id: string, body: Record<string, any>) => {
        viaBodies.push(body); if (options.sendError) throw Object.assign(new Error('фиктивный отказ сессии'), { status: options.sendError });
        return options.sendMessage ?? responseMessage;
      }, convHistory: async () => ({ messages: [options.historyMessage ?? responseMessage] }) };
    } },
    './config': { activeInstanceId: () => 'home', activeInstance: () => ({ name: ' Дом ', domain: 'home.test' }), config: { apiUrl: 'https://home.test/api' } },
    './connState': { gatewayLiveNow: () => live, onConnChange: (fn: (state: string) => void) => { connListeners.push(fn); } },
    './convStore': { bindFedVia: (h: FedViaHooks) => { hooks = h; } }, './convSyncRules': sync, './fedViaRules': rules,
    './store': { useStore: { getState: () => state, setState: change, subscribe: (fn: (next: typeof state, previous: typeof state) => void) => { subscriptions.push(fn); } } },
  };
  const module = { exports: {} };
  class Clock extends Date { static now() { return now; } }
  runInNewContext(ts.transpileModule(options.raw ?? source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Date: Clock, navigator: { onLine: true },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      setTimeout: (fn: () => void, ms: number) => arm(fn, ms), clearTimeout: (id: number) => timers.delete(id),
      setInterval: (fn: () => void, ms: number) => arm(fn, ms, true), clearInterval: (id: number) => timers.delete(id),
      fetch: async (url: string) => { probes.push(url); return { status: 503 }; },
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `граница fedVia ${id}`); return deps[id]; } });
  const api = module.exports as typeof import('./fedVia');
  const advance = async (ms: number) => {
    now += ms;
    for (let turns = 0; turns < 30; turns++) {
      const ready = [...timers].filter(([, timer]) => timer.at <= now);
      if (!ready.length) return;
      for (const [id, timer] of ready) {
        if (!timers.has(id)) continue;
        if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
        timer.fn();
      }
      await flush();
    }
    assert.fail('фиктивные таймеры не должны зациклиться');
  };
  return { api, change, advance, storage, fallbackCalls, reports, viaBodies, polls, probes, state: () => state,
    hooks: () => { assert.ok(hooks, 'startFedVia связал крючки отправки'); return hooks; },
    connect: async (next: string) => { live = next === 'online'; for (const fn of connListeners) fn(next); await flush(); },
    timers: () => [...timers.values()].map(timer => timer.interval ?? timer.at - now),
  };
}
it('R200 fedVia на открытии 1:1 берёт fallback, публикует готовность и не повторяет обновление живой сессии', async () => {
  const f = fixture(); f.api.startFedVia(); f.api.startFedVia(); f.change({ currentDmId: 'c' }); await flush();
  assert.equal(f.fallbackCalls.join(','), 'c'); assert.equal(f.state().fedVia.ready.join(','), 'c'); assert.equal(f.state().fedVia.self, 'Дом');
  f.change({ dms: [...f.state().dms] }); await flush(); assert.equal(f.fallbackCalls.length, 1);
  assert.equal(f.hooks().canTry('c'), true); assert.equal(f.hooks().active('c'), false);
});
it('R200 fedVia не берёт fallback местному, группе, Избранному, broken и серверу без fedm5', async () => {
  for (const patch of [{ dms: [{ ...dm, otherUser: { id: 'local' } }] }, { dms: [{ ...dm, group: {} }] },
    { dms: [{ ...dm, saved: true }] }, { conv: { summaries: { c: { fedLink: 'broken' } } } }, { serverFeatures: [] }]) {
    const f = fixture(); f.api.startFedVia(); f.change({ ...patch, currentDmId: 'c' }); await flush();
    assert.equal(f.fallbackCalls.length, 0);
  }
});
it('R200 ошибки fallback молчат, повтор на открытии не происходит раньше десяти минут', async () => {
  for (const fallbackError of [404, 409, 503, 'network'] as const) {
    const f = fixture({ fallbackError }); f.api.startFedVia(); f.change({ currentDmId: 'c' }); await flush();
    assert.equal(f.fallbackCalls.length, 1); assert.equal(f.state().fedVia.ready.length, 0);
    f.change({ dms: [...f.state().dms] }); await flush(); assert.equal(f.fallbackCalls.length, 1);
    await f.advance(rules.VIA_RETRY_MS - 1); f.change({ dms: [...f.state().dms] }); await flush(); assert.equal(f.fallbackCalls.length, 1);
    await f.advance(1); f.change({ dms: [...f.state().dms] }); await flush(); assert.equal(f.fallbackCalls.length, 2);
  }
});
async function downThenUp(options: Options = {}) {
  const f = fixture({ ...options, stored: true }); f.api.startFedVia(); f.change({ currentDmId: 'c' }); await flush();
  await f.connect('connecting'); await f.advance(rules.HOME_LOST_GRACE_MS - 1);
  assert.equal(f.probes.length, 0, 'короткий обрыв шлюза не запускает пробу');
  await f.advance(1); assert.equal(f.probes.length, 1); assert.equal(f.state().fedVia.down, false, 'одного отказа пробы мало');
  await f.advance(rules.HOME_PROBE_MS); assert.equal(f.state().fedVia.down, true, 'две неудачные пробы включают обход');
  assert.equal(f.hooks().active('c'), true); assert.equal(f.polls.includes('c'), true);
  await f.connect('online'); assert.equal(f.state().fedVia.down, false); assert.equal(f.hooks().active('c'), false);
  return f;
}
it('R200 после двух неудачных проб и возвращения шлюза дом получает даже пустой отчёт', async () => {
  const f = await downThenUp();
  assert.equal(f.reports.length, 1, 'дом получает отчёт после обходного периода'); assert.equal(f.reports[0].length, 0, 'пустая очередь тоже отчёт');
  assert.equal(f.timers().includes(6_000), false, 'опрос чужой истории прекращён');
});
it('R200 отчёт с окончательным 4xx не повторяется, 408 429 и 5xx повторяются через пятнадцать секунд', async () => {
  for (const reportError of [400, 403, 404, 408, 429, 500]) {
    const f = await downThenUp({ reportError }); assert.equal(f.reports.length, 1);
    await f.advance(15_000); assert.equal(f.reports.length, [408, 429, 500].includes(reportError) ? 2 : 1, 'повтор только временного отказа отчёта');
  }
});
it('R200 отправка через сессию пишет отпечаток текста и ответа, история читается через того же соседа', async () => {
  const f = fixture({ stored: true }); f.api.startFedVia();
  const result = await f.hooks().send('c', { clientId: 'client', content: '  текст  ', replyToId: 'parent', silent: true, noPreview: true }, 20_000);
  assert.equal(result, responseMessage); assert.equal(f.viaBodies.length, 1); assert.equal(f.viaBodies[0].attachments.length, 0);
  const claims = JSON.parse(f.storage.get('gv_fedvia_claims')!);
  assert.equal(claims.length, 1); assert.equal(claims[0].home, 'home'); assert.equal(claims[0].clientId, 'client');
  assert.equal(claims[0].payloadHash, rules.viaPayloadHash('c', 'текст', 'parent'));
  const history = await f.hooks().history('c'); assert.equal(history[0], responseMessage);
});
it('R200 выход стирает лишь соседние сессии данного дома, очередь отчёта и другой дом сохраняются', async () => {
  const f = fixture({ stored: true }); f.api.startFedVia(); await f.hooks().send('c', { clientId: 'client', content: 'текст', replyToId: null }, 1);
  const claims = f.storage.get('gv_fedvia_claims'); f.change({ user: null }); await flush();
  const stored = JSON.parse(f.storage.get('gv_fedvia')!);
  assert.equal(Object.hasOwn(stored, 'home'), false); assert.equal(Object.hasOwn(stored, 'other'), true);
  assert.equal(f.storage.get('gv_fedvia_claims'), claims); assert.equal(f.hooks().canTry('c'), false);
});
it('R200 401 соседа забывает мёртвую сессию без строки отчёта, обычный отказ 403 не стирает её', async () => {
  for (const sendError of [401, 403]) {
    const f = fixture({ stored: true, sendError }); f.api.startFedVia();
    await assert.rejects(f.hooks().send('c', { clientId: 'client', content: 'текст', replyToId: null }, 1),
      e => e instanceof Error && (e as Error & { status: number }).status === sendError);
    assert.equal(f.hooks().canTry('c'), sendError !== 401); assert.equal(f.storage.has('gv_fedvia_claims'), false);
  }
});
it('R200 мутант без owed теряет обязательный пустой отчёт после лежавшего дома', async () => {
  const original = await downThenUp(); assert.equal(original.reports.length, 1);
  const anchor = 'if (items.length === 0 && !owed) return;'; assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь пустого отчёта');
  const f = await downThenUp({ raw: source.replace(anchor, 'if (items.length === 0) return;') });
  assert.throws(() => assert.equal(f.reports.length, 1, 'дом получает отчёт после обходного периода'),
    e => e instanceof assert.AssertionError && e.message.includes('дом получает отчёт'));
});
const ownViaMessage = { id: 'own-via', conversationId: 'c', author: { id: 'shadow', displayName: 'Местный' }, content: 'моё сообщение', extra: { kept: true } } as unknown as ConvMessage & { extra: { kept: boolean } };
const peerViaMessage = { id: 'peer-via', conversationId: 'c', author: { id: 'neighbor-peer', displayName: 'Сосед' }, content: 'ответ соседа' } as unknown as ConvMessage;
async function sendAndHistory(raw?: string) {
  const f = fixture({ stored: true, raw, sendMessage: ownViaMessage, historyMessage: peerViaMessage }); f.api.startFedVia();
  const sent = await f.hooks().send('c', { clientId: 'client', content: 'текст', replyToId: null }, 20_000);
  const history = await f.hooks().history('c');
  return { sent, history };
}
it('R204 fedVia переводит автора send в свой id, а автора history — в id собеседника из dms', async () => {
  const { sent, history } = await sendAndHistory();
  assert.equal(sent.author?.id, 'me', 'собственная отправка через теневую сессию должна встать справа');
  assert.equal(history[0].author?.id, 'peer', 'сообщение собеседника должно остаться за его строкой у нас');
  assert.equal(sent.content, ownViaMessage.content); assert.equal((sent as typeof ownViaMessage).extra, ownViaMessage.extra);
  assert.equal(ownViaMessage.author?.id, 'shadow', 'объект ответа соседа не меняется');
  assert.equal(peerViaMessage.author?.id, 'neighbor-peer', 'объект истории соседа не меняется');
});
it('R204 удаление localize из history ловится по автору первой исходной строки', async () => {
  const original = await sendAndHistory();
  assert.equal(original.sent.author?.id, 'me', 'исходная send проходит через локализацию');
  assert.equal(original.history[0].author?.id, 'peer', 'исходная history проходит через локализацию');
  const anchor = 'return (await apiVia(c).convHistory(convId, { limit: 40 })).messages.map((m) => localize(convId, c.userId, m));';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь локализации истории');
  const mutant = await sendAndHistory(source.replace(anchor, 'return (await apiVia(c).convHistory(convId, { limit: 40 })).messages;'));
  assert.equal(mutant.sent.author?.id, 'me', 'удаление локализации history не должно ломать send');
  assert.throws(() => assert.equal(mutant.history[0].author?.id, 'peer', 'сообщение собеседника должно остаться за его строкой у нас'),
    e => e instanceof assert.AssertionError && e.message.includes('сообщение собеседника должно остаться за его строкой у нас'));
});

const groupDm = { ...dm, otherUser: { id: 'group-placeholder', displayName: 'Группа' },
  group: { title: 'Группа', avatarUrl: null, ownerId: 'me', limit: 5,
    members: [{ id: 'me', displayName: 'Местный' }, { id: 'group-peer', displayName: 'Сосед' }] } } as unknown as DmChannel;
async function groupFallback(raw = source) {
  for (const foreign of [true, false]) {
    const f = fixture({ raw, initialState: { dms: [groupDm], conv: { summaries: foreign ? { c: { fedGroupHost: { instanceId: 'neighbor' } } } : {} } } });
    f.api.startFedVia(); f.change({ currentDmId: 'c' }); await flush();
    assert.equal(f.fallbackCalls.length, foreign ? 1 : 0, 'сессия нужна только группе чужого хоста');
  }
  const f = fixture({ raw, initialState: { dms: [{ ...groupDm, saved: true }], conv: { summaries: { c: { fedGroupHost: { instanceId: 'neighbor' } } } } } });
  f.api.startFedVia(); f.change({ currentDmId: 'c' }); await flush();
  assert.equal(f.fallbackCalls.length, 0, 'Избранное не заводит обходную сессию');
}
// В собственной группе нет чужого хоста для fallback; наличие group само по себе не открывает обход.
it('R208 fedVia берёт сессию группе с fedGroupHost, не своей группе и не Избранному', async () => { await groupFallback(); });
async function groupHistory(raw = source) {
  const f = fixture({ raw, stored: true, sendMessage: ownViaMessage, historyMessage: peerViaMessage, initialState: { dms: [groupDm] } });
  f.api.startFedVia();
  const sent = await f.hooks().send('c', { clientId: 'group-client', content: 'Текст', replyToId: null }, 20_000);
  const history = await f.hooks().history('c');
  assert.equal(sent.author?.id, 'me', 'send группы переводит мою тень в свой id');
  assert.equal(history[0].author?.id, 'group-peer', 'history группы выбирает участника, а не заглушку собеседника');
  assert.equal(history[0].content, peerViaMessage.content); assert.equal(peerViaMessage.author.id, 'neighbor-peer');
}
// Настоящие send/history должны выбрать групповое правило, а не правило одного собеседника.
it('R208 fedVia применяет групповую локализацию и к send, и к history', async () => { await groupHistory(); });
// Удалённый гейт дома группы ошибочно заводит сессию собственной группе.
it('R208 контрфакт fedVia без проверки fedGroupHost предлагает обход своей группы', async () => {
  await groupFallback(); const anchor = '!!s.conv?.summaries?.[convId]?.fedGroupHost &&';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(groupFallback(source.replace(anchor, '')),
    e => e instanceof assert.AssertionError && e.message.startsWith('сессия нужна только группе чужого хоста') && e.actual === 1 && e.expected === 0);
});
// Замена группы на 1:1 теряет автора ответа, даже если своя отправка выглядит правильно.
it('R208 контрфакт fedVia без group-localize присваивает историю заглушке собеседника', async () => {
  await groupHistory(); const anchor = 'if (dm?.group) return viaLocalizeGroup(m, viaUserId, s.user?.id, dm.group.members);';
  assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(groupHistory(source.replace(anchor, '')),
    e => e instanceof assert.AssertionError && e.message.startsWith('history группы выбирает участника')
      && e.actual === 'group-placeholder' && e.expected === 'group-peer');
});
