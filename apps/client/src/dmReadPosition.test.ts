import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ConvMessage, ConvSummary, ConvSyncResponse } from '@gusvoice/shared';
import { createConvActions, type ConvDeps, type ConvHost } from './convStore';
import { applyList, applySummary, emptyConvState, placeForRead } from './convSyncRules';
import { acceptRecord, CONV_CACHE_SCHEMA } from './convCacheRules';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const msg = (key: number, id = 'c'): ConvMessage => ({
  id: `m${key}`, channelId: id, conversationId: id, sortKey: key, clientId: null, content: '',
  author: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null },
  createdAt: '2026-11-08T00:00:00Z', editedAt: null, replyTo: null, attachments: [], reactions: [],
});
const summary = (read = 10, unread = 0, tail = 100, id = 'c'): ConvSummary => ({
  id, kind: 'direct', otherUser: null, createdAt: '2026-11-08T00:00:00Z',
  lastMessageAt: '2026-11-08T00:00:00Z', lastMessage: { id: `m${tail}`, sortKey: tail, authorId: 'peer', text: '', attachments: 0, createdAt: '2026-11-08T00:00:00Z' },
  lastReadKey: read, unread,
});
const page = (keys: number[], pts = 1) => ({ pts, messages: keys.map((k) => msg(k)), hasMoreBefore: true, hasMoreAfter: false });
const sync = (s: ConvSummary): ConvSyncResponse => ({ reset: false, pts: 1, more: false, conversations: [s], messages: [] });
function fixture(overrides: Partial<ConvDeps['api']> = {}) {
  let state: ConvHost = {
    conv: { ...emptyConvState(), phase: 'live', pts: 0, summaries: { c: summary() }, summaryPts: { c: 0 } },
    convActive: true, dms: [], dmMessages: {}, unreadDms: [], historyFailed: [], currentDmId: 'c',
    view: 'dm', mobilePane: 'content', outbox: {}, drafts: {}, places: {},
  };
  const reads: number[] = [];
  const queries: Parameters<ConvDeps['api']['convHistory']>[1][] = [];
  const noIO = async (): Promise<never> => { throw new Error('неожиданный IO'); };
  const actions = createConvActions((patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; }, () => state, {
    api: {
      convList: noIO, convSync: noIO, convDirect: noIO, convSend: noIO, convUpload: noIO,
      convHistory: async (_id, q) => { queries.push(q); return page([100]); },
      convRead: async (_id, key) => { reads.push(key); return { lastReadKey: key }; }, ...overrides,
    },
    now: () => 1000, setTimeout: () => 1, clearTimeout: () => {}, onOnline: () => {},
    isMobile: () => true, readByView: () => true, windowed: () => true, markChannelSeen: () => {},
  });
  return { actions, reads, queries, get: () => state, set: (p: Partial<ConvHost>) => { state = { ...state, ...p }; } };
}

it('прочитанный на другом устройстве хвост открывается актуально, а старое место не восстанавливается', async () => {
  const f = fixture();
  f.actions.convSetPlace('c', { messageId: 'm1', offset: -8 });
  f.set({ view: 'server' });
  f.actions.convOnChange({ pts: 1, conversation: summary(100) }, false);
  await f.actions.convOpen('c');
  assert.equal(f.queries[0]?.around, undefined);
  assert.equal(f.queries[0]?.after, undefined);
  assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), ['m100']);
  assert.equal(placeForRead(f.get().places?.c, 100), null);
  assert.deepEqual(f.reads, []);
});

it('намеренное место старой истории сохраняется при неизменном прочитанном, в том числе после кеша', async () => {
  const f = fixture(); f.set({ conv: { ...f.get().conv, summaries: { c: summary(100) } } });
  f.actions.convSetPlace('c', { messageId: 'm1', offset: -8 });
  const rec = acceptRecord({ v: CONV_CACHE_SCHEMA, pts: 0, savedAt: 1, summaries: [summary(100)], messages: {}, gone: [], places: f.get().places });
  assert.equal(rec?.places?.c.readKey, 100);
  f.set({ places: rec?.places }); await f.actions.convOpen('c');
  assert.equal(f.queries[0]?.around, 'm1');
});

it('настоящие непрочитанные открываются после cursor и читаются только до реально увиденного', async () => {
  const f = fixture({ convHistory: async (_id, q) => { assert.equal(q?.after, '10_0'); return page([11, 12]); } });
  f.set({ conv: { ...f.get().conv, summaries: { c: summary(10, 90) } } });
  await f.actions.convOpen('c'); f.actions.convReadNow('c');
  assert.deepEqual(f.reads, []); assert.equal(f.get().conv.summaries.c.unread, 90);
  f.actions.convSeen('c', 12); f.actions.convReadNow('c'); await tick();
  assert.deepEqual(f.reads, [12]); assert.equal(f.get().conv.summaries.c.unread, 90);
});

it('скрытая телефонная панель не получает право считать загруженный хвост увиденным', async () => {
  const f = fixture(); f.set({ mobilePane: 'list', conv: { ...f.get().conv, summaries: { c: summary(10, 90) } } });
  await f.actions.convOpen('c'); f.actions.convSeen('c', 100); f.actions.convReadNow('c');
  assert.deepEqual(f.reads, []); assert.equal(f.get().conv.summaries.c.unread, 90);
});

