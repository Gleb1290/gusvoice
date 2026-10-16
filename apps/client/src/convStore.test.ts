import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ConvMessage, ConvPin, ConvScheduled, ConvSummary, ConvSyncResponse } from '@gusvoice/shared';
import { createConvActions, type ConvDeps, type ConvHost, type FedViaHooks } from './convStore';
import * as channelRules from './channelRules';
import * as convRules from './convSyncRules';
import * as cacheRules from './convCacheRules';
import * as outgoingRules from './outgoingRules';
import * as outboxRules from './outboxRules';
import * as feedRules from './feedWindowRules';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const viaStoreSource = readFileSync(new URL('./convStore.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function loadViaStore(raw = viaStoreSource): Pick<typeof import('./convStore'), 'createConvActions' | 'bindFedVia'> {
  const module = { exports: {} };
  const deps: Record<string, unknown> = { './channelRules': channelRules, './convSyncRules': convRules,
    './convCacheRules': cacheRules, './outgoingRules': outgoingRules, './outboxRules': outboxRules, './feedWindowRules': feedRules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, AbortController, require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `граница convStore ${id}`); return deps[id]; } });
  return module.exports as Pick<typeof import('./convStore'), 'createConvActions' | 'bindFedVia'>;
}
async function viaSending(options: { status?: number; network?: boolean; active?: boolean; offline?: boolean; canTry?: boolean;
  limited?: 'file' | 'quote' | 'asFile' | 'spoiler' | 'caption'; bound?: boolean }, raw = viaStoreSource) {
  const module = loadViaStore(raw); const trace: string[] = [];
  let viaBody: Parameters<FedViaHooks['send']>[1] | undefined;
  const hooks: FedViaHooks = { active: () => options.active ?? false, canTry: () => options.canTry ?? true,
    homeFailed: () => { trace.push('failed'); }, history: async () => [],
    send: async (id, body) => { trace.push('via'); viaBody = body; return message(body.clientId, id); },
  };
  module.bindFedVia(options.bound === false ? null : hooks);
  const fails = options.network || options.status !== undefined;
  const expectedVia = options.bound !== false && !options.limited &&
    (!!options.active || (!!fails && !options.offline && options.canTry !== false && (options.network || [502, 503, 504].includes(options.status!))));
  const f = fixture({ convSend: async (id, body) => {
    trace.push('home');
    if (fails) throw Object.assign(new Error('сбой дома'), options.status === undefined ? {} : { status: options.status });
    return message(body.clientId, id);
  } }, module.createConvActions, { deviceOffline: () => options.offline ?? false });
  try {
    f.set({ dmMessages: { c: [] } });
    const files = options.limited === 'file' ? [{ name: 'file.txt', type: 'text/plain' }] as File[] : [];
    f.actions.outboxEnqueue('c', { key: 'via-send', content: 'текст', files, replyToId: 'parent', silent: true, noPreview: true,
      ...(options.limited === 'quote' ? { replyQuote: { text: 'кусок', offset: 0 } } : {}),
      ...(options.limited === 'asFile' ? { asFile: true } : {}),
      ...(options.limited === 'spoiler' ? { spoilers: [0] } : {}),
      ...(options.limited === 'caption' ? { captionAbove: true } : {}),
    });
    await settle(); await settle();
    assert.equal(trace.includes('via'), expectedVia, 'обход следует недоступности дома и допустимости строки');
    assert.equal(trace.filter(x => x === 'home').length, options.active && expectedVia ? 0 : 1, 'активный обход не обращается домой');
    assert.equal(trace.includes('failed'), expectedVia && !options.active, 'проба дома только после сетевого провала');
    if (expectedVia) {
      assert.equal(viaBody?.clientId, 'via-send'); assert.equal(viaBody?.content, 'текст'); assert.equal(viaBody?.replyToId, 'parent');
      assert.equal(viaBody?.silent, true); assert.equal(viaBody?.noPreview, true);
      assert.equal(Object.hasOwn(viaBody!, 'attachments'), false, 'в обходном теле нет скрытых файлов');
      assert.equal(f.get().outbox.c?.length ?? 0, 0); assert.equal(f.get().dmMessages.c[0]?.id, 'via-send');
    }
  } finally { module.bindFedVia(null); }
}
it('R200 convStore после сбоя сети и 502–504 отправляет текст через bindFedVia с тем же clientId и ответом', async () => {
  await viaSending({ network: true }); for (const status of [502, 503, 504]) await viaSending({ status });
});
it('R200 convStore не обходит 400 403 500, отсутствие сессии и отключённую сеть устройства', async () => {
  for (const status of [400, 403, 500]) await viaSending({ status });
  await viaSending({ network: true, canTry: false }); await viaSending({ network: true, offline: true });
});
it('R200 convStore активный обход допускает только текст, ограничения файла и цитаты остаются домашними', async () => {
  for (const limited of ['file', 'quote', 'asFile', 'spoiler', 'caption'] as const) await viaSending({ active: true, limited });
});
it('R200 convStore active сразу отправляет соседу, без bindFedVia и в норме сохраняет прежнюю отправку домой', async () => {
  await viaSending({ active: true }); await viaSending({ bound: false }); await viaSending({});
});
for (const [name, anchor, replacement, options, target] of [
  ['обойти отказ дома', '!isHomeDownError(e) || deviceOffline() || !via.canTry(convId)', 'deviceOffline() || !via.canTry(convId)', { status: 403 }, 'обход следует недоступности'],
  ['обойти дом с файлами', '!via || !viaSendable(item)', '!via', { active: true, limited: 'file' as const }, 'обход следует недоступности'],
  ['игнорировать active', 'if (via.active(convId)) return via.send(convId, viaBody, SEND_TIMEOUT_MS);', 'if (false) return via.send(convId, viaBody, SEND_TIMEOUT_MS);', { active: true }, 'обход следует недоступности'],
] as const) it(`R200 convStore мутант «${name}» отвергается реальной очередью`, async () => {
  await viaSending(options); assert.equal(viaStoreSource.split(anchor).length - 1, 1, 'единственный якорь обходной отправки');
  await assert.rejects(viaSending(options, viaStoreSource.replace(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(target));
});

it('очередь отправляет без превью и как файлы в API после загрузки, обычная строка без флагов', async () => {
  // Ловит сохранённый выбор, который забыли перенести из outbox в сетевое тело.
  const f = fixture();
  f.actions.outboxEnqueue('c', { key: 'flags', content: 'https://outside.test/', files: [{ name: 'photo.png', type: 'image/png' }] as File[], replyToId: null, asFile: true, noPreview: true });
  await settle(); await settle();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0]?.body.noPreview, true);
  assert.equal(f.sends[0]?.body.attachments[0]?.asFile, true);
  f.enqueue('normal'); await settle();
  assert.equal(f.sends.length, 2); assert.equal(Object.hasOwn(f.sends[1]!.body, 'noPreview'), false);
});

it('очередь передаёт цитату, спойлеры и подпись сверху в теле отправки', async () => {
  // Ловит тихую потерю настроек между чистой outbox-строкой и фактическим POST.
  const f = fixture();
  f.actions.outboxEnqueue('c', { key: 'rich', content: 'ответ', files: [{ name: 'photo.png', type: 'image/png' }] as File[], replyToId: 'parent',
    replyQuote: { text: 'кусок', offset: 2 }, spoilers: [0], captionAbove: true });
  await settle(); await settle();
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0]?.body.replyQuote, { text: 'кусок', offset: 2 });
  assert.equal(f.sends[0]?.body.captionAbove, true);
  assert.equal(f.sends[0]?.body.attachments?.[0]?.spoiler, true);
  f.enqueue('plain'); await settle();
  assert.equal(Object.hasOwn(f.sends[1]!.body, 'replyQuote'), false);
  assert.equal(Object.hasOwn(f.sends[1]!.body, 'captionAbove'), false);
});

it('чтение и видимый ключ снимают ручную пометку до запроса, не оставляя точку на открытой беседе', async () => {
  // Чтение ранее прочитанного сообщения тоже должно убрать ручное «непрочитано».
  for (const seen of [false, true]) {
    const marks: boolean[] = [];
    const f = fixture({ convSetUnreadMark: async (_id, marked) => { marks.push(marked); return { marked }; } }, createConvActions, { readByView: () => true });
    const s = { ...summary('c'), markedUnread: true };
    f.set({ view: 'dm', currentDmId: 'c', dms: convRules.summariesToDms({ c: s }), dmMessages: { c: [message('m', 'c', 10)] }, conv: { ...f.get().conv, summaries: { c: s } } });
    if (seen) f.actions.convSeen('c', 10); else f.actions.convReadNow('c');
    await settle();
    assert.deepEqual(marks, [false]);
    assert.equal(f.get().conv.summaries.c.markedUnread, false);
  }
});

