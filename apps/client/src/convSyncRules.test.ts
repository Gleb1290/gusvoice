import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as dmList from './dmListRules';
import * as prefs from './convSyncRules';

describe('R115 локальный порядок закрепов', () => {
  it('перестановка обновляет закрепы, но не закрепляет снятые или неизвестные беседы', () => {
    const a = { ...summary('a'), pinnedAt: '2026-10-07T00:00:00.000Z' };
    const b = { ...summary('b'), pinnedAt: '2026-10-08T00:00:00.000Z' };
    const unpinned = { ...summary('unpinned'), pinnedAt: null };
    const legacy = summary('legacy');
    const state = { ...prefs.emptyConvState(), summaries: { a, b, unpinned, legacy }, summaryPts: { a: 4, b: 5 }, pts: 5 };
    const at = '2026-10-09T00:00:00.000Z';
    const check = (api: typeof prefs) => {
      const next = api.patchConvPinOrder(state, { a: at, b: b.pinnedAt, unpinned: at, legacy: at, missing: at });
      assert.equal(next.summaries.a.pinnedAt, at);
      assert.notEqual(next.summaries.a, a);
      for (const id of ['b', 'unpinned', 'legacy'] as const) assert.equal(next.summaries[id], state.summaries[id]);
      assert.equal(next.summaries.missing, undefined);
      assert.equal(next.summaryPts, state.summaryPts);
      assert.equal(next.pts, 5);
      assert.equal(next.windows, state.windows);
      assert.equal(state.summaries.a.pinnedAt, a.pinnedAt);
    };
    check(prefs);
    assert.throws(() => check(mutantSync(' || (at !== null && !s.pinnedAt)', '')), assert.AssertionError,
      'ответ перестановки не должен воскрешать снятый на другом устройстве закреп');
  });

  it('пустая и повторная перестановка сохраняют состояние, null снимает существующий закреп', () => {
    const a = { ...summary('a'), pinnedAt: '2026-10-09T00:00:00.000Z' };
    const b = { ...summary('b'), pinnedAt: null };
    const state = { ...prefs.emptyConvState(), summaries: { a, b } };
    const unchanged: Record<string, string | null>[] = [{}, { a: a.pinnedAt }, { b: null }, { missing: a.pinnedAt }];
    for (const stamps of unchanged)
      assert.equal(prefs.patchConvPinOrder(state, stamps), state);
    const next = prefs.patchConvPinOrder(state, { a: null });
    assert.equal(next.summaries.a.pinnedAt, null);
    assert.equal(next.summaries.b, b);
    assert.equal(state.summaries.a, a);
    assert.equal(prefs.serverPinOrder(['pinorder1']), true);
    for (const features of [null, undefined, [], ['conv11']]) assert.equal(prefs.serverPinOrder(features), false);
  });
});