it('открытие из кеша ждёт удалённое прочитанное, выбирая хвост после догонки', async () => {
  const pending = deferred<ConvSyncResponse>(); const f = fixture({ convSync: () => pending.promise });
  f.actions.convSetPlace('c', { messageId: 'm1', offset: 0 });
  f.set({ conv: { ...f.get().conv, phase: 'idle' } });
  const opening = f.actions.convOpen('c'); assert.equal(f.queries.length, 0);
  pending.resolve(sync(summary(100))); await opening;
  assert.equal(f.queries.length, 1); assert.equal(f.queries[0]?.around, undefined);
  assert.equal(f.get().conv.summaries.c.lastReadKey, 100); assert.deepEqual(f.reads, []);
});

it('явный переход к сообщению не перебивается запоздалым ответом начального открытия', async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const f = fixture({ convHistory: async (_id, q) => q?.around ? page([1]) : pending.promise });
  const opening = f.actions.convOpen('c');
  assert.equal(await f.actions.convJumpTo('c', 'm1'), true);
  pending.resolve(page([100])); await opening;
  assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), ['m1']); assert.deepEqual(f.reads, []);
});

it('чтение истории во время догонки отменяет автоматический выбор позиции', async () => {
  const pending = deferred<ConvSyncResponse>(); const f = fixture({ convSync: () => pending.promise });
  f.set({ conv: { ...f.get().conv, phase: 'idle' }, dmMessages: { c: [msg(1)] } });
  const opening = f.actions.convOpen('c'); f.actions.convKeepPosition('c');
  pending.resolve(sync(summary(100))); await opening; await tick();
  assert.equal(f.queries.length, 0); assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), ['m1']);
  f.actions.convSetPlace('c', { messageId: 'm1', offset: -4 });
  assert.equal(placeForRead(f.get().places?.c, 100)?.messageId, 'm1');
});

it('сводка и полный список не откатывают cursor и не воскрешают прочитанные сообщения и упоминания', () => {
  const base = { ...emptyConvState(), summaries: { c: summary(100) }, summaryPts: { c: 3 } };
  const old = { ...summary(10, 20), unreadMentions: 4, unreadReactions: 2 };
  for (const state of [applySummary(base, old, 4).state, applyList(base, { pts: 4, conversations: [old] })]) {
    assert.equal(state.summaries.c.lastReadKey, 100); assert.equal(state.summaries.c.unread, 0);
    assert.equal(state.summaries.c.unreadMentions, 0); assert.equal(state.summaries.c.unreadReactions, 2);
  }
  assert.equal(applySummary(base, summary(10, 7, 110), 4).state.summaries.c.unread, 7);
  assert.equal(applySummary(base, old, 2).state, base, 'старый pts вообще не применяется');
});

it('cursor другой беседы не влияет на сохранённую историю, старые и будущие места не цепляются к cursor', async () => {
  const f = fixture();
  f.set({ conv: { ...f.get().conv, summaries: { c: summary(), d: summary(3, 0, 3, 'd') } } });
  f.actions.convSetPlace('d', { messageId: 'd1', offset: 0 });
  f.actions.convOnChange({ pts: 1, conversation: summary(100) }, false);
  assert.equal(placeForRead(f.get().places?.d, 3)?.messageId, 'd1');
  assert.equal(placeForRead({ messageId: 'old', offset: 0 }, 100), null);
  assert.equal(placeForRead({ messageId: 'future', offset: 0, readKey: 101 }, 100), null);
  assert.equal(placeForRead({ messageId: 'exact', offset: 0, readKey: 100 }, 100)?.messageId, 'exact');
});

it('ответ открытия прежнего инстанса не меняет одноимённую беседу и не отправляет прочитанное новому', async () => {
  const pending = deferred<ReturnType<typeof page>>(); const f = fixture({ convHistory: () => pending.promise });
  const opening = f.actions.convOpen('c'); f.actions.convReset();
  f.set({ conv: { ...emptyConvState(), summaries: { c: summary(2) } }, dmMessages: { c: [msg(2)] } });
  pending.resolve(page([100])); await opening;
  assert.equal(f.get().conv.summaries.c.lastReadKey, 2); assert.deepEqual(f.get().dmMessages.c.map((m) => m.id), ['m2']);
  assert.deepEqual(f.get().places, {}); assert.deepEqual(f.reads, []);
});

it('ответ догонки прежнего инстанса не выбирает окно одноимённой новой беседы', async () => {
  const pending = deferred<ConvSyncResponse>(); const f = fixture({ convSync: () => pending.promise });
  f.set({ conv: { ...f.get().conv, phase: 'idle' } }); const opening = f.actions.convOpen('c');
  f.actions.convReset(); f.set({ conv: { ...emptyConvState(), summaries: { c: summary(2) } } });
  pending.resolve(sync(summary(100))); await opening;
  assert.equal(f.get().conv.summaries.c.lastReadKey, 2); assert.equal(f.queries.length, 0); assert.deepEqual(f.reads, []);
});