it('увиденное читается пакетом без продления срока, дочитанное до хвоста — сразу и с нулём непрочитанных', async () => {
  // Загруженный хвост раньше считался прочитанным при открытии, а новый callback откладывал пакет бесконечно.
  const check = async (factory: typeof createConvActions) => {
    const reads: number[] = [];
    const f = fixture({ convRead: async (_id, key) => { reads.push(key); return { lastReadKey: key }; } }, factory, { readByView: () => true, windowed: () => true });
    const s = { ...summary('c', 3), lastMessage: { sortKey: 30 } as ConvSummary['lastMessage'] };
    f.set({ view: 'dm', currentDmId: 'c', unreadDms: ['c'], dmMessages: { c: [message('a', 'c', 10), message('b', 'c', 20), message('z', 'c', 30)] }, conv: { ...f.get().conv, summaries: { c: s } } });
    f.actions.convReadNow('c'); await settle(); assert.deepEqual(reads, [], 'до первого увиденного ничего не читается');
    f.actions.convSeen('c', 10);
    await f.advance(1000);
    f.actions.convSeen('c', 20); f.actions.convSeen('c', 20);
    await f.advance(1999); assert.deepEqual(reads, []);
    await f.advance(1); assert.deepEqual(reads, [20], 'повтор не продлил исходные три секунды');
    assert.equal(f.get().conv.summaries.c.unread, 3); assert.deepEqual(f.get().unreadDms, ['c']);
    f.actions.convSeen('c', 30); await settle(); assert.deepEqual(reads, [20, 30]);
    assert.equal(f.get().conv.summaries.c.unread, 0); assert.deepEqual(f.get().unreadDms, []);
  };
  await check(createConvActions);
  await assert.rejects(() => check(mutatedFactory(s => s.replace('const key = clampReadKey(readKeyFor(listOf(s, convId), windowed() ? undefined : summary), seenKeys.get(convId));', 'const key = readKeyFor(listOf(s, convId), windowed() ? undefined : summary);'))), assert.AssertionError);
});

it('увиденное в закрытой ленте не создаёт отметку даже при последующем readNow', async () => {
  // Поздний callback старой ленты не должен прочитать беседу, уже закрытую пользователем.
  const check = async (factory: typeof createConvActions) => {
    const reads: number[] = [];
    const f = fixture({ convRead: async (_id, key) => { reads.push(key); return { lastReadKey: key }; } }, factory, { readByView: () => true });
    f.set({ currentDmId: 'c', view: 'server', dmMessages: { c: [message('x', 'c', 10)] }, conv: { ...f.get().conv, summaries: { c: summary('c', 2) } } });
    f.actions.convSeen('c', 10); await f.advance(3000);
    f.actions.convReadNow('c'); await settle(); assert.deepEqual(reads, []);
  };
  await check(createConvActions);
  await assert.rejects(() => check(mutatedFactory(s => s.replace('if (onScreenId(get()) !== convId) return;', ''))), assert.AssertionError);
});

it('сводка ухода убирает строку и загруженную ленту, следующая новинка возвращает только строку', () => {
  // Удалённый чат иначе оставался читаемым из памяти и не возвращался при новом входящем.
  const f = fixture(); const s = summary('c', 1);
  f.set({ dms: convRules.summariesToDms({ c: s }), dmMessages: { c: [message('old')] }, conv: { ...f.get().conv, summaries: { c: s } } });
  f.actions.convOnChange({ pts: 1, conversation: { id: 'c', left: true } }, true);
  assert.deepEqual(f.get().dms, []); assert.equal(f.get().dmMessages.c, undefined);
  f.actions.convOnChange({ pts: 2, conversation: summary('c', 1) }, true);
  assert.equal(f.get().dms[0].id, 'c'); assert.equal(f.get().dmMessages.c, undefined);
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const summary = (id = 'c', unread = 0): ConvSummary => ({ id, kind: 'direct', createdAt: '2026-01-01T00:00:00Z',
  lastMessageAt: null, lastMessage: null, unread, lastReadKey: 0,
  otherUser: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null } });
const message = (id: string, convId = 'c', sortKey = 1): ConvMessage => ({ id, conversationId: convId, channelId: convId,
  sortKey, clientId: id, content: id, createdAt: '2026-01-01T00:00:00Z', editedAt: null,
  authorId: 'me', author: { id: 'me' }, attachments: [], reactions: [], replyTo: null } as unknown as ConvMessage);
const pin = (id: string): ConvPin => ({
  message: { id, authorId: 'peer', text: id, attachments: 0, sortKey: 1, createdAt: '2026-01-01T00:00:00Z' },
  forBoth: true, pinnedBy: 'peer', pinnedAt: '2026-01-01T00:00:00Z',
} as unknown as ConvPin);
const scheduled = (id: string): ConvScheduled => ({
  id, conversationId: 'c', clientId: `client-${id}`, content: id, replyTo: null, sendAt: '2026-10-06T09:00:00.000Z',
  whenOnline: false, createdAt: '2026-10-05T12:00:00.000Z', editedAt: null,
} as ConvScheduled);
const syncPage = (pts: number): ConvSyncResponse => ({ reset: false, pts, more: false, conversations: [], messages: [] });

function mutatedFactory(change: (s: string) => string): typeof createConvActions {
  const raw = readFileSync(new URL('./convStore.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = ts.transpileModule(change(raw), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps: Record<string, unknown> = { './channelRules': channelRules, './convSyncRules': convRules,
    './convCacheRules': cacheRules, './outgoingRules': outgoingRules, './outboxRules': outboxRules, './feedWindowRules': feedRules };
  const module = { exports: {} as { createConvActions: typeof createConvActions } };
  runInNewContext(code, { module, exports: module.exports, AbortController, require: (id: string) => {
    assert.ok(Object.hasOwn(deps, id), id); return deps[id];
  } });
  return module.exports.createConvActions;
}

type SendBody = Parameters<ConvDeps['api']['convSend']>[1];
function fixture(overrides: Partial<ConvDeps['api']> = {}, factory = createConvActions, extra: Partial<ConvDeps> = {}) {
  let host: ConvHost = { conv: { ...convRules.emptyConvState(), pts: 0, phase: 'live' }, convActive: true,
    dms: [], dmMessages: {}, unreadDms: [], historyFailed: [], currentDmId: null, view: 'server', mobilePane: 'content', outbox: {}, drafts: {} };
  let time = 1000;
  let nextTimer = 0;
  let online = () => {};
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sends: { convId: string; body: SendBody }[] = [];
  const uploads: string[] = [];
  const syncs: number[] = [];
  const histories: string[] = [];
  let listCalls = 0;
  let writes = 0;
  const api: ConvDeps['api'] = {
    convList: async () => { listCalls++; return { pts: 0, conversations: [summary()] }; },
    convSync: async (pts) => { syncs.push(pts); return syncPage(pts); },
    convHistory: async (id) => { histories.push(id); return { pts: 0, messages: [], hasMoreBefore: false, hasMoreAfter: false }; },
    convDirect: async () => summary(),
    convSend: async (id, body) => { sends.push({ convId: id, body }); return message(body.clientId, id); },
    convUpload: async (_id, file) => { uploads.push(file.name); return { id: file.name, url: 'https://file.test', name: file.name, contentType: 'text/plain', size: 1 }; },
    convRead: async () => ({ lastReadKey: 1 }),
    ...overrides,
  };
  const actions = factory((patch) => { writes++; host = { ...host, ...(typeof patch === 'function' ? patch(host) : patch) }; }, () => host, {
    api, now: () => time, setTimeout: (fn, ms) => { timers.set(++nextTimer, { at: time + ms, fn }); return nextTimer; },
    clearTimeout: (id) => { timers.delete(id as number); }, onOnline: (fn) => { online = fn; }, isMobile: () => false, markChannelSeen: () => {},
    ...extra,
  });
  return { actions, api, sends, uploads, syncs, histories, timers, get: () => host, writes: () => writes,
    set: (patch: Partial<ConvHost>) => { host = { ...host, ...patch }; }, listCalls: () => listCalls,
    enqueue: (key: string, id = 'c', files: File[] = []) => actions.outboxEnqueue(id, { key, content: key, files, replyToId: null }),
    online: () => online(), advance: async (ms: number) => {
      time += ms;
      for (const [id, task] of [...timers]) if (task.at <= time) { timers.delete(id); task.fn(); }
      await settle();
    },
  };
}

it('отмена загрузки обрывает сигнал без failed, не отправляет сообщение и пропускает следующую строку', async () => {
  // Отмена первого файла не должна блокировать очередь или выпускать сообщение с частично загруженным вложением.
  let signal: AbortSignal | undefined;
  const calls: string[] = [];
  const f = fixture({ convUpload: (_id, _file, opts) => new Promise((_resolve, reject) => {
    signal = opts?.signal;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { name: 'AbortError' })), { once: true });
  }) }, createConvActions, { uploadProgress: { progress: () => {}, done: () => {}, clear: key => calls.push(key) } });
  f.set({ dmMessages: { c: [] } });
  f.enqueue('cancel-upload', 'c', [{ name: 'file.txt' }] as File[]);
  f.enqueue('next-upload');
  await settle();
  assert.ok(signal, 'настоящая загрузка получила AbortSignal');
  f.actions.outboxDiscard('c', 'cancel-upload');
  await settle();
  assert.equal(signal.aborted, true);
  assert.deepEqual(f.sends.map(x => x.body.clientId), ['next-upload']);
  assert.equal(f.get().outbox.c?.length ?? 0, 0, 'отмена не оставила failed и следующая строка ушла');
  assert.ok(!f.get().dmMessages.c.some(x => x.id === 'cancel-upload'), 'отменённое не появилось в ленте');
  assert.ok(calls.includes('cancel-upload'), 'кольцо отменённой строки очищено');
});