function mutantSync(from: string, to: string): typeof prefs {
  const source = readFileSync(new URL('./convSyncRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'мутируется существующее правило');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { if (id === '@gusvoice/shared') return shared; assert.equal(id, './dmListRules'); return dmList; } });
  return module.exports as typeof prefs;
}

it('прочитанные реакции уменьшают только выбранную сводку, не ниже нуля, null гасит все', () => {
  // Ловит отрицательный значок и потерю счётчика соседней беседы.
  const a = { ...summary('a'), unreadReactions: 3 };
  const b = { ...summary('b'), unreadReactions: 5 };
  const state = { ...prefs.emptyConvState(), summaries: { a, b } };
  assert.equal(prefs.patchReactionsRead(state, 'missing', 1), state);
  assert.equal(prefs.patchReactionsRead({ ...state, summaries: { a: { ...a, unreadReactions: 0 } } }, 'a', 1).summaries.a.unreadReactions, 0);
  for (const [n, expected] of [[1, 2], [5, 0], [null, 0]] as const) {
    const next = prefs.patchReactionsRead(state, 'a', n);
    assert.equal(next.summaries.a.unreadReactions, expected);
    assert.equal(next.summaries.b, b);
  }
  assert.equal(state.summaries.a.unreadReactions, 3);
});

it('погашение реакций сохраняет identity без изменений и снимает флаг только выбранных', () => {
  // Ловит чтение невидимого соседнего сообщения и лишнюю перерисовку списка.
  const list = [{ id: 'a', reactionUnread: true as const }, { id: 'b', reactionUnread: true as const }, { id: 'c' }];
  assert.equal(prefs.clearReactionUnread(list, []), list);
  assert.equal(prefs.clearReactionUnread(list, ['missing']), list);
  const one = prefs.clearReactionUnread(list, ['a', 'a']);
  assert.deepEqual(one[0], { id: 'a' });
  assert.equal(one[1], list[1]);
  assert.equal(one[2], list[2]);
  const all = prefs.clearReactionUnread(list, null);
  assert.deepEqual(all, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(prefs.clearReactionUnread(all, null), all);
});

it('сводка переносит оба новых счётчика, старый сервер не стирает реакции, признаки независимы', () => {
  // Ловит исчезновение значков при событии старого сервера и случайное включение по чужому cap.
  const s = { ...summary('a'), unreadReactions: 3, unreadMentions: 2 };
  const dm = prefs.summaryToDm(s);
  assert.equal(dm.unreadReactions, 3); assert.equal(dm.unreadMentions, 2);
  assert.equal(prefs.keepChatPrefs(s, summary('a')).unreadReactions, 3);
  assert.equal(prefs.keepChatPrefs(s, { ...summary('a'), unreadReactions: 0 }).unreadReactions, 0);
  assert.equal(prefs.serverReactionsUnread(['reactunread1']), true);
  assert.equal(prefs.serverGlobalSearch(['gsearch1']), true);
  for (const f of [undefined, null, [], ['search1']]) {
    assert.equal(prefs.serverReactionsUnread(f), false); assert.equal(prefs.serverGlobalSearch(f), false);
  }
});

it('«Избранное» получает служебного собеседника и серверный поиск включается только своим cap', () => {
  // Ловит превращение saved в обычного пользователя и вызов нового endpoint на старом сервере.
  const saved = prefs.summaryToDm({ ...summary('self'), saved: true });
  assert.equal(saved.id, 'self');
  assert.equal(saved.otherUser.id, 'saved:self');
  assert.equal(saved.otherUser.displayName, 'Избранное');
  assert.equal(saved.otherUser.avatarUrl, null);
  assert.equal(saved.saved, true);
  assert.equal(prefs.serverSaved(['saved1', 'groups1']), true);
  for (const features of [undefined, null, [], ['saved1'], ['groups1'], ['srvsearch1']])
    assert.equal(prefs.serverSaved(features), false);
  assert.equal(prefs.serverServersSearch(['srvsearch1']), true);
  for (const features of [undefined, null, [], ['gsearch1'], ['search1']])
    assert.equal(prefs.serverServersSearch(features), false);

  const check = (api: typeof prefs) => {
    assert.equal(api.summaryToDm({ ...summary('self'), saved: true }).otherUser.id, 'saved:self');
    assert.equal(api.serverServersSearch(['srvsearch1']), true);
    assert.equal(api.serverServersSearch(['gsearch1']), false);
  };
  assert.throws(() => check(mutantSync("? { id: `saved:${s.id}`, username: '', displayName: SAVED_NAME, avatarUrl: null }", "? { id: s.id, username: '', displayName: SAVED_NAME, avatarUrl: null }")), assert.AssertionError,
    'мутант стирает служебный id и ломает особую беседу');
  assert.throws(() => check(mutantSync('return !!features?.includes(FEATURE_SRVSEARCH1);', 'return !!features?.includes(FEATURE_GSEARCH1);')), assert.AssertionError,
    'мутант включает поиск по серверам capability поиска по личным беседам');
});
it('архив переносится в DM, переживает старую сводку и повтор без изменения сохраняет identity', () => {
  // Ловит самопроизвольный возврат из архива после ответа сервера без нового поля.
  const check = (api: typeof prefs) => {
    const old = { ...summary('a'), archived: true }; const state = { ...api.emptyConvState(), summaries: { a: old } };
    assert.equal(api.summaryToDm(old).archived, true);
    assert.equal(api.patchConvArchived(state, 'a', true), state);
    assert.equal(api.patchConvArchived(state, 'missing', true), state);
    const cleared = api.patchConvArchived(state, 'a', false);
    assert.equal(cleared.summaries.a.archived, false); assert.equal(state.summaries.a.archived, true);
    assert.equal(api.keepChatPrefs(old, summary('a')).archived, true);
    assert.equal(api.keepChatPrefs(old, { ...summary('a'), archived: false }).archived, false);
    assert.equal(api.serverArchive(['archive1']), true);
    assert.equal(api.serverArchive(['conv13']), false); assert.equal(api.serverArchive(null), false);
  }; check(prefs);
  assert.throws(() => check(mutantSync('...(s.archived ? { archived: true } : {}),', '')), assert.AssertionError);
  assert.throws(() => check(mutantSync('return !!features?.includes(FEATURE_ARCHIVE1);', 'return !features?.includes(FEATURE_ARCHIVE1);')), assert.AssertionError);
});
it('пометка непрочитанного передаётся только при true, прочитать все уважает only и identity', () => {
  // Пометка без числа не должна застрять после чтения или исчезнуть в соседней беседе.
  const state = { ...prefs.emptyConvState(), summaries: { a: { ...summary('a', 2), markedUnread: true }, b: { ...summary('b'), markedUnread: true } } };
  assert.equal(prefs.summaryToDm(state.summaries.a).markedUnread, true);
  assert.equal(Object.hasOwn(prefs.summaryToDm({ ...state.summaries.a, markedUnread: false }), 'markedUnread'), false);
  assert.equal(prefs.patchConvUnreadMark(state, 'a', true), state);
  assert.equal(prefs.patchConvUnreadMark(state, 'missing', true), state);
  assert.equal(prefs.patchConvUnreadMark(state, 'a', false).summaries.a.markedUnread, false);
  const one = prefs.patchConvReadAll(state, 'a');
  assert.equal(one.summaries.a.unread, 0); assert.equal(one.summaries.a.markedUnread, false);
  assert.equal(one.summaries.b, state.summaries.b);
  const all = prefs.patchConvReadAll(one);
  assert.equal(all.summaries.b.markedUnread, false);
  assert.equal(prefs.patchConvReadAll(all), all);
});
it('повторный мьют сохраняет состояние, отличие soundOnly меняет только нужную сводку', () => {
  // Исправление R17: повтор события не должен перезаписывать кеш и перерисовывать весь список.
  const state = { ...prefs.emptyConvState(), summaries: { c: { ...summary('c'), muted: null } } };
  assert.equal(prefs.patchPeerMute(state, 'peer', null), state);
  const muted = { until: '2026-10-09T00:00:00Z', soundOnly: true };
  const set = prefs.patchPeerMute(state, 'peer', muted);
  assert.notEqual(set, state);
  assert.equal(prefs.patchPeerMute(set, 'peer', { ...muted }), set);
  const loud = prefs.patchPeerMute(set, 'peer', { ...muted, soundOnly: false });
  assert.notEqual(loud, set);
  assert.equal(loud.summaries.c.muted?.soundOnly, false);
  assert.equal(prefs.patchPeerMute(set, 'missing', null), set);
});

it('отсутствующие поля события сохраняют настройки, явное null снимает закреп и мьют', () => {
  // Смешанные версии сервера не должны снимать закреп при каждом сообщении, но снятие обязано дойти.
  const check = (api: typeof prefs) => {
    const prev = { ...summary('c'), pinnedAt: '2026-10-07', muted: { until: null }, markedUnread: true };
    assert.equal(api.keepChatPrefs(undefined, prev), prev);
    const oldEvent = api.keepChatPrefs(prev, summary('c'));
    assert.equal(oldEvent.pinnedAt, prev.pinnedAt); assert.equal(oldEvent.muted, prev.muted);
    assert.equal(oldEvent.markedUnread, true);
    const cleared = { ...summary('c'), pinnedAt: null, muted: null, markedUnread: false };
    assert.equal(api.keepChatPrefs(prev, cleared), cleared);
    const state = { ...emptyConvState(), summaries: { c: prev }, summaryPts: { c: 1 } };
    assert.equal(api.applySummary(state, summary('c'), 2).state.summaries.c.pinnedAt, prev.pinnedAt);
    assert.equal(api.applySummary(state, cleared, 2).state.summaries.c.pinnedAt, null);
  };
  check(prefs);
  assert.throws(() => check(mutantSync('if (!prev || (', 'if (prev) return prev; if (!prev || (')), assert.AssertionError);
});

it('оптимистичный закреп меняет только цель, мьют — только совместимые сводки нужного собеседника', () => {
  // Старый сервер без muted должен остаться на источнике из списка, а соседняя беседа не меняется.
  const modern = { ...summary('c'), muted: null };
  const legacy = summary('legacy');
  const other = { ...summary('other'), otherUser: { ...summary('c').otherUser!, id: 'other-peer' }, muted: null };
  const state = { ...emptyConvState(), summaries: { c: modern, legacy, other } };
  assert.equal(prefs.patchConvPinned(state, 'absent', 'date'), state);
  assert.equal(prefs.patchConvPinned(state, 'c', null), state);
  const pinned = prefs.patchConvPinned(state, 'c', 'date');
  assert.equal(prefs.patchConvPinned(pinned, 'c', 'date'), pinned);
  assert.equal(pinned.summaries.other, other);
  assert.equal(prefs.patchPeerMute(state, 'absent', null), state);
  const muted = prefs.patchPeerMute(state, 'peer', { until: null });
  assert.equal(muted.summaries.legacy, legacy); assert.equal(muted.summaries.other, other);
  assert.deepEqual(muted.summaries.c.muted, { until: null });
  assert.equal(prefs.patchPeerMute(muted, 'peer', null).summaries.c.muted, null);
});

it('прочтение прижимается к увиденному, пакет ждёт три секунды только до последнего ключа', () => {
  // Загруженный хвост нельзя отмечать прочитанным за пределами действительно показанных сообщений.
  const check = (api: typeof prefs) => {
    assert.equal(api.clampReadKey(10, undefined), null); assert.equal(api.clampReadKey(null, 10), null);
    assert.equal(api.clampReadKey(10, 5), 5); assert.equal(api.clampReadKey(5, 10), 5); assert.equal(api.clampReadKey(0, 0), 0);
    assert.equal(api.seenFlushDelay(9, 10), 3000); assert.equal(api.seenFlushDelay(10, 10), 0); assert.equal(api.seenFlushDelay(11, 10), 0);
    assert.equal(api.seenFlushDelay(10, null), 3000); assert.equal(api.seenFlushDelay(10, undefined), 3000);
  };
  check(prefs);
  assert.throws(() => check(mutantSync('Math.min(loadedKey, seenKey)', 'Math.max(loadedKey, seenKey)')), assert.AssertionError);
});

it('очистка чата включается только conv12, уход убирает окно и новая сводка возвращает строку', () => {
  // Старый сервер не понимает clear/hide, а устаревшее событие не должно воскресить удалённую строку.
  assert.equal(prefs.serverChatClear(['conv12']), true);
  for (const features of [null, undefined, [], ['conv11']]) assert.equal(prefs.serverChatClear(features), false);
  const state = prefs.applySummary(emptyConvState(), summary('c'), 1).state;
  const withWindow = { ...state, windows: { c: { basePts: 1, hasMoreBefore: false, hasMoreAfter: false } } };
  const gone = prefs.applySummary(withWindow, { id: 'c', left: true }, 2);
  assert.equal(gone.dropped, 'c'); assert.equal(gone.state.summaries.c, undefined); assert.equal(gone.state.windows.c, undefined);
  assert.equal(prefs.applySummary(gone.state, summary('c'), 1).state, gone.state);
  assert.equal(prefs.applySummary(gone.state, summary('c', 1), 3).state.summaries.c.unread, 1);
});

it('превью закрепа не добавляет длительность и показывает имя обычного файла', () => {
  // Кеш старого сервера и обычный mp4-файл не должны интерпретироваться по расширению вместо явного признака.
  const p = { text: '', attachments: 1, attachmentKind: 'file' as const, attachmentVideo: true as const, attachmentDurationMs: 42_000, attachmentName: 'clip.mp4' };
  assert.equal(pinPreview(p), 'Видео', 'превью списка не дублирует длительность видео');
  assert.equal(pinPreview({ ...p, attachmentVideo: undefined }), 'clip.mp4', 'имя файла не получает лишний префикс');
  for (const attachmentDurationMs of [0, -1, NaN, Infinity]) assert.equal(pinPreview({ ...p, attachmentDurationMs }), 'Видео');
});
import type { ConvMessage, ConvPin, ConvScheduled, ConvSummary } from '@gusvoice/shared';
import {
  applyEdited, applyList, applyMessage, applyPage, applyRemoved, applySent, applySummary,
  bufferEvent, drainPlan, emptyConvState, eventDecision, nextUnread, readKeyFor, seedUnread,
  patchPeer, summariesToDms, updateDrafts, remoteDraftDecision, serverKeepsDrafts, trimWindow, type ConvChangeEvent,
  serverSendsPeerRead, peerReadKeyOf, lacksPeerRead, withPeerRead,
  serverBatchActions,
  serverDeletesOthersForBoth,
  serverDmPins,
  applyPins, dropPins, DM_PINS_MAX, isPinLimit, pinPreview, pinWhenLabel,
  serverSilentSend, serverScheduled, applyScheduled, dropScheduled, scheduledCountOf, draftTextForServer,
} from './convSyncRules';

it('черновик режется до 4000, а emoji на границе переносится целиком за предел вместо половины пары', () => {
  // Серверу нельзя отправлять 5000 знаков из поля без лимита или одну половину UTF-16.
  assert.equal(draftTextForServer('x'.repeat(5000)), 'x'.repeat(4000));
  assert.equal(draftTextForServer('x'.repeat(3998) + '🙂' + 'y'), 'x'.repeat(3998) + '🙂');
  assert.equal(draftTextForServer('x'.repeat(3999) + '🙂'), 'x'.repeat(3999));
  assert.equal(draftTextForServer(''), '');
});

it('действия пачкой доступны только серверу с conv5', () => {
  // Ловит обещание пересылки старому серверу без ручки.
  assert.equal(serverBatchActions(['conv1','conv5']), true);
  for (const features of [[], ['conv1','conv4'], null, undefined]) assert.equal(serverBatchActions(features), false);
});

it('чужое «у обоих» включается только при признаке conv6', () => {
  // Клиент без этого признака получит 403 от старой ручки; пустой/неизвестный список не означает поддержку.
  assert.equal(serverDeletesOthersForBoth(['conv1', 'conv5', 'conv6']), true);
  for (const features of [[], ['conv5'], ['conv7'], null, undefined]) assert.equal(serverDeletesOthersForBoth(features), false);
});

it('закрепы ЛС включаются только при conv7, а пустые и неизвестные признаки остаются выключены', () => {
  // Ловит показ ручек закрепа на старом сервере и принятие незнакомой возможности за conv7.
  assert.equal(serverDmPins(['conv1', 'conv6', 'conv7']), true);
  assert.equal(serverDmPins(['conv7']), true);
  for (const features of [[], ['conv1', 'conv6'], ['unknown'], null, undefined]) {
    assert.equal(serverDmPins(features), false);
  }
});

it('тихая и отложенная отправки включаются только своими признаками conv8 и conv9', () => {
  // Ловит показ новой ручки старому серверу и смешение двух независимых возможностей.
  for (const [rule, own, other] of [[serverSilentSend, 'conv8', 'conv9'], [serverScheduled, 'conv9', 'conv8']] as const) {
    assert.equal(rule([own]), true);
    assert.equal(rule(['conv1', 'conv7', own]), true);
    for (const features of [undefined, null, [], [other], ['conv7'], ['unknown']]) assert.equal(rule(features), false);
  }
});

const msg = (id: string, sortKey: number, content = id): ConvMessage => ({
  id, sortKey, content, conversationId: 'c', channelId: 'c', authorId: 'a', clientId: null,
  attachments: [], reactions: [], editedAt: null, createdAt: '2026-01-01T00:00:00Z',
} as unknown as ConvMessage);
const summary = (id: string, unread = 0): ConvSummary => ({
  id, kind: 'direct', otherUser: { id: 'peer', username: 'peer', displayName: 'Peer', avatarUrl: null },
  createdAt: '2026-01-01T00:00:00Z', lastMessageAt: null, lastMessage: null, unread, lastReadKey: 0,
});
const event = (pts: number): ConvChangeEvent => ({ pts, conversations: [], messages: [] } as unknown as ConvChangeEvent);
const pin = (id: string): ConvPin => ({
  message: { id, authorId: 'peer', text: id, attachments: 0, sortKey: 1, createdAt: '2026-01-01T00:00:00Z' },
  forBoth: true, pinnedBy: 'peer', pinnedAt: '2026-01-01T00:00:00Z',
} as unknown as ConvPin);
const scheduled = (id: string): ConvScheduled => ({
  id, conversationId: 'c', clientId: `client-${id}`, content: id, replyTo: null, sendAt: '2026-10-06T09:00:00.000Z',
  whenOnline: false, createdAt: '2026-10-05T12:00:00.000Z', editedAt: null,
} as ConvScheduled);

describe('свежесть снимков отложенных сообщений', () => {
  // Событие или ответ отправки несёт весь список, поэтому свежий снимок заменяет его, а не дополняет.
  it('applyScheduled копирует полный список и принимает только строго больший pts', () => {
    const initial = emptyConvState();
    const input = [scheduled('first'), scheduled('second')];
    const old = applyScheduled(initial, 'c', input, 6);
    assert.deepEqual(old.scheduled?.c, { pts: 6, list: input }, 'первый снимок сохраняет номер и элементы');
    assert.ok(old.scheduled?.c.list !== input, 'внешний массив нельзя разделять со стором');
    const fresh = applyScheduled(old, 'c', [scheduled('latest')], 7);
    assert.deepEqual(fresh.scheduled?.c, { pts: 7, list: [scheduled('latest')] }, 'более свежая версия полностью заменяет прежний список');
    assert.ok(applyScheduled(fresh, 'c', [scheduled('same-pts')], 7) === fresh, 'равный pts не переигрывает собственное эхо');
    assert.ok(applyScheduled(fresh, 'c', [scheduled('old')], 6) === fresh, 'поздний ответ не возвращает уже удалённую запись');
    assert.deepEqual(fresh.scheduled?.c.list.map(item => item.id), ['latest'], 'в состоянии остаётся только актуальный полный снимок');
  });

  // Уход из беседы удаляет одну запись, а смена инстанса — все; отсутствие записи остаётся ссылочным no-op.
  it('dropScheduled удаляет одну или все беседы, не мутируя пустое состояние', () => {
    const one = applyScheduled(emptyConvState(), 'c', [scheduled('c1')], 1);
    const both = applyScheduled(one, 'other', [scheduled('o1')], 2);
    const remaining = dropScheduled(both, 'c');
    assert.deepEqual(Object.keys(remaining.scheduled ?? {}), ['other'], 'удаляется только покинутая беседа');
    assert.ok(dropScheduled(remaining, 'missing') === remaining, 'неизвестный ключ не создаёт новое состояние');
    const none = dropScheduled(remaining);
    assert.deepEqual(none.scheduled, {}, 'очистка без id забывает все расписания');
    assert.ok(dropScheduled(none) === none, 'повторная очистка — no-op');
    const empty = emptyConvState();
    assert.ok(dropScheduled(empty) === empty, 'состояние до первой загрузки не получает пустое поле scheduled');
  });

  // Пока ответ ещё не загружен, сводка даёт число для кнопки; известный список должен стать единственным источником.
  it('scheduledCountOf предпочитает список, использует сводку и безопасно обрабатывает мусор', () => {
    const summaryWithCount = { ...summary('c'), scheduledCount: 7 };
    assert.equal(scheduledCountOf(undefined, summaryWithCount), 7, 'до GET число берётся из сводки сервера');
    assert.equal(scheduledCountOf({ pts: 1, list: [scheduled('a'), scheduled('b')] }, summaryWithCount), 2, 'после загрузки список точнее сводки');
    assert.equal(scheduledCountOf({ pts: 2, list: [] }, summaryWithCount), 0, 'известный пустой список перебивает устаревший ненулевой счётчик');
    assert.equal(scheduledCountOf(undefined, summary('legacy') as ConvSummary), 0, 'сервер до conv9 без счётчика означает ноль');
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      assert.equal(scheduledCountOf(undefined, { ...summary('c'), scheduledCount: count } as never), 0, 'неположительное или неверно типизированное число не показывает вход');
    }
  });
});

describe('свежесть снимков закрепов', () => {
  // Списки от API — полные снимки; сохранение ссылки/входного массива смешало бы состояние между ответами.
  it('первый снимок создаёт отдельную запись и копирует список целиком', () => {
    const state = emptyConvState();
    const list = [pin('first'), pin('second')];
    const next = applyPins(state, 'c', list, 4);
    assert.ok(next !== state, 'новый снимок закрепов меняет состояние');
    assert.deepEqual(next.pins?.c, { pts: 4, list }, 'номер свежести и содержимое сохранены вместе');
    assert.ok(next.pins?.c.list !== list, 'изменение входного массива после вызова не должно менять снимок в сторе');
    assert.ok(state.pins === undefined, 'первое применение не мутирует исходное пустое состояние');
  });

  // Событие может опередить ответ загрузки; равный pts — эхо того же изменения, не новая версия.
  it('строго более свежий pts заменяет список, а равный или старый снимок игнорируется', () => {
    const first = applyPins(emptyConvState(), 'c', [pin('old')], 7);
    const fresh = applyPins(first, 'c', [pin('new')], 8);
    assert.deepEqual(fresh.pins?.c, { pts: 8, list: [pin('new')] }, 'новый снимок заменяет список, а не дописывает его');
    assert.ok(applyPins(fresh, 'c', [pin('equal')], 8) === fresh, 'равный pts не перезаписывает список');
    assert.ok(applyPins(fresh, 'c', [pin('stale')], 7) === fresh, 'запоздавший pts не откатывает список');
    assert.deepEqual(fresh.pins?.c.list.map(item => item.message.id), ['new'], 'в памяти остаётся только полный свежий список');
  });

  // Уход одной беседы и смена учётной записи имеют разный объём очистки, пустое состояние не должно обрастать полем.
  it('dropPins забывает выбранную беседу или все снимки без мутации соседей', () => {
    const c = applyPins(emptyConvState(), 'c', [pin('c-pin')], 1);
    const both = applyPins(c, 'other', [pin('other-pin')], 2);
    const one = dropPins(both, 'c');
    assert.ok(one !== both, 'удаление существующей записи создаёт новое состояние');
    assert.deepEqual(Object.keys(one.pins ?? {}), ['other'], 'удаление одной беседы сохраняет соседние списки');
    assert.ok(dropPins(one, 'missing') === one, 'повторное удаление отсутствующего списка сохраняет ссылку');
    const all = dropPins(one);
    assert.deepEqual(all.pins, {}, 'удаление без id очищает все известные списки');
    assert.ok(dropPins(all) === all, 'повторная очистка пустой карты — no-op');
    const empty = emptyConvState();
    assert.ok(dropPins(empty) === empty, 'пустое состояние без pins остаётся тем же объектом');
  });
});

describe('превью и подпись закрепа', () => {
  // Полоса уже показывает миниатюру отдельно, а список — нет: фото-подпись должна различаться только там.
  it('подпись фото остаётся текстом на полосе, а список явно помечает фото', () => {
    const photo = { text: '  отпуск  ', attachments: 1, attachmentKind: 'photo' } as Parameters<typeof pinPreview>[0];
    assert.equal(pinPreview(photo), 'отпуск', 'полоса не дублирует тип вложения рядом с миниатюрой');
    assert.equal(pinPreview(photo, true), 'Фото · отпуск', 'список помечает фото, потому что миниатюры в строке нет');
    assert.equal(pinPreview({ ...photo, text: '' }), 'Фото', 'фото без подписи получает понятный fallback');
  });

  // Неполная длительность/имя приходит для старых или повреждённых данных и не должна печатать NaN/пустое поле.
  it('голос и файл имеют безопасные fallback для недействительной длительности и пустого имени', () => {
    const voice = { text: '', attachments: 1, attachmentKind: 'voice' } as Parameters<typeof pinPreview>[0];
    assert.equal(pinPreview({ ...voice, attachmentDurationMs: 42_000 }), 'Голосовое сообщение', 'длительность не входит в короткое превью');
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(pinPreview({ ...voice, attachmentDurationMs: duration }), 'Голосовое сообщение', 'неположительная или нечисловая длительность не показывается');
    }
    const file = { text: '', attachments: 1, attachmentKind: 'file' } as Parameters<typeof pinPreview>[0];
    assert.equal(pinPreview({ ...file, attachmentName: ' report.pdf ' }), 'report.pdf', 'имя файла очищается от краевых пробелов без префикса');
    assert.equal(pinPreview({ ...file, attachmentName: '  ' }), 'Файл', 'пустое имя файла не оставляет двоеточие без значения');
  });

  // Старый сервер может прислать только число вложений и текст; тип неизвестного вложения также требует общей подписи.
  it('стикер, неизвестное вложение и сообщение без вложений получают отдельные fallback', () => {
    assert.equal(pinPreview({ text: 'подпись', attachments: 1, attachmentKind: 'sticker' } as Parameters<typeof pinPreview>[0]), 'Стикер', 'стикер не подменяется его техническим именем');
    assert.equal(pinPreview({ text: '', attachments: 1 } as Parameters<typeof pinPreview>[0]), 'Вложение', 'старые данные без типа не выглядят пустыми');
    assert.equal(pinPreview({ text: ' текст ', attachments: 1, attachmentKind: 'unknown' } as unknown as Parameters<typeof pinPreview>[0]), 'текст', 'неизвестный тип сохраняет доступную подпись');
    assert.equal(pinPreview({ text: ' ', attachments: 0 }), 'Сообщение', 'пустой текст без вложений получает нейтральную подпись');
  });

  // Время закрепления показывают относительно местного календарного дня, а не прошедших 24 часов.
  it('pinWhenLabel различает сегодня, вчера, другой день года и другой год', () => {
    const now = new Date(2026, 9, 5, 12, 0);
    const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min);
    const time = (date: Date) => new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(date);
    const today = at(2026, 9, 5, 18, 35);
    const yesterday = at(2026, 9, 4, 14, 10);
    const sameYear = at(2026, 8, 27, 18, 5);
    const otherYear = at(2025, 11, 31, 23, 59);
    assert.equal(pinWhenLabel(today.toISOString(), now), `сегодня, ${time(today)}`, 'сегодняшнее закрепление остаётся «сегодня» даже при будущем времени часов');
    assert.equal(pinWhenLabel(yesterday.toISOString(), now), `вчера, ${time(yesterday)}`, 'вчера определяется по местной календарной дате');
    assert.equal(pinWhenLabel(sameYear.toISOString(), now), `27 сентября, ${time(sameYear)}`, 'дата текущего года не повторяет год');
    assert.equal(pinWhenLabel(otherYear.toISOString(), now), `31 декабря 2025, ${time(otherYear)}`, 'прошлый год явно включается в подпись');
    assert.equal(pinWhenLabel('not-a-date', now), '', 'неразбираемая дата не попадает в список как Invalid Date');
  });

  // Серверный отказ зависит одновременно от точного статуса и сообщения; похожая ошибка не должна показать лимитный тост.
  it('лимит закрепов распознаётся только при точных 409 и pin limit', () => {
    assert.equal(DM_PINS_MAX, 50, 'текст тоста опирается на серверный предел списка');
    assert.equal(isPinLimit({ status: 409, message: 'pin limit' }), true, 'точный серверный отказ распознаётся');
    for (const error of [
      { status: 408, message: 'pin limit' }, { status: 410, message: 'pin limit' },
      { status: 409, message: 'other' }, { status: '409', message: 'pin limit' }, null, undefined,
    ]) assert.equal(isPinLimit(error), false, 'любой другой статус, текст или тип не маскируется под лимит закрепов');
  });
});