it('отмена летящей отправки удаляет принятый сервером ответ у обоих и не кладёт его в ленту', async () => {
  // Отмена HTTP не отменяет серверную транзакцию: поздний успешный ответ требует явного удаления.
  const check = async (factory: typeof createConvActions) => {
    const pending = deferred<ConvMessage>(); const removed: string[] = [];
    const f = fixture({ convSend: async () => pending.promise,
      convDelete: async (id, mid, mode) => { removed.push(`${id}:${mid}:${mode}`); } }, factory);
    f.set({ dmMessages: { c: [] } });
    f.enqueue('cancel-send'); await settle();
    f.actions.outboxDiscard('c', 'cancel-send');
    pending.resolve(message('accepted-after-cancel'));
    await settle(); await settle();
    assert.equal(removed.join(','), 'c:accepted-after-cancel:both', 'принятое сообщение удаляется у обоих');
    assert.ok(!f.get().dmMessages.c.some(x => x.id === 'accepted-after-cancel'), 'поздний ответ не появляется в ленте');
    assert.equal(f.get().outbox.c?.length ?? 0, 0);
  };
  await check(createConvActions);
  const bad = mutatedFactory(source => {
    const from = 'if (cancelledInFlight.delete(item.key)) {';
    assert.ok(source.includes(from), 'найдена ветка компенсации отменённой отправки');
    return source.replace(from, 'if (false) {');
  });
  await assert.rejects(() => check(bad), assert.AssertionError);
});

describe('применение ответов пачки', () => {
  it('пересылка одной записью сортирует новые, не дублирует повтор и помнит gone', () => {
    // Ловит перерисовку на каждое сообщение, дубль повтора и воскрешение удалённого.
    const f = fixture(); f.set({ conv: { ...f.get().conv, summaries: { c: summary() } }, dmMessages: { c: [message('old', 'c', 1)] } });
    const one = { ...message('one','c',2), createdAt: '2026-10-04T12:00:00Z' };
    const two = { ...message('two','c',3), createdAt: '2026-10-04T12:01:00Z' };
    f.actions.convAfterForward('c', [two, one]);
    assert.equal(f.writes(), 1); assert.deepEqual(f.get().dmMessages.c.map(m => m.id), ['old','one','two']);
    assert.equal(f.get().conv.summaries.c.lastMessageAt, two.createdAt);
    f.actions.convAfterForward('c', [one,two]); assert.equal(f.get().dmMessages.c.length, 3);
    f.actions.convAfterForward('c', [{ id: 'one', conversationId: 'c', gone: true }]);
    assert.equal(f.get().conv.gone.one, true); assert.deepEqual(f.get().dmMessages.c.map(m => m.id), ['old','two']);
  });
  it('закрытая лента не создаётся из пересылки, время сводки не откатывается', () => {
    // Ловит ненужную загрузку закрытой беседы и регресс времени на запоздалом ответе.
    const f = fixture(); f.set({ conv: { ...f.get().conv, summaries: { c: summary() } } });
    const m = { ...message('x'), createdAt: '2026-10-04T12:00:00Z' };
    f.actions.convAfterForward('c', [m]);
    assert.equal(f.get().dmMessages.c, undefined); assert.equal(f.get().conv.summaries.c.lastMessageAt, m.createdAt);
    f.actions.convAfterForward('c', [message('old')]); assert.equal(f.get().conv.summaries.c.lastMessageAt, m.createdAt);
  });
  it('событие пересылки раньше HTTP-ответа не создаёт дубль при применении ответа', () => {
    // Ловит гонку разных путей записи: WS уже доставил, ответ ручки приходит позже.
    const f=fixture(); f.set({ conv:{ ...f.get().conv,summaries:{ c:summary() },windows:{c:{basePts:0,hasMoreBefore:false,hasMoreAfter:false,stale:false}} },dmMessages:{ c:[] } });
    const m=message('forwarded','c',10);
    f.actions.convOnChange({ pts:1,conversation:summary(),message:m,created:true },false);
    assert.deepEqual(f.get().dmMessages.c.map(x=>x.id),[m.id]);
    const writes=f.writes(); f.actions.convAfterForward('c',[m]);
    assert.equal(f.writes(),writes+1); assert.deepEqual(f.get().dmMessages.c.map(x=>x.id),[m.id]);
  });
  it('пакетное удаление пишет один раз и запоминает все исчезнувшие id', () => {
    // Ловит частичное применение пачки и возврат сообщения после догонки.
    const f = fixture(); f.set({ dmMessages: { c: [message('a'), message('b','c',2), message('stay','c',3)] } });
    f.actions.convAfterDeleteMany('c', ['a','b']);
    assert.equal(f.writes(), 1); assert.deepEqual(f.get().dmMessages.c.map(m => m.id), ['stay']);
    assert.equal(f.get().conv.gone.a, true); assert.equal(f.get().conv.gone.b, true);
  });
});

describe('снимки закрепов в сторе', () => {
  // Ответ ручки не должен пересобирать список бесед или менять несвязанные части стора.
  it('convSetPins сохраняет полный ответ ручки только в состоянии закрепов', () => {
    const f = fixture();
    const dms = [{ id: 'c' } as never];
    const messages = { c: [message('message')] };
    const summaries = { c: summary('c') };
    f.set({ dms, dmMessages: messages, conv: { ...f.get().conv, summaries } });
    const before = f.get();
    f.actions.convSetPins('c', { pts: 3, pins: [pin('one'), pin('two')] });
    assert.deepEqual(f.get().conv.pins?.c, { pts: 3, list: [pin('one'), pin('two')] }, 'ответ API заменяет список и сохраняет pts');
    assert.ok(f.get().dms === dms, 'ответ закрепов не пересобирает список бесед');
    assert.ok(f.get().dmMessages === messages, 'ответ закрепов не трогает окна сообщений');
    assert.ok(f.get().conv.summaries === before.conv.summaries, 'ответ закрепов не изменяет сводки');
  });

  // Конкурирующие ответы GET/POST и WS могут прийти не по порядку; UI не должен откатиться на их старый список.
  it('convSetPins игнорирует одинаковый и более старый ответ после свежего события', () => {
    const f = fixture();
    f.actions.convSetPins('c', { pts: 9, pins: [pin('new')] });
    const fresh = f.get().conv;
    f.actions.convSetPins('c', { pts: 9, pins: [pin('echo')] });
    assert.ok(f.get().conv === fresh, 'ответ с тем же pts — эхо и не заменяет свежую запись');
    f.actions.convSetPins('c', { pts: 8, pins: [pin('old')] });
    assert.ok(f.get().conv === fresh, 'запоздавший HTTP-ответ не откатывает состояние');
    assert.deepEqual(f.get().conv.pins?.c.list.map(item => item.message.id), ['new'], 'в сторе остаётся победивший свежий список');
  });

  // Сервер рассылает pins отдельным событием с собственным pts; пустой список — значимое полное удаление.
  it('conv.change.pins применяет полный список и пустой снимок, выход очищает запись', () => {
    const f = fixture();
    f.set({ conv: { ...f.get().conv, summaries: { c: summary('c') }, pins: { c: { pts: 0, list: [pin('old')] } } } });
    f.actions.convOnChange({ pts: 1, conversation: summary('c'), pins: [pin('new')] } as never, false);
    assert.deepEqual(f.get().conv.pins?.c, { pts: 1, list: [pin('new')] }, 'событие заменяет прежний полный список');
    f.actions.convOnChange({ pts: 2, conversation: summary('c'), pins: [] } as never, false);
    assert.deepEqual(f.get().conv.pins?.c, { pts: 2, list: [] }, 'пустой полный список снимает закрепы, а не игнорируется');
    f.actions.convOnChange({ pts: 3, conversation: { id: 'c', left: true }, pins: [pin('must-not-return')] } as never, false);
    assert.ok(f.get().conv.pins?.c === undefined, 'событие ухода не оставляет и не возвращает закрепы беседы');
  });

  // Порции журнала могут дробиться: каждый ответ несёт полный список, а неизвестные беседы не надо кешировать.
  it('syncOnce применяет pins каждой порции только к известным беседам', async () => {
    const f = fixture();
    f.set({ conv: { ...f.get().conv, summaries: { c: summary('c') } } });
    f.api.convSync = async (pts) => {
      f.syncs.push(pts);
      return pts === 0
        ? { ...syncPage(1), more: true, pins: [{ conversationId: 'c', pins: [pin('first')] }, { conversationId: 'unknown', pins: [pin('ignored')] }] }
        : { ...syncPage(2), pins: [{ conversationId: 'c', pins: [pin('latest')] }] };
    };
    await f.actions.convOnReady();
    assert.deepEqual(f.syncs, [0, 1], 'следующая порция запрашивается от pts предыдущей');
    assert.equal(f.get().conv.pts, 2, 'догонка заканчивается на последнем pts журнала');
    assert.deepEqual(f.get().conv.pins?.c, { pts: 2, list: [pin('latest')] }, 'более свежий полный снимок заменяет список первой порции');
    assert.ok(f.get().conv.pins?.unknown === undefined, 'догонка не создаёт закрепы беседы вне текущего списка');
  });
});