it('мутанты длительности и префикса не возвращают старый формат закрепа', () => {
  const video = { text: '', attachments: 1, attachmentKind: 'file' as const, attachmentVideo: true as const, attachmentDurationMs: 42_000, attachmentName: 'clip.mp4' };
  const voice = { text: '', attachments: 1, attachmentKind: 'voice' as const, attachmentDurationMs: 42_000 };
  const file = { text: '', attachments: 1, attachmentKind: 'file' as const, attachmentName: 'report.pdf' };
  const check = (api: typeof prefs) => {
    assert.equal(api.pinPreview(video), 'Видео');
    assert.equal(api.pinPreview(voice), 'Голосовое сообщение');
    assert.equal(api.pinPreview(file), 'report.pdf');
  };
  check(mutantSync("if (m.attachmentVideo === true) return 'Видео';", "if (m.attachmentVideo === true) return 'Видео';"));
  assert.throws(() => check(mutantSync("if (m.attachmentVideo === true) return 'Видео';", "if (m.attachmentVideo === true) return 'Видео · 0:42';")), assert.AssertionError,
    'возврат времени в видео меняет реальный pinPreview');
  assert.throws(() => check(mutantSync("return 'Голосовое сообщение';", "return 'Голосовое сообщение · 0:42';")), assert.AssertionError,
    'возврат времени в голосовое меняет реальный pinPreview');
  assert.throws(() => check(mutantSync("return name || 'Файл';", "return name ? `Файл: ${name}` : 'Файл';")), assert.AssertionError,
    'возврат префикса меняет реальный pinPreview');
});