describe('снимки отложенных в сторе', () => {
  // Ручки GET/создать/перенести/удалить возвращают полные снимки и не должны менять ленту.
  it('convSetScheduled применяет только расписание и сохраняет свежесть ответа', () => {
    const f = fixture();
    const messages = { c: [message('ordinary')] };
    const dms = [{ id: 'c' } as never];
    f.set({ dmMessages: messages, dms });
    const before = f.get();
    f.actions.convSetScheduled('c', { pts: 4, items: [scheduled('one'), scheduled('two')] });
    assert.deepEqual(f.get().conv.scheduled?.c, { pts: 4, list: [scheduled('one'), scheduled('two')] }, 'ответ ручки целиком попадает в ConvState');
    assert.ok(f.get().dmMessages === messages, 'расписание не мутирует обычные сообщения');
    assert.ok(f.get().dms === dms, 'счётчик/список бесед не пересобирается из ответа scheduled');
    assert.ok(f.get().conv.summaries === before.conv.summaries, 'ответ списка не подменяет сводку');
    const fresh = f.get().conv;
    f.actions.convSetScheduled('c', { pts: 3, items: [scheduled('stale')] });
    assert.ok(f.get().conv === fresh, 'старый ответ не возвращает уже удалённое отложенное');
  });

  // Событие несёт полную замену; даже пустой список должен очистить экран другого устройства.
  it('conv.change.scheduled применяет полный список и выход из беседы его забывает', () => {
    const f = fixture();
    f.set({ conv: { ...f.get().conv, summaries: { c: summary('c') }, scheduled: { c: { pts: 0, list: [scheduled('old')] } } } });
    f.actions.convOnChange({ pts: 1, conversation: summary('c'), scheduled: [scheduled('new')] } as never, false);
    assert.deepEqual(f.get().conv.scheduled?.c, { pts: 1, list: [scheduled('new')] }, 'событие заменяет полный список, а не дописывает его');
    f.actions.convOnChange({ pts: 2, conversation: summary('c'), scheduled: [] } as never, false);
    assert.deepEqual(f.get().conv.scheduled?.c, { pts: 2, list: [] }, 'пустой снимок очищает расписание');
    f.actions.convOnChange({ pts: 3, conversation: { id: 'c', left: true }, scheduled: [scheduled('must-not-return')] } as never, false);
    assert.ok(f.get().conv.scheduled?.c === undefined, 'покинутую беседу нельзя вернуть событием старого расписания');
  });

  // Сервер может разбить журнал на страницы; сохраняем последний снимок и не создаём запись неизвестной беседы.
  it('syncOnce применяет scheduled в каждой порции только для известных бесед', async () => {
    const f = fixture();
    f.set({ conv: { ...f.get().conv, summaries: { c: summary('c') } } });
    f.api.convSync = async (pts) => {
      f.syncs.push(pts);
      return pts === 0
        ? { ...syncPage(1), more: true, scheduled: [{ conversationId: 'c', items: [scheduled('first')] }, { conversationId: 'unknown', items: [scheduled('ignored')] }] }
        : { ...syncPage(2), scheduled: [{ conversationId: 'c', items: [scheduled('latest')] }] };
    };
    await f.actions.convOnReady();
    assert.deepEqual(f.syncs, [0, 1], 'следующая страница запрашивается начиная с предыдущего pts');
    assert.equal(f.get().conv.pts, 2, 'догонка фиксирует последний номер журнала');
    assert.deepEqual(f.get().conv.scheduled?.c, { pts: 2, list: [scheduled('latest')] }, 'последний полный снимок выигрывает');
    assert.ok(f.get().conv.scheduled?.unknown === undefined, 'unknown conversation не получает локальную запись');
  });

  // `silent` — необязательная возможность строки, а не свойство всех обычных сообщений.
  it('в API silent передаётся только для тихой строки очереди', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = fixture({ convSend: async (id, body) => { bodies.push(body as unknown as Record<string, unknown>); return message(body.clientId, id); } });
    f.actions.outboxEnqueue('c', { key: 'regular', content: 'обычно', files: [], replyToId: null });
    f.actions.outboxEnqueue('c', { key: 'quiet', content: 'тихо', files: [], replyToId: null, silent: true });
    await settle();
    await settle();
    assert.deepEqual(bodies.map(body => body.clientId), ['regular', 'quiet'], 'обе строки очереди отправились строго по порядку');
    assert.ok(!Object.hasOwn(bodies[0], 'silent'), 'обычная отправка не получает поле silent=false');
    assert.equal(bodies[1].silent, true, 'тихая строка получает только silent=true');
  });
});

describe('исполняемая очередь исходящих бесед', () => {
  it('две строки одной беседы идут по одной: отсутствие замка проверено контрфактически', async () => {
    // Ловит двойную отправку головы очереди и нарушение порядка при быстром наборе.
    const scenario = (factory = createConvActions) => {
      const pending = deferred<ConvMessage>();
      const f = fixture({}, factory);
      f.api.convSend = async (convId, body) => { f.sends.push({ convId, body }); return pending.promise; };
      f.enqueue('one');
      f.enqueue('two');
      return { f, pending };
    };
    const { f, pending } = scenario();
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['one']);
    pending.resolve(message('one'));
    await settle();
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['one', 'two']);
    f.actions.convReset();
    const mutant = scenario(mutatedFactory((s) => {
      assert.ok(s.includes('sending.has(convId) || '));
      return s.replace('sending.has(convId) || ', '');
    }));
    assert.equal(mutant.f.sends.length, 2, 'без замка два запроса стартуют до первого ответа');
    mutant.f.actions.convReset();
    mutant.pending.resolve(message('one'));
    await settle();
  });

  it('отправки разных бесед не ждут чужого ответа', async () => {
    // Ловит глобальный замок очереди, замораживающий все ЛС из-за одной медленной беседы.
    const pending = deferred<ConvMessage>();
    const f = fixture({ convSend: async () => pending.promise });
    const ids: string[] = [];
    f.api.convSend = async (id) => { ids.push(id); return pending.promise; };
    f.enqueue('one', 'c');
    f.enqueue('two', 'd');
    assert.deepEqual(ids, ['c', 'd']);
    f.actions.convReset();
    pending.resolve(message('late'));
    await settle();
  });

  it('сетевая ошибка держит следующую строку и повторяет прежний clientId по таймеру', async () => {
    // Ловит дубль сообщения после потерянного ответа и обгон головы очереди.
    const f = fixture();
    let tries = 0;
    f.api.convSend = async (convId, body) => {
      f.sends.push({ convId, body });
      if (++tries === 1) throw new Error('сеть');
      return message(body.clientId, convId);
    };
    f.enqueue('one');
    f.enqueue('two');
    await settle();
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['one']);
    await f.advance(999);
    assert.equal(f.sends.length, 1);
    await f.advance(1);
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['one', 'one', 'two']);
    assert.deepEqual(f.sends[1].body, f.sends[0].body);
    assert.equal(Object.keys(f.get().outbox).length, 0);
  });

  it('4xx оставляет ошибку без автоповтора, следующая строка уходит', async () => {
    // Ловит вечную блокировку очереди сообщением, которое сервер окончательно отверг.
    const f = fixture();
    f.api.convSend = async (convId, body) => {
      f.sends.push({ convId, body });
      if (body.clientId === 'bad') throw Object.assign(new Error('нет доступа'), { status: 403 });
      return message(body.clientId, convId);
    };
    f.enqueue('bad');
    f.enqueue('good');
    await settle();
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['bad', 'good']);
    assert.equal(f.get().outbox.c[0].status, 'failed');
    assert.match(f.get().outbox.c[0].error!, /нет доступа/);
    assert.equal(f.timers.size, 0);
  });

  it('ручной повтор снимает отложенный таймер и отправляет немедленно тем же ключом', async () => {
    // Ловит двойной автоповтор следом за ручным и ожидание паузы после кнопки «Повторить».
    const f = fixture();
    let first = true;
    f.api.convSend = async (convId, body) => {
      f.sends.push({ convId, body });
      if (first) { first = false; throw new Error('offline'); }
      return message(body.clientId, convId);
    };
    f.enqueue('retry');
    await settle();
    assert.equal(f.timers.size, 1);
    f.actions.outboxRetry('c', 'retry');
    await settle();
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['retry', 'retry']);
    await f.advance(1000);
    assert.equal(f.sends.length, 2);
  });

  it('повтор частичной загрузки сохраняет первое вложение и загружает только недостающее', async () => {
    // Ловит новые id вложений при replay и конфликт идемпотентного сообщения на сервере.
    const f = fixture();
    let secondFailed = false;
    f.api.convUpload = async (_id, file) => {
      f.uploads.push(file.name);
      if (file.name === 'second' && !secondFailed) { secondFailed = true; throw new Error('offline'); }
      return { id: `${file.name}-id`, name: file.name, url: 'https://file.test', contentType: 'text/plain', size: 1 };
    };
    f.enqueue('files', 'c', [{ name: 'first' }, { name: 'second' }] as File[]);
    await settle();
    assert.equal(f.sends.length, 0);
    assert.equal(f.get().outbox.c[0].uploaded[0]?.id, 'first-id');
    await f.advance(1000);
    assert.deepEqual(f.uploads, ['first', 'second', 'second']);
    assert.equal(f.sends[0].body.clientId, 'files');
    assert.deepEqual(f.sends[0].body.attachments?.map((a) => a.id), ['first-id', 'second-id']);
  });

  it('подъём кеша сам отправляет готовую строку, потерянный файл оставляет понятную ошибку', async () => {
    // Ловит очередь, не ожившую после перезапуска, и попытку послать отсутствующий файл.
    const f = fixture();
    f.set({ conv: convRules.emptyConvState() });
    const ready = outboxRules.toPersisted(outboxRules.newOutboxItem('c', { key: 'same-id', content: 'x', files: [], replyToId: null }, 0));
    const lost = { ...ready, convId: 'd', key: 'lost', fileNames: ['lost.txt'], uploaded: [] };
    f.actions.convHydrate({ v: cacheRules.CONV_CACHE_SCHEMA, pts: 0, savedAt: 0, summaries: [summary()], messages: {}, gone: [], outbox: [ready, lost] });
    await settle();
    assert.deepEqual(f.sends.map((s) => s.body.clientId), ['same-id']);
    assert.equal(f.get().outbox.d[0].status, 'failed');
    assert.match(f.get().outbox.d[0].error!, /прикрепите.*снова/);
  });

  it('reset отбрасывает ответ старой отправки: проверено мутантом без проверки поколения', async () => {
    // Ловит сообщение прежнего аккаунта, попавшее в новую ленту после reset.
    const scenario = async (factory = createConvActions) => {
      const pending = deferred<ConvMessage>();
      const f = fixture({ convSend: async () => pending.promise }, factory);
      f.enqueue('old');
      f.actions.convReset();
      f.set({ dmMessages: { c: [] } });
      pending.resolve(message('old'));
      await settle();
      return f.get().dmMessages.c.length;
    };
    assert.equal(await scenario(), 0);
    const mutant = mutatedFactory((s) => {
      const needle = 'if (myGen !== gen) return;\n      setItems(convId';
      assert.ok(s.includes(needle));
      return s.replace(needle, 'setItems(convId');
    });
    assert.equal(await scenario(mutant), 1, 'без поколения старый ответ загрязняет новую ленту');
    const f = fixture({ convSend: async () => { throw new Error('offline'); } });
    f.enqueue('timer');
    await settle();
    assert.equal(f.timers.size, 1);
    f.actions.convReset();
    assert.equal(f.timers.size, 0);
  });

  it('сеть вернулась — очередь пробуждается без ready шлюза', async () => {
    // Ловит навсегда застрявшее сообщение после восстановления сети.
    const f = fixture();
    f.set({ convActive: false });
    f.enqueue('online');
    assert.equal(f.sends.length, 0);
    f.set({ convActive: true });
    f.online();
    await settle();
    assert.equal(f.sends[0].body.clientId, 'online');
    assert.equal(Object.keys(f.get().outbox).length, 0);
  });

  it('при deviceOffline очередь сразу помечается netFail и после online уходит тем же clientId', async () => {
    // Офлайн не должен оставлять серую отправку на retry-delay; возврат сети автоматически возобновляет ту же запись.
    let offline = true;
    let attempts = 0;
    const f = fixture({}, createConvActions, { deviceOffline: () => offline });
    f.api.convSend = async (convId, body, timeoutMs) => {
      f.sends.push({ convId, body });
      assert.equal(timeoutMs, 15_000, 'обычная отправка передаёт API 15-секундный таймаут');
      attempts++;
      if (attempts === 1) throw new Error('Failed to fetch');
      return message(body.clientId, convId);
    };
    f.enqueue('same-offline-id');
    await settle();
    assert.deepEqual([f.get().outbox.c[0].status, f.get().outbox.c[0].netFail, f.get().outbox.c[0].error],
      ['failed', true, outboxRules.NO_CONNECTION_ERROR], 'при отсутствии устройства строки сразу становятся повторяемым сетевым отказом');
    assert.equal(f.timers.size, 0, 'не ставится бесполезная пауза повтора, пока сети нет');
    offline = false;
    f.online();
    await settle();
    assert.deepEqual(f.sends.map(x => x.body.clientId), ['same-offline-id', 'same-offline-id'], 'online повторяет ту же идемпотентную отправку');
    assert.equal(f.get().outbox.c, undefined, 'успешное восстановление убирает строку из очереди');
  });

  it('потеря шлюза помечает отказ сетевым и ready запускает повтор', async () => {
    // При живом устройстве, но оборванном шлюзе, восстановление происходит через convOnReady, а не через окно online.
    const f = fixture();
    let attempts = 0;
    f.api.convSend = async (convId, body, timeoutMs) => {
      f.sends.push({ convId, body });
      assert.equal(timeoutMs, 15_000, 'вызов через потерянный шлюз всё равно ограничен SEND_TIMEOUT_MS');
      if (++attempts === 1) throw new Error('offline');
      return message(body.clientId, convId);
    };
    f.actions.convOnGatewayLost();
    await settle();
    f.enqueue('gateway-id');
    await settle();
    assert.ok(f.get().outbox.c[0]?.netFail, 'отправка при gateway=down сразу хранится как netFail');
    await f.actions.convOnReady();
    await settle();
    assert.deepEqual(f.sends.map(x => x.body.clientId), ['gateway-id', 'gateway-id'], 'ready оживляет очередь тем же clientId');
    assert.equal(f.get().outbox.c, undefined, 'ответ повторной попытки очищает список');
    f.actions.convReset();
  });

  it('таймаут API сохраняет маркер связи и получает лимит 15000 мс', async () => {
    // TimeoutError принципиально отличается от отказа по правам: строка должна ожить сама при следующем подключении.
    const timeouts: number[] = [];
    const f = fixture();
    f.api.convSend = async (_convId, _body, timeoutMs) => {
      timeouts.push(timeoutMs ?? -1);
      throw Object.assign(new Error('сервер не ответил'), { timeout: true });
    };
    f.enqueue('timeout');
    await settle();
    assert.deepEqual(timeouts, [15_000], 'store ограничивает запрос именно пятнадцатью секундами');
    assert.deepEqual([f.get().outbox.c[0].status, f.get().outbox.c[0].netFail, f.get().outbox.c[0].error],
      ['failed', true, outboxRules.NO_CONNECTION_ERROR], 'таймаут немедленно оставляет возобновляемый сетевой отказ');
  });
});

describe('поколения истории и замка очереди', () => {
  it('без sameGen старое открытие загрязняет новый стор: контрфактическое подтверждение', async () => {
    const mutant = mutatedFactory((s) => {
      const needle = 'await sameGen(api.convHistory(convId, { limit: stale ? STALE_PAGE : HISTORY_PAGE }))';
      const changed = s.replace(needle, 'await api.convHistory(convId, { limit: stale ? STALE_PAGE : HISTORY_PAGE })'); assert.notEqual(changed, s); return changed;
    });
    const p = deferred<Awaited<ReturnType<ConvDeps['api']['convHistory']>>>();
    const f = fixture({ convHistory: () => p.promise }, mutant); const opening = f.actions.convOpen('c');
    f.actions.convReset(); p.resolve({ pts: 0, messages: [message('old')], hasMoreBefore: false, hasMoreAfter: false });
    await opening; assert.equal(f.get().dmMessages.c[0].id, 'old');
  });
  it('ответ открытия после reset не приносит сообщения, прочтение и ошибку в новый стор', async () => {
    const p = deferred<Awaited<ReturnType<ConvDeps['api']['convHistory']>>>();
    let reads = 0;
    const f = fixture({ convHistory: () => p.promise, convRead: async () => { reads++; return { lastReadKey: 1 }; } });
    f.set({ currentDmId: 'c', view: 'dm' });
    const loading = f.actions.convOpen('c'); f.actions.convReset();
    p.resolve({ pts: 0, messages: [message('old')], hasMoreBefore: false, hasMoreAfter: false });
    await loading;
    assert.equal(f.get().dmMessages.c, undefined); assert.equal(reads, 0); assert.deepEqual(f.get().historyFailed, []);
  });
  it('отказ старого открытия после reset не запускает запасной запрос места', async () => {
    let reject!: (e: Error) => void; let calls = 0;
    const p = new Promise<never>((_r, no) => { reject = no; });
    const f = fixture({ convHistory: () => { calls++; return p; } }, createConvActions, { windowed: () => true });
    f.set({ places: { c: { messageId: 'gone', offset: 0 } } });
    const opening = f.actions.convOpen('c'); f.actions.convReset();
    reject(Object.assign(new Error('нет'), { status: 404 })); await opening;
    assert.equal(calls, 1); assert.deepEqual(f.get().historyFailed, []);
  });
  it('старая подгрузка и создание беседы после reset отвергаются с switched', async () => {
    const p = deferred<Awaited<ReturnType<ConvDeps['api']['convHistory']>>>();
    const d = deferred<ConvSummary>();
    const f = fixture({ convHistory: () => p.promise, convDirect: () => d.promise });
    f.set({ dmMessages: { c: [message('edge')] } });
    const loading = f.actions.convLoadOlder('c'); const opening = f.actions.convOpenWith('peer');
    const a = assert.rejects(loading, (e: unknown) => !!(e as { switched?: boolean }).switched);
    const b = assert.rejects(opening, (e: unknown) => !!(e as { switched?: boolean }).switched);
    f.actions.convReset(); p.resolve({ pts: 0, messages: [message('old')], hasMoreBefore: false, hasMoreAfter: false }); d.resolve(summary('foreign'));
    await Promise.all([a, b]); assert.equal(f.get().conv.summaries.foreign, undefined);
    assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), ['edge']);
  });
  it('finally старой отправки не снимает замок новой: мутант запускает голову дважды', async () => {
    async function run(factory: typeof createConvActions) {
      const old = deferred<ConvMessage>(); const fresh = deferred<ConvMessage>();
      const f = fixture({}, factory);
      f.api.convSend = async (convId, body) => { f.sends.push({ convId, body }); return body.clientId === 'one' ? old.promise : fresh.promise; };
      f.enqueue('one'); f.actions.convReset(); f.enqueue('two');
      old.resolve(message('one')); await settle(); f.enqueue('three'); await settle();
      const keys = f.sends.map((s) => s.body.clientId);
      f.actions.convReset(); fresh.resolve(message('two')); await settle(); return keys;
    }
    assert.deepEqual(await run(createConvActions), ['one', 'two']);
    const mutant = mutatedFactory((s) => { const changed = s.replace('if (myGen === gen) sending.delete(convId)', 'sending.delete(convId)'); assert.notEqual(changed, s); return changed; });
    assert.deepEqual(await run(mutant), ['one', 'two', 'two']);
  });
});