describe('догонка бесед', () => {
  it('conv4 и поле прочтения отличаются от старого сервера и будущего вида беседы', () => {
    assert.equal(serverSendsPeerRead(['conv1', 'conv2', 'conv3']), false); assert.equal(serverSendsPeerRead(['conv4']), true);
    assert.equal(serverSendsPeerRead(null), false); assert.equal(serverSendsPeerRead(undefined), false);
    assert.equal(peerReadKeyOf({ ...summary('c'), peerReadKey: 10 }), 10);
    for (const s of [undefined, summary('c'), { ...summary('c'), peerReadKey: null }, { ...summary('c'), kind: 'group', peerReadKey: 10 } as never]) assert.equal(peerReadKeyOf(s), null);
  });
  it('перечитанный список дописывает только отсутствующий peerReadKey без отката прочих полей', () => {
    const s = { ...emptyConvState(), pts: 10, summaryPts: { c: 10 }, summaries: { c: summary('c', 5), existing: { ...summary('existing'), peerReadKey: 20 }, none: { ...summary('none'), peerReadKey: null } } };
    assert.equal(lacksPeerRead({}), false); assert.equal(lacksPeerRead(s.summaries), true);
    const next = withPeerRead(s, [{ ...summary('c'), peerReadKey: 30 }, { ...summary('existing'), peerReadKey: 99 }, { ...summary('none'), peerReadKey: 99 }, { ...summary('new'), peerReadKey: 1 }]);
    assert.equal(next.summaries.c.peerReadKey, 30); assert.equal(next.summaries.c.unread, 5);
    assert.equal(next.summaries.existing, s.summaries.existing); assert.equal(next.summaries.none, s.summaries.none);
    assert.equal(next.summaries.new, undefined); assert.equal(next.pts, s.pts); assert.equal(next.summaryPts, s.summaryPts);
    assert.equal(lacksPeerRead(next.summaries), false); assert.equal(withPeerRead(next, [summary('c')]), next);
    assert.equal(withPeerRead(s, [summary('c')]), s);
  });
  it('remote draft не затирает локальный при старом сервере, dirty и своём эхе', () => {
    const local = { text: 'новое', replyToId: null };
    const remote = { text: 'старое', replyToId: null, device: 'other', at: '2026-10-01T00:00:00Z' };
    for (const p of [{ remote: undefined, dirty: false }, { remote, dirty: true }, { remote: { ...remote, device: 'me' }, dirty: false }]) {
      assert.deepEqual(remoteDraftDecision({ ...p, local, device: 'me' }), { apply: false });
    }
    assert.equal(serverKeepsDrafts(['conv1', 'conv2']), false); assert.equal(serverKeepsDrafts(['conv3']), true);
    assert.equal(serverKeepsDrafts(null), false);
  });
  it('равный remote draft не обновляется, пробелы удаляют, ответ без текста принимается', () => {
    const remote = { text: 'x', replyToId: null, device: 'other', at: '2026-10-01T00:00:00Z' };
    assert.deepEqual(remoteDraftDecision({ remote, local: { text: 'x', replyToId: null }, dirty: false, device: 'me' }), { apply: false });
    assert.deepEqual(remoteDraftDecision({ remote: null, local: undefined, dirty: false, device: 'me' }), { apply: false });
    assert.deepEqual(remoteDraftDecision({ remote: { ...remote, text: ' \n ' }, local: { text: 'x', replyToId: null }, dirty: false, device: 'me' }), { apply: true, draft: null });
    assert.deepEqual(remoteDraftDecision({ remote: { ...remote, text: '', replyToId: 'm' }, local: undefined, dirty: false, device: 'me' }), { apply: true, draft: { text: '', replyToId: 'm' } });
  });
  it('jump заменяет окно, только у хвоста оставляет события новее снимка', () => {
    const s = { ...emptyConvState(), msgPts: { old: 1, event: 9 } };
    for (const hasMoreAfter of [true, false]) {
      const r = applyPage(s, [msg('old', 1), msg('event', 100)], 'c', { pts: 5, messages: [msg('page', 50)], hasMoreBefore: true, hasMoreAfter }, 'jump');
      assert.deepEqual(r.list.map((m) => m.id), hasMoreAfter ? ['page'] : ['page', 'event']);
      assert.deepEqual(r.state.windows.c, { basePts: 5, hasMoreBefore: true, hasMoreAfter });
    }
  });
  it('обрезка забывает свежесть срезанного, иначе старая порция потеряет возвращённую строку', () => {
    const s = { ...emptyConvState(), windows: { c: { basePts: 5, hasMoreBefore: false, hasMoreAfter: false } }, msgPts: { a: 9, b: 9 } };
    const list = [msg('a', 1), msg('b', 2)];
    const top = trimWindow(s, list, 'c', 'top', 1);
    assert.equal(top.state.msgPts.a, undefined); assert.equal(top.state.msgPts.b, 9); assert.equal(top.state.windows.c.hasMoreBefore, true);
    const p = { pts: 5, messages: [msg('a', 1)], hasMoreBefore: false, hasMoreAfter: false };
    assert.deepEqual(applyPage(top.state, top.list, 'c', p, 'older').list.map((m) => m.id), ['a', 'b']);
    // Контрфактическое старое состояние: номер отрезанного остался, а самой строки уже нет.
    assert.deepEqual(applyPage({ ...top.state, msgPts: s.msgPts }, top.list, 'c', p, 'older').list.map((m) => m.id), ['b']);
    assert.equal(trimWindow(s, list, 'c', 'bottom', 1).state.windows.c.hasMoreAfter, true);
    assert.equal(trimWindow(s, list, 'c', 'top', 2).state, s);
    assert.equal(trimWindow(emptyConvState(), list, 'c', 'top', 1).list.length, 2);
  });
  it('равный черновик и пустой ввод без прежнего черновика сохраняют тот же объект', () => {
    // Ловит перерисовку подписчиков всей ленты от пустого или повторного ввода.
    const drafts = { c: { text: 'текст', replyToId: 'm' } };
    assert.equal(updateDrafts(drafts, 'c', 'текст', 'm'), drafts);
    assert.equal(updateDrafts(drafts, 'other', ' \n ', null), drafts);
  });

  it('пробелы удаляют только свой черновик, а ответ без текста сохраняется', () => {
    // Ловит потерю выбранной цитаты или чужого черновика при очистке поля.
    const drafts = { c: { text: 'x', replyToId: null }, other: { text: 'другой', replyToId: null } };
    const removed = updateDrafts(drafts, 'c', ' \n ', null);
    assert.deepEqual(removed, { other: drafts.other });
    assert.equal(removed.other, drafts.other);
    assert.equal(drafts.c.text, 'x');
    const reply = updateDrafts(removed, 'c', ' ', 'message');
    assert.deepEqual(reply.c, { text: ' ', replyToId: 'message' });
  });
  it('событие на следующем номере применяется, повторы пропускаются, дыра запускает догонку', () => {
    // Ловит потерю события при перестановке доставки шлюзом.
    assert.equal(eventDecision({ pts: 8, phase: 'live' }, 9), 'apply');
    assert.equal(eventDecision({ pts: 8, phase: 'live' }, 8), 'skip');
    assert.equal(eventDecision({ pts: 8, phase: 'live' }, 10), 'gap');
    assert.equal(eventDecision({ pts: null, phase: 'idle' }, 1), 'buffer');
    assert.equal(eventDecision({ pts: 8, phase: 'syncing' }, 9), 'buffer');
  });

  it('буфер сортирует, не дублирует номер и останавливается на первой дыре', () => {
    // Ловит перескакивание пропущенной записи журнала после сетевого разрыва.
    const b = bufferEvent(bufferEvent(bufferEvent([], event(13)), event(11)), event(11));
    assert.deepEqual(b.map((x) => x.pts), [11, 13]);
    assert.deepEqual(drainPlan(10, [event(9), ...b]), { apply: [event(11)], rest: [event(13)], gap: true });
    assert.deepEqual(drainPlan(12, b), { apply: [event(13)], rest: [], gap: false });
  });

  it('старый снимок списка не убирает беседу из более свежего события', () => {
    // Ловит исчезновение новой беседы после позднего ответа начальной загрузки.
    const first = applySummary(emptyConvState(), summary('new'), 12).state;
    const merged = applyList(first, { pts: 10, conversations: [summary('old')] });
    assert.deepEqual(Object.keys(merged.summaries).sort(), ['new', 'old']);
    assert.equal(merged.summaryPts.new, 12);
  });

  it('выход удаляет беседу и окно, а старое событие не возвращает её', () => {
    // Ловит воскрешение беседы после ухода из неё.
    const state = applySummary(emptyConvState(), summary('c'), 1).state;
    state.windows.c = { basePts: 1, hasMoreBefore: false, hasMoreAfter: false };
    const left = applySummary(state, { id: 'c', left: true }, 3);
    assert.equal(left.dropped, 'c');
    assert.equal(left.state.summaries.c, undefined);
    assert.equal(left.state.windows.c, undefined);
    assert.equal(applySummary(left.state, summary('c'), 2).state, left.state);
  });

  it('снимок бывшей группы оставляет беседу и её ленту в режиме только чтение', () => {
    // Выход из группы не должен стирать уже загруженную историю, нужную бывшему участнику для чтения.
    const state = applySummary(emptyConvState(), summary('c'), 1).state;
    const window = { basePts: 9, hasMoreBefore: true, hasMoreAfter: false };
    state.windows.c = window;
    const former = { ...summary('c'), former: { at: '2026-10-08T12:00:00Z', removed: true } };
    const check = (api: typeof prefs) => {
      const result = api.applySummary(state, { id: 'c', left: true, former }, 2);
      assert.equal(result.dropped, null);
      assert.equal(result.state.summaries.c.former?.removed, true);
      assert.equal(result.state.windows.c, window, 'история не сбрасывается вместе со сводкой бывшего участника');
      assert.equal(result.state.summaryPts.c, 2);
    };
    check(prefs);
    check(mutantSync('if (isConvLeft(s) && s.former?.former && s.former.id === s.id)', 'if (isConvLeft(s) && s.former?.former && s.former.id === s.id)'));
    assert.throws(() => check(mutantSync('if (isConvLeft(s) && s.former?.former && s.former.id === s.id)', 'if (false)')), assert.AssertionError,
      'мутант обрабатывает выход бывшего участника как удаление беседы');
  });

  it('опоздавшее сообщение старше снимка не вставляется, но новое попадает в окно', () => {
    // Ловит «призрака» удалённого сообщения после свежей истории.
    const state = emptyConvState();
    state.windows.c = { basePts: 10, hasMoreBefore: false, hasMoreAfter: false };
    assert.deepEqual(applyMessage(state, [], msg('old', 1), 10).list, []);
    assert.deepEqual(applyMessage(state, [], msg('new', 2), 11).list?.map((x) => x.id), ['new']);
  });

  it('надгробие запоминается без окна и не воскресает при получении старой страницы', () => {
    // Ловит повторное появление скрытого или удалённого сообщения при открытии беседы.
    const removed = applyMessage(emptyConvState(), undefined, { id: 'gone', conversationId: 'c', gone: true }, 9);
    assert.equal(removed.state.gone.gone, true);
    const page = applyPage(removed.state, undefined, 'c', { pts: 8, messages: [msg('gone', 1)], hasMoreBefore: false, hasMoreAfter: false }, 'latest');
    assert.deepEqual(page.list, []);
  });

  it('запоздалая страница не откатывает сообщение из более свежего события', () => {
    // Ловит возврат прежнего текста после правки во время загрузки истории.
    const state = emptyConvState();
    state.windows.c = { basePts: 5, hasMoreBefore: false, hasMoreAfter: false };
    state.msgPts.m = 12;
    const got = applyPage(state, [msg('m', 1, 'новый')], 'c', { pts: 10, messages: [msg('m', 1, 'старый')], hasMoreBefore: false, hasMoreAfter: false }, 'latest');
    assert.equal(got.list[0].content, 'новый');
  });

  it('первый свежий хвост заменяет протухшее окно из кеша', () => {
    // Ловит сохранение устаревших ссылок и старой прокрутки после загрузки сети.
    const state = emptyConvState();
    state.windows.c = { basePts: 5, hasMoreBefore: true, hasMoreAfter: false, stale: true };
    state.msgPts.old = 5;
    const got = applyPage(state, [msg('old', 1)], 'c', { pts: 7, messages: [msg('new', 2)], hasMoreBefore: true, hasMoreAfter: false }, 'latest');
    assert.deepEqual(got.list.map((x) => x.id), ['new']);
    assert.equal(got.state.windows.c.stale, undefined);
  });

  it('смыкающийся свежий хвост сохраняет старую прокрутку, разрыв отбрасывает её', () => {
    // Ловит потерю загруженной истории и невидимую дыру между страницами.
    const state = emptyConvState();
    state.windows.c = { basePts: 5, hasMoreBefore: true, hasMoreAfter: false };
    for (const id of ['m1', 'm2', 'm3']) state.msgPts[id] = 5;
    const have = [msg('m1', 1), msg('m2', 2), msg('m3', 3)];
    const joins = applyPage(state, have, 'c', { pts: 7, messages: [msg('m3', 3), msg('m4', 4)], hasMoreBefore: true, hasMoreAfter: false }, 'latest');
    assert.deepEqual(joins.list.map((x) => x.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(joins.state.windows.c.hasMoreBefore, true);
    const gap = applyPage(state, have, 'c', { pts: 7, messages: [msg('m9', 9)], hasMoreBefore: true, hasMoreAfter: false }, 'latest');
    assert.deepEqual(gap.list.map((x) => x.id), ['m9']);
  });

  it('событие во время снимка остаётся новее страницы, older/newer двигают свои края', () => {
    // Ловит пропажу события за время HTTP-запроса и застрявший курсор нижнего края.
    const state = emptyConvState();
    state.windows.c = { basePts: 5, hasMoreBefore: true, hasMoreAfter: true };
    state.msgPts.m2 = 5;
    state.msgPts.m4 = 9;
    const latest = applyPage(state, [msg('m2', 2), msg('m4', 4)], 'c', { pts: 7, messages: [msg('m2', 2), msg('m3', 3)], hasMoreBefore: true, hasMoreAfter: false }, 'latest');
    assert.deepEqual(latest.list.map((x) => x.id), ['m2', 'm3', 'm4']);
    const older = applyPage(latest.state, latest.list, 'c', { pts: 8, messages: [msg('m1', 1)], hasMoreBefore: false, hasMoreAfter: true }, 'older');
    assert.equal(older.state.windows.c.hasMoreBefore, false);
    const newer = applyPage(older.state, older.list, 'c', { pts: 10, messages: [msg('m5', 5)], hasMoreBefore: true, hasMoreAfter: false }, 'newer');
    assert.equal(newer.state.windows.c.hasMoreAfter, false);
    assert.equal(newer.state.windows.c.basePts, 10);
  });

  it('сообщение вне частично загруженного окна не вставляется ни до, ни после него', () => {
    // Ловит ложное заполнение отсутствующего участка истории живым событием.
    const state = emptyConvState();
    state.windows.c = { basePts: 5, hasMoreBefore: true, hasMoreAfter: true };
    const have = [msg('middle', 5)];
    assert.deepEqual(applyMessage(state, have, msg('before', 4), 6).list, have);
    assert.deepEqual(applyMessage(state, have, msg('after', 6), 6).list, have);
    state.windows.c.hasMoreAfter = false;
    assert.deepEqual(applyMessage(state, have, msg('after', 6), 6).list?.map((x) => x.id), ['middle', 'after']);
  });

  it('ответ отправки не дублирует сообщение, а удаление запрещает его повторную вставку', () => {
    // Ловит двойную строку после 200/replay и воскрешение после удаления.
    const state = emptyConvState();
    const sent = applySent(state, [msg('one', 1)], msg('one', 1));
    assert.equal(sent.list?.length, 1);
    const removed = applyRemoved(state, [msg('one', 1)], 'one');
    assert.deepEqual(removed.list, []);
    assert.deepEqual(applySent(removed.state, [], msg('one', 1)).list, []);
  });

  it('поздний ответ правки не стирает более свежую правку и её реакции', () => {
    // Ловит откат текста и реакций из пришедшего события.
    const current = { ...msg('m', 1, 'новое'), editedAt: '2026-01-01T00:00:02Z', reactions: [{ emoji: '👍' }] } as unknown as ConvMessage;
    const old = { ...msg('m', 1, 'старое'), editedAt: '2026-01-01T00:00:01Z' };
    assert.equal(applyEdited([current], old)?.[0], current);
    const fresh = { ...old, editedAt: '2026-01-01T00:00:03Z', content: 'совсем новое' };
    assert.deepEqual(applyEdited([current], fresh)?.[0].reactions, current.reactions);
  });

  it('непрочитанное загорается только от чужой новинки вне экрана и гаснет от нулевой сводки', () => {
    // Ловит ложное зажигание от реакций и незатухающий индикатор после чтения на другом устройстве.
    assert.deepEqual(seedUnread({ c: summary('c', 2), d: summary('d', 1) }, 'c'), ['d']);
    assert.deepEqual(nextUnread([], summary('c', 2), false), []);
    assert.deepEqual(nextUnread([], summary('c', 2), true), ['c']);
    assert.deepEqual(nextUnread(['c'], summary('c', 0), true), []);
  });

  it('список сортируется по видимой свежести, удалённый собеседник остаётся строкой', () => {
    // Ловит исчезновение ЛС после обезличивания собеседника.
    const gone = { ...summary('gone'), otherUser: null };
    const newer = { ...summary('newer'), lastMessageAt: '2026-01-02T00:00:00Z' };
    const rows = summariesToDms({ gone, newer });
    assert.deepEqual(rows.map((x) => x.id), ['newer', 'gone']);
    assert.equal(rows[1].otherUser.displayName, 'Удалённый пользователь');
    assert.equal(readKeyFor([msg('m', 7)], undefined), 7);
    assert.equal(readKeyFor([], { ...summary('c'), lastMessage: { id: 'm', authorId: 'a', text: '', attachments: 0, sortKey: 5, createdAt: '' } }), 5);
  });

  it('смена имени и аватара правит только сводки нужного собеседника, не номер свежести', () => {
    // Ловит возврат старого имени при следующем событии беседы и ложную смену pts.
    const state = emptyConvState();
    state.summaries = { one: summary('one'), two: { ...summary('two'), otherUser: { id: 'else', username: 'else', displayName: 'Else', avatarUrl: null } }, gone: { ...summary('gone'), otherUser: null } };
    state.summaryPts = { one: 8, two: 9, gone: 10 };
    const changed = patchPeer(state, 'peer', 'Новое имя', 'avatar.png');
    assert.equal(changed.summaries.one.otherUser?.displayName, 'Новое имя');
    assert.equal(changed.summaries.one.otherUser?.avatarUrl, 'avatar.png');
    assert.equal(changed.summaries.two, state.summaries.two);
    assert.equal(changed.summaries.gone, state.summaries.gone);
    assert.equal(changed.summaryPts, state.summaryPts);
  });

  it('повтор того же профиля сохраняет тот же объект состояния', () => {
    // Ловит ненужные перерисовки списка на повторном user.update.
    const state = emptyConvState();
    state.summaries = { one: summary('one') };
    assert.equal(patchPeer(state, 'peer', 'Peer', null), state);
    assert.equal(patchPeer(state, 'missing', 'Nobody', null), state);
  });
});