describe('оконные действия беседы', () => {
  const page = (ids: string[], before = false, after = false) => ({ pts: 0, messages: ids.map((id, i) => message(id, 'c', Number(id) || i + 1)), hasMoreBefore: before, hasMoreAfter: after });
  it('оконное прочтение берёт только загруженное и не гасит серверный счётчик сводки', async () => {
    async function run(factory = createConvActions) {
      const reads: number[] = [];
      const f = fixture({ convRead: async (_id, key) => { reads.push(key); return { lastReadKey: key }; } }, factory, { windowed: () => true });
      const sum = { ...summary('c', 120), lastMessage: { id: '120', sortKey: 120, authorId: 'peer', text: '120', attachments: 0, createdAt: '2026-10-01T00:00:00Z' } };
      f.set({ conv: { ...f.get().conv, summaries: { c: sum } }, unreadDms: ['c'] });
      f.actions.convReadNow('c'); await settle();
      const empty = [...reads]; f.set({ dmMessages: { c: [message('50', 'c', 50)] } });
      f.actions.convReadNow('c'); await settle(); return { empty, reads, f };
    }
    const good = await run(); assert.deepEqual(good.empty, []); assert.deepEqual(good.reads, [50]);
    assert.equal(good.f.get().conv.summaries.c.unread, 120); assert.deepEqual(good.f.get().unreadDms, []);
    const mutant = mutatedFactory((s) => { const x = s.replace('win ? undefined : summary', 'summary'); assert.notEqual(x, s); return x; });
    assert.deepEqual((await run(mutant)).empty, [120]);
  });
  it('подгрузка ограничена 300 только в оконном режиме, прежняя лента сохраняет весь хвост', async () => {
    for (const enabled of [true, false]) {
      const f = fixture({ convHistory: async () => page(['0']) }, createConvActions, { windowed: () => enabled });
      f.set({ dmMessages: { c: Array.from({ length: 300 }, (_, i) => message(String(i + 1), 'c', i + 1)) },
        conv: { ...f.get().conv, windows: { c: { basePts: 0, hasMoreBefore: true, hasMoreAfter: false } } } });
      await f.actions.convLoadOlder('c'); assert.equal(f.get().dmMessages.c.length, enabled ? 300 : 301);
      assert.equal(f.get().conv.windows.c.hasMoreAfter, enabled);
    }
  });
  it('открытие непрочитанного использует ключ, без windowed всегда последние', async () => {
    for (const enabled of [true, false]) {
      const queries: unknown[] = [];
      const f = fixture({ convHistory: async (_id, q) => { queries.push(q); return page(['11']); } }, createConvActions, { windowed: () => enabled });
      const sum = { ...summary('c', 2), lastReadKey: 10 };
      f.set({ conv: { ...f.get().conv, summaries: { c: sum } } });
      await f.actions.convOpen('c');
      assert.deepEqual(queries, [enabled ? { after: '10_0', limit: 50 } : { limit: 50 }]);
    }
  });
  it('404 места забывает место и открывает последние, цитата 404 возвращает false', async () => {
    const queries: unknown[] = [];
    const f = fixture({ convHistory: async (_id, q) => { queries.push(q); if (q?.around) throw Object.assign(new Error('нет'), { status: 404 }); return page(['tail']); } }, createConvActions, { windowed: () => true });
    f.actions.convSetPlace('c', { messageId: 'gone', offset: -7 }); await f.actions.convOpen('c');
    assert.equal(f.get().places?.c, undefined); assert.equal(queries.length, 2);
    assert.equal(await f.actions.convJumpTo('c', 'gone'), false);
    assert.equal(await f.actions.convJumpTo('c', 'tail'), true); assert.equal(queries.length, 3);
  });
  it('место одинаковое сохраняет объект, null удаляет, reset очищает', () => {
    const f = fixture(); f.actions.convSetPlace('c', { messageId: 'x', offset: -8 }); const prev = f.get().places;
    f.actions.convSetPlace('c', { messageId: 'x', offset: -8 }); assert.equal(f.get().places, prev);
    f.actions.convSetPlace('c', null); assert.deepEqual(f.get().places, {});
    f.actions.convSetPlace('c', { messageId: 'x', offset: 0 }); f.actions.convReset(); assert.deepEqual(f.get().places, {});
  });
  it('свежий хвост по кнопке вниз не требует истории, stale требует', async () => {
    const f = fixture(); f.set({ conv: { ...f.get().conv, windows: { c: { basePts: 0, hasMoreBefore: true, hasMoreAfter: false } } } });
    await f.actions.convJumpLatest('c'); assert.equal(f.histories.length, 0);
    f.set({ conv: { ...f.get().conv, windows: { c: { ...f.get().conv.windows.c, stale: true } } } });
    await f.actions.convJumpLatest('c'); assert.deepEqual(f.histories, ['c']);
  });
  for (const side of ['older', 'newer'] as const) {
    it(`порция ${side} после перехода не приклеивается к новому окну и возвращает его флаг`, async () => {
      const p = deferred<ReturnType<typeof page>>();
      const f = fixture({ convHistory: async (_id, q) => q?.around ? page(['100'], side === 'older', side === 'newer') : p.promise }, createConvActions, { windowed: () => true });
      f.set({ dmMessages: { c: page(['10']).messages }, conv: { ...f.get().conv, windows: { c: { basePts: 0, hasMoreBefore: false, hasMoreAfter: false } } } });
      const loading = side === 'older' ? f.actions.convLoadOlder('c') : f.actions.convLoadNewer('c');
      assert.equal(await f.actions.convJumpTo('c', '100'), true);
      const current = f.get().dmMessages.c; p.resolve(page(['9'], false, false));
      assert.equal(await loading, true); assert.equal(f.get().dmMessages.c, current);
      const mutant = mutatedFactory((s) => {
        const needle = side === 'older'
          ? 'if (listOf(s, convId)?.[0]?.id !== first.id) return !!s.conv.windows[convId]?.hasMoreBefore;'
          : 'if (now?.[now.length - 1]?.id !== last.id) return !!s.conv.windows[convId]?.hasMoreAfter;';
        const x = s.replace(needle, ''); assert.notEqual(x, s); return x;
      });
      const late = deferred<ReturnType<typeof page>>();
      const bad = fixture({ convHistory: async (_id, q) => q?.around ? page(['100'], true, true) : late.promise }, mutant, { windowed: () => true });
      bad.set({ dmMessages: { c: page(['10']).messages }, conv: { ...bad.get().conv, windows: { c: { basePts: 0, hasMoreBefore: true, hasMoreAfter: true } } } });
      const stale = side === 'older' ? bad.actions.convLoadOlder('c') : bad.actions.convLoadNewer('c');
      await bad.actions.convJumpTo('c', '100'); late.resolve(page(['9'])); await stale;
      assert.deepEqual(bad.get().dmMessages.c.map((m) => m.id), ['9', '100']);
    });
    it(`порция ${side} при неизменном крае смыкается с окном`, async () => {
      const f = fixture({ convHistory: async () => page([side === 'older' ? '9' : '11'], true, true) }, createConvActions, { windowed: () => true });
      f.set({ dmMessages: { c: page(['10']).messages }, conv: { ...f.get().conv, windows: { c: { basePts: 0, hasMoreBefore: true, hasMoreAfter: true } } } });
      assert.equal(await (side === 'older' ? f.actions.convLoadOlder('c') : f.actions.convLoadNewer('c')), true);
      assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), side === 'older' ? ['9', '10'] : ['10', '11']);
    });
  }
});

describe('список при потере шлюза', () => {
  it('обрыв запускает одну догонку и опрос через 30 секунд, ready снимает опрос', async () => {
    const f = fixture(); f.actions.convOnGatewayLost(); await settle();
    assert.deepEqual(f.syncs, [0]); assert.equal(f.get().conv.phase, 'idle');
    f.actions.convOnGatewayLost(); await settle(); assert.equal(f.syncs.length, 1);
    await f.advance(29999); assert.equal(f.syncs.length, 1);
    await f.advance(1); assert.equal(f.syncs.length, 2);
    await f.actions.convOnReady(); assert.equal(f.get().conv.phase, 'live');
    await f.advance(30000); assert.equal(f.syncs.length, 3); f.actions.convReset(); assert.equal(f.timers.size, 0);
  });
  it('обрыв во время догонки не возвращает ложную live-фазу', async () => {
    const p = deferred<ConvSyncResponse>(); const f = fixture({ convSync: () => p.promise });
    const loading = f.actions.convOnReady(); f.actions.convOnGatewayLost();
    p.resolve(syncPage(1)); await loading; assert.equal(f.get().conv.phase, 'idle'); f.actions.convReset();
  });
});

describe('черновики между устройствами', () => {
  const enabled = { draftsOnServer: () => true, draftDevice: 'me' };
  function drafting(api: Partial<ConvDeps['api']> = {}, deps: Partial<ConvDeps> = enabled, factory = createConvActions) {
    const calls: { text: string; keepalive?: boolean }[] = [];
    const f = fixture({ convDraft: async (_id, body, keepalive) => { calls.push({ text: body.text, keepalive }); }, ...api }, factory, deps);
    const change = (text: string) => { f.set({ drafts: text ? { c: { text, replyToId: null } } : {} }); f.actions.convDraftChanged('c'); };
    return { ...f, calls, change };
  }
  it('запись после паузы 2 секунды, погашение сразу, keepalive передаётся', async () => {
    const f = drafting(); f.change('текст'); assert.deepEqual(f.get().draftDirty, ['c']);
    await f.advance(1999); assert.equal(f.calls.length, 0); await f.advance(1); assert.equal(f.calls[0].text, 'текст');
    assert.deepEqual(f.get().draftDirty, []); f.change(''); await f.advance(0); assert.equal(f.calls[1].text, '');
    f.change('уход'); f.actions.convFlushDrafts(true); await settle(); assert.equal(f.calls[2].keepalive, true);
  });
  it('непрерывный набор не откладывает серверную запись дальше десяти секунд', async () => {
    const f = drafting(); f.change('0');
    for (let i = 1; i <= 9; i++) { await f.advance(1000); f.change(String(i)); }
    assert.equal(f.calls.length, 0); await f.advance(1000); assert.equal(f.calls[0].text, '9');
  });
  it('изменение во время записи не снимает dirty и уходит вторым последовательным кругом', async () => {
    const p = deferred<void>(); let n = 0; const texts: string[] = [];
    const f = drafting({ convDraft: async (_id, body) => { texts.push(body.text); if (++n === 1) await p.promise; } });
    f.change('first'); await f.advance(2000); f.change('second'); await f.advance(2000);
    assert.deepEqual(texts, ['first']); assert.deepEqual(f.get().draftDirty, ['c']);
    p.resolve(); await settle(); assert.deepEqual(texts, ['first', 'second']); assert.deepEqual(f.get().draftDirty, []);
  });
  for (const status of [400, 403, 404]) {
    it(`отказ ${status} снимает dirty без бессмысленного автоповтора`, async () => {
      const f = drafting({ convDraft: async () => { throw Object.assign(new Error('нет'), { status }); } });
      f.change('x'); await f.advance(2000); assert.deepEqual(f.get().draftDirty, []); assert.equal(f.timers.size, 0);
    });
  }
  for (const status of [undefined, 429, 500]) {
    it(`временный отказ ${status ?? 'сеть'} сохраняет dirty и повторяет запись без потери текста`, async () => {
      let calls = 0;
      const f = drafting({ convDraft: async () => { if (++calls === 1) throw Object.assign(new Error('нет'), { status }); } });
      f.change('x'); await f.advance(2000); assert.deepEqual(f.get().draftDirty, ['c']);
      await f.advance(14999); assert.equal(calls, 1); await f.advance(1); assert.equal(calls, 2); assert.deepEqual(f.get().draftDirty, []);
    });
  }
  it('старый планировщик повтора нарушает границу 15 секунд — мутант ловится тем же сценарием', async () => {
    // Ловит возвращение max-wait набора в таймер сетевого повтора.
    const factory = mutatedFactory((s) => {
      const changed = s.replace('else armDraftTimer(convId, DRAFT_RETRY_MS);', 'else scheduleDraftSave(convId, DRAFT_RETRY_MS);');
      assert.notEqual(changed, s); return changed;
    });
    let calls = 0;
    const f = drafting({ convDraft: async () => { if (++calls === 1) throw new Error('сеть'); } }, enabled, factory);
    f.change('x'); await f.advance(2000); await f.advance(14999);
    assert.throws(() => assert.equal(calls, 1), assert.AssertionError); assert.equal(calls, 2);
  });
  it('новая буква в ожидании повтора ждёт паузу 2 секунды, а не старый предел набора', async () => {
    // Ловит засев draftFirstDirty от ошибки сети и мгновенную отправку новой буквы.
    async function scenario(factory = createConvActions) {
      let calls = 0;
      const f = drafting({ convDraft: async () => { if (++calls === 1) throw new Error('сеть'); } }, enabled, factory);
      f.change('x'); await f.advance(2000); await f.advance(12500); f.change('xy');
      await f.advance(0); const atChange = calls;
      await f.advance(1999); const beforePause = calls; await f.advance(1);
      assert.equal(f.get().draftDirty?.length, 0); return { atChange, beforePause, afterPause: calls };
    }
    assert.deepEqual(await scenario(), { atChange: 1, beforePause: 1, afterPause: 2 });
    const mutant = mutatedFactory((s) => {
      const changed = s.replace('else armDraftTimer(convId, DRAFT_RETRY_MS);', 'else { draftFirstDirty.set(convId, now()); armDraftTimer(convId, DRAFT_RETRY_MS); }');
      assert.notEqual(changed, s); return changed;
    });
    const result = await scenario(mutant);
    assert.throws(() => assert.equal(result.atChange, 1), assert.AssertionError);
  });
  it('reset посреди записи отбрасывает ответ и убирает таймеры', async () => {
    const p = deferred<void>(); const f = drafting({ convDraft: () => p.promise });
    f.change('x'); await f.advance(2000); f.actions.convReset(); p.resolve(); await settle();
    assert.deepEqual(f.get().draftDirty, []); assert.equal(f.timers.size, 0);
  });
  it('ready дописывает dirty, сервер без conv3 не ставит dirty и ничего не пишет', async () => {
    const f = drafting(); f.set({ drafts: { c: { text: 'cached', replyToId: null } }, draftDirty: ['c'] });
    await f.actions.convOnReady(); await settle(); assert.equal(f.calls[0].text, 'cached');
    const old = drafting({}, {}); old.change('local'); await old.advance(20000);
    assert.equal(old.get().draftDirty, undefined); assert.equal(old.calls.length, 0);
  });
  it('чужой серверный черновик обновляет rev, dirty и своё эхо его не меняют', () => {
    const f = drafting();
    const remote = (text: string, device: string) => ({ ...summary(), draft: { text, replyToId: null, device, at: '2026-10-01T00:00:00Z' } });
    f.actions.convOnChange({ pts: 1, conversation: remote('remote', 'other') }, false);
    assert.equal(f.get().drafts.c.text, 'remote'); assert.equal(f.get().draftRev?.c, 1);
    f.actions.convOnChange({ pts: 2, conversation: remote('echo', 'me') }, false); assert.equal(f.get().draftRev?.c, 1);
    f.change('local'); f.actions.convOnChange({ pts: 3, conversation: remote('old', 'other') }, false);
    assert.equal(f.get().drafts.c.text, 'local'); assert.equal(f.get().draftRev?.c, 1); f.actions.convReset();
  });
  it('hydrate не применяет отставший черновик сводки поверх нового локального, место поднимается', () => {
    const f = drafting(); f.actions.convReset();
    const rec = { v: cacheRules.CONV_CACHE_SCHEMA, pts: 0, savedAt: 1, messages: {}, gone: [],
      summaries: [{ ...summary(), draft: { text: 'old', replyToId: null, device: 'other', at: '2026-10-01T00:00:00Z' } }],
      places: { c: { messageId: 'm', offset: -5 } } };
    f.set({ drafts: { c: { text: 'new', replyToId: null } } }); f.actions.convHydrate(rec);
    assert.equal(f.get().drafts.c.text, 'new'); assert.equal(f.get().draftRev?.c, undefined); assert.deepEqual(f.get().places, rec.places);
    const mutant = mutatedFactory((s) => {
      const needle = 'commit(conv, messages, seedUnread(conv.summaries, onScreenId(s)), false)';
      const x = s.replace(needle, 'commit(conv, messages, seedUnread(conv.summaries, onScreenId(s)))'); assert.notEqual(x, s); return x;
    });
    const bad = fixture({}, mutant, enabled); bad.actions.convReset(); bad.set({ drafts: { c: { text: 'new', replyToId: null } } });
    bad.actions.convHydrate(rec); assert.equal(bad.get().drafts.c.text, 'old');
  });
});

describe('прочтение собеседником и старый кеш conv4', () => {
  const rec = () => ({ v: cacheRules.CONV_CACHE_SCHEMA, pts: 10, savedAt: 1, messages: {}, gone: [], summaries: [summary('c', 3), summary('d')] });
  function hydrated(overrides: Partial<ConvDeps['api']> = {}, enabled = true, factory = createConvActions) {
    const marks: string[] = [];
    const f = fixture({ convList: async () => ({ pts: 10, conversations: [{ ...summary('c'), peerReadKey: 20 }, { ...summary('d'), peerReadKey: null }] }), ...overrides }, factory,
      { peerReadsOnServer: () => enabled, markChannelSeen: (id) => marks.push(id), draftsOnServer: () => true, draftDevice: 'me' });
    f.actions.convReset(); f.actions.convHydrate(rec());
    f.set({ drafts: { c: { text: 'local', replyToId: null } }, draftRev: { c: 5 } }); return { ...f, marks };
  }
  it('равный номер списка дописывает peerReadKey один раз без изменения прочих полей', async () => {
    let lists = 0;
    const f = hydrated({ convList: async () => { lists++; return { pts: 10, conversations: [{ ...summary('c'), peerReadKey: 20 }, { ...summary('d'), peerReadKey: null }] }; } });
    const before = f.get(); await f.actions.convOnReady();
    assert.equal(lists, 1); assert.equal(f.get().conv.summaries.c.peerReadKey, 20); assert.equal(f.get().conv.summaries.d.peerReadKey, null);
    assert.equal(f.get().conv.pts, 10); assert.deepEqual(f.get().conv.summaryPts, before.conv.summaryPts);
    assert.equal(f.get().conv.summaries.c.unread, 3); assert.equal(f.get().drafts, before.drafts); assert.equal(f.get().draftRev, before.draftRev);
    assert.deepEqual(f.marks, []); assert.equal(f.get().conv.phase, 'live');
    await f.actions.convOnReady(); assert.equal(lists, 1);
    f.actions.convReset(); f.actions.convHydrate(rec()); await f.actions.convOnReady(); assert.equal(lists, 2);
  });
  it('без conv4 нет дополнительного списка, сервер с отсутствующим полем перечитывается раз за поколение', async () => {
    let lists = 0;
    for (const enabled of [false, true]) {
      lists = 0; const f = hydrated({ convList: async () => { lists++; return { pts: 10, conversations: [summary()] }; } }, enabled);
      await f.actions.convOnReady(); await f.actions.convOnReady(); assert.equal(lists, enabled ? 1 : 0);
    }
  });
  it('сбой обновления peerRead не ломает live и повторяется на следующем ready', async () => {
    let lists = 0;
    const f = hydrated({ convList: async () => { if (++lists === 1) throw new Error('сеть'); return { pts: 10, conversations: [{ ...summary(), peerReadKey: 20 }] }; } });
    await f.actions.convOnReady(); assert.equal(f.get().conv.phase, 'live'); assert.equal(lists, 1);
    await f.actions.convOnReady(); assert.equal(lists, 2); assert.equal(f.get().conv.summaries.c.peerReadKey, 20);
  });
  it('свежий запуск загружает один список, не два', async () => {
    let lists = 0; const f = hydrated({ convList: async () => { lists++; return { pts: 10, conversations: [{ ...summary(), peerReadKey: 20 }] }; } });
    f.actions.convReset(); await f.actions.convOnReady(); assert.equal(lists, 1);
  });
  it('событие только peerRead сохраняет черновик, непрочитанное и посещение', () => {
    const f = hydrated(); const s = { ...summary('c', 3), lastReadKey: 1, peerReadKey: 10 };
    f.set({ conv: { ...f.get().conv, phase: 'live', summaries: { c: s } }, unreadDms: ['c'] }); const before = f.get();
    f.actions.convOnChange({ pts: 11, conversation: { ...s, peerReadKey: 20 } }, false);
    assert.equal(f.get().conv.pts, 11); assert.equal(f.get().conv.summaries.c.peerReadKey, 20);
    assert.equal(f.get().conv.summaries.c.lastReadKey, 1); assert.equal(f.get().conv.summaries.c.unread, 3);
    assert.deepEqual(f.get().unreadDms, before.unreadDms); assert.equal(f.get().drafts, before.drafts); assert.equal(f.get().draftRev, before.draftRev); assert.deepEqual(f.marks, []);
  });
  it('мутант без refreshPeerRead не обновляет старую сводку, без флага повторяет негодный список', async () => {
    const noRefresh = mutatedFactory((s) => { const x = s.replace('await refreshPeerRead(myGen)', 'await Promise.resolve()'); assert.notEqual(x, s); return x; });
    const f = hydrated({}, true, noRefresh); await f.actions.convOnReady(); assert.equal(f.get().conv.summaries.c.peerReadKey, undefined);
    const noFlag = mutatedFactory((s) => { const x = s.replace('peerReadRefreshed || ', ''); assert.notEqual(x, s); return x; });
    let lists = 0; const bad = hydrated({ convList: async () => { lists++; return { pts: 10, conversations: [summary()] }; } }, true, noFlag);
    await bad.actions.convOnReady(); await bad.actions.convOnReady(); assert.equal(lists, 2);
    const noBackfill = mutatedFactory((s) => {
      const changed = s.replace('const conv = withPeerRead(get().conv, res.conversations);',
        'const conv = res.conversations.reduce((state, summary) => applySummary(state, summary, res.pts).state, get().conv);');
      assert.notEqual(changed, s); return changed;
    });
    const stale = hydrated({}, true, noBackfill); await stale.actions.convOnReady();
    assert.equal(stale.get().conv.summaries.c.peerReadKey, undefined, 'равный pts запрещает обычное applySummary, но не backfill');
  });
});

describe('исполняемая догонка бесед', () => {
  it('reset освобождает новую догонку и отбрасывает поздний старый ответ', async () => {
    // Ловит вечное ожидание запроса прежнего инстанса и примесь его снимка в новом.
    const pending = deferred<ConvSyncResponse>();
    const f = fixture({ convSync: async () => pending.promise, convList: async () => ({ pts: 5, conversations: [summary('new')] }) });
    const old = f.actions.convOnReady();
    f.actions.convReset();
    await f.actions.convOnReady();
    assert.equal(f.get().conv.pts, 5);
    pending.resolve({ reset: false, pts: 99, more: false, conversations: [summary('old')], messages: [] });
    await old;
    assert.equal(f.get().conv.pts, 5);
    assert.deepEqual(Object.keys(f.get().conv.summaries), ['new']);
  });

  it('событие во время sync буферизуется и применяется вместе с переходом в live', async () => {
    // Ловит потерю события между REST-снимком и включением живого протокола.
    const pending = deferred<ConvSyncResponse>();
    const f = fixture({ convSync: async () => pending.promise });
    const syncing = f.actions.convOnReady();
    f.actions.convOnChange({ pts: 2, conversation: summary('c', 1) }, true);
    assert.equal(f.get().conv.buffer.length, 1);
    assert.equal(f.get().conv.phase, 'syncing');
    pending.resolve(syncPage(1));
    await syncing;
    assert.equal(f.get().conv.pts, 2);
    assert.equal(f.get().conv.phase, 'live');
    assert.equal(f.get().conv.buffer.length, 0);
    assert.deepEqual(f.get().unreadDms, ['c']);
  });

  it('дыра в буфере вызывает ещё один круг и не теряет более позднее событие', async () => {
    // Ловит переход в live с пропущенным номером журнала.
    const pending = deferred<ConvSyncResponse>();
    const f = fixture();
    f.api.convSync = async (pts) => { f.syncs.push(pts); return f.syncs.length === 1 ? pending.promise : syncPage(2); };
    const syncing = f.actions.convOnReady();
    f.actions.convOnChange({ pts: 3, conversation: summary('c', 1) }, true);
    pending.resolve(syncPage(1));
    await syncing;
    assert.deepEqual(f.syncs, [0, 1]);
    assert.equal(f.get().conv.pts, 3);
    assert.equal(f.get().conv.phase, 'live');
  });

  it('повтор ready во время запроса требует ещё один круг без параллельного sync', async () => {
    // Ловит окно потери событий между снимком и повторным identify.
    const pending = deferred<ConvSyncResponse>();
    const f = fixture();
    f.api.convSync = async (pts) => { f.syncs.push(pts); return f.syncs.length === 1 ? pending.promise : syncPage(2); };
    const first = f.actions.convOnReady();
    const second = f.actions.convOnReady();
    assert.deepEqual(f.syncs, [0]);
    pending.resolve(syncPage(1));
    await Promise.all([first, second]);
    assert.deepEqual(f.syncs, [0, 1]);
    assert.equal(f.get().conv.pts, 2);
  });

  it('reset сервера перечитывает список и открытую беседу, остальные старые ленты выбрасывает', async () => {
    // Ловит устаревшие закрытые ссылки и сообщения после обрезания серверного журнала.
    const f = fixture({ convSync: async () => ({ reset: true, pts: 10 }), convList: async () => ({ pts: 10, conversations: [summary()] }) });
    f.api.convHistory = async (id) => { f.histories.push(id); return { pts: 10, messages: [message('fresh')], hasMoreBefore: false, hasMoreAfter: false }; };
    f.set({ currentDmId: 'c', view: 'dm', dmMessages: { c: [message('old')], d: [message('other', 'd')] } });
    await f.actions.convOnReady();
    assert.deepEqual(f.histories, ['c']);
    assert.deepEqual(Object.keys(f.get().dmMessages), ['c']);
    assert.equal(f.get().dmMessages.c[0].id, 'fresh');
    assert.equal(f.get().conv.pts, 10);
    assert.equal(f.get().conv.phase, 'live');
  });
});
