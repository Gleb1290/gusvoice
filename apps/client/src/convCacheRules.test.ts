import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConvMessage, ConvSummary } from '@gusvoice/shared';
import {
  acceptRecord, buildRecord, CACHE_GONE, CACHE_MESSAGES, CACHE_WINDOWS, CONV_CACHE_SCHEMA,
  cacheWipeOnRemove, convCacheKey, hydrateState, shouldOverwrite, stripAttachmentUrls, withoutMessages,
} from './convCacheRules';
import { emptyConvState } from './convSyncRules';

const summary = (id: string): ConvSummary => ({
  id, kind: 'direct', otherUser: null, createdAt: `2026-01-${id.padStart(2, '0')}T00:00:00Z`,
  lastMessageAt: null, lastMessage: null, unread: 0, lastReadKey: 0,
});
const msg = (id: string): ConvMessage => ({
  id, conversationId: 'c', sortKey: Number(id.replace(/\D/g, '')) || 1,
  attachments: [], content: id,
} as unknown as ConvMessage);
const record = () => ({ v: CONV_CACHE_SCHEMA, pts: 3, savedAt: 1, summaries: [summary('c')], messages: {}, gone: [] });

it('кеш удаляет подписанный thumb цитаты даже без файлов, сохраняя остальные поля и исходник', () => {
  // Ссылка миниатюры зависит от смотрящего и срока подписи: её нельзя восстановить как постоянный URL.
  const replyTo = { id: 'quoted', authorName: 'Peer', content: '', attachmentKind: 'photo' as const, attachments: 2, thumb: 'https://files.test/signed' };
  const m = { ...msg('1'), replyTo };
  const clean = stripAttachmentUrls(m);
  assert.notEqual(clean, m);
  assert.ok(clean.replyTo && !Object.hasOwn(clean.replyTo, 'thumb'), 'поле thumb полностью отсутствует');
  const { thumb: _thumb, ...expected } = replyTo;
  assert.deepEqual(clean.replyTo, expected);
  assert.equal(m.replyTo.thumb, 'https://files.test/signed');
  assert.equal(stripAttachmentUrls(clean), clean, 'без временных ссылок повторная очистка не копирует сообщение');
});

it('кеш сохраняет происхождение пересланного и отбрасывает только битое сообщение', () => {
  // Ловит потерю автора после перезапуска и отбрасывание всей ленты из-за одного поля.
  const forwardedFrom = { userId: 'peer', displayName: 'Кот', at: '2026-10-04T12:00:00Z' };
  const good = (id: string) => ({ ...msg(id), author: { id: 'peer' }, createdAt: forwardedFrom.at, reactions: [] });
  const messages = [good('1'), { ...good('2'), forwardedFrom }, { ...good('3'), forwardedFrom: null },
    { ...good('4'), forwardedFrom: { ...forwardedFrom, displayName: 7 } },
    { ...good('5'), forwardedFrom: { userId: 'peer', displayName: 'Кот' } }];
  const accepted = acceptRecord({ ...record(), messages: { c: messages } }); assert.ok(accepted);
  const restored = hydrateState(accepted).messages.c;
  assert.deepEqual(restored.map(m => m.id), ['1','2','3']);
  assert.deepEqual(restored[1].forwardedFrom, forwardedFrom);
});

describe('кеш личных бесед', () => {
  it('peerReadKey сохраняет число, null и отсутствие поля без подмены старого сервера', () => {
    // Ловит потерю ✓✓ при подъёме кеша и ложный ноль вместо отсутствующего поля до conv4.
    const r = acceptRecord({ ...record(), summaries: [{ ...summary('c'), peerReadKey: 20 }, { ...summary('d'), peerReadKey: null }, summary('old')] });
    assert.ok(r); const state = hydrateState(r).conv;
    assert.equal(state.summaries.c.peerReadKey, 20); assert.equal(state.summaries.d.peerReadKey, null);
    assert.equal(Object.hasOwn(state.summaries.old, 'peerReadKey'), false);
  });
  it('места и dirty переживают кеш, битые элементы отбрасываются по одному', () => {
    const r = acceptRecord({ ...record(), places: { c: { messageId: 'm', offset: -4 }, bad: { messageId: 'x', offset: Infinity }, nil: null }, draftDirty: ['c', 7, null] });
    assert.ok(r); assert.deepEqual(r.places, { c: { messageId: 'm', offset: -4 } }); assert.deepEqual(r.draftDirty, ['c']);
    const state = { ...emptyConvState(), pts: 1 };
    const built = buildRecord(state, {}, 1, [], {}, r.places, ['c']); assert.ok(built);
    assert.deepEqual(built.places, r.places); assert.deepEqual(built.draftDirty, ['c']);
  });
  it('середина ленты не сохраняется как ложный хвост, настоящий хвост остаётся', () => {
    const state = { ...emptyConvState(), pts: 1, summaries: { c: summary('c'), tail: summary('tail') }, windows: {
      c: { basePts: 1, hasMoreBefore: true, hasMoreAfter: true },
      tail: { basePts: 1, hasMoreBefore: true, hasMoreAfter: false },
    } };
    const saved = buildRecord(state, { c: [msg('1')], tail: [msg('2')] }, 1); assert.ok(saved);
    assert.deepEqual(Object.keys(saved.messages), ['tail']);
  });
  it('ключ разделяет людей и предпочитает федеративный id адресу с разным регистром и slash', () => {
    // Ловит показ чужого кеша при смене аккаунта или адреса одного инстанса.
    assert.equal(convCacheKey({ federationInstanceId: '  NODE-1/ ', apiUrl: 'https://old' }, 'https://fallback', 'u'), 'node-1|u');
    assert.equal(convCacheKey({ apiUrl: 'HTTPS://API.EXAMPLE/' }, 'https://fallback', 'u'), 'https://api.example|u');
    assert.notEqual(convCacheKey(null, 'https://api', 'u'), convCacheKey(null, 'https://api', 'v'));
  });

  it('до списка снимка нет, а равный номер разрешает добавить загруженную ленту', () => {
    // Ловит запись кеша с неизвестным pts и потерю лент от другой вкладки на равном номере.
    assert.equal(buildRecord(emptyConvState(), {}, 1), null);
    assert.equal(shouldOverwrite({ pts: 4 }, { pts: 4 }), true);
    assert.equal(shouldOverwrite({ pts: 5 }, { pts: 4 }), false);
    assert.equal(shouldOverwrite(null, { pts: 0 }), true);
  });

  it('закрытая ссылка исчезает из снимка, а старое публичное вложение остаётся', () => {
    // Ловит сохранение bearer-ссылки на диске и потерю публичных вложений.
    const input = { ...msg('m'), attachments: [
      { id: 'att', url: 'https://api/att/secret' }, { url: 'https://cdn/public' },
    ] } as unknown as ConvMessage;
    const out = stripAttachmentUrls(input);
    assert.equal(out.attachments[0].url, '');
    assert.equal(out.attachments[1].url, 'https://cdn/public');
    assert.equal(input.attachments[0].url, 'https://api/att/secret');
  });

  it('снимок ограничивает число окон, длину хвоста и память о стёртых сообщениях', () => {
    // Ловит безграничный рост дисковой записи на долгоживущем клиенте.
    const state = emptyConvState();
    state.pts = 8;
    const messages: Record<string, ConvMessage[]> = {};
    for (let i = 1; i <= CACHE_WINDOWS + 1; i++) {
      const id = String(i);
      state.summaries[id] = summary(id);
      state.windows[id] = { basePts: 8, hasMoreBefore: false, hasMoreAfter: false };
      messages[id] = Array.from({ length: CACHE_MESSAGES + 1 }, (_, n) => msg(`m${n}`));
    }
    for (let i = 0; i <= CACHE_GONE; i++) state.gone[`gone${i}`] = true;
    const saved = buildRecord(state, messages, 10);
    assert.ok(saved);
    assert.equal(Object.keys(saved.messages).length, CACHE_WINDOWS);
    assert.ok(Object.values(saved.messages).every((list) => list.length === CACHE_MESSAGES));
    assert.equal(saved.gone.length, CACHE_GONE);
    assert.equal(saved.gone[0], 'gone1');
    assert.deepEqual(withoutMessages(saved).messages, {});
    assert.equal(withoutMessages(saved).pts, 8);
  });

  it('чужая схема, нецелый номер и битая форма выбрасываются, старая запись без новых полей читается', () => {
    // Ловит применение несовместимого кеша вместо свежей загрузки с сервера.
    assert.equal(acceptRecord({ ...record(), v: CONV_CACHE_SCHEMA + 1 }), null);
    assert.equal(acceptRecord({ ...record(), pts: 1.5 }), null);
    assert.equal(acceptRecord({ ...record(), pts: -1 }), null);
    assert.equal(acceptRecord({ ...record(), summaries: null }), null);
    assert.deepEqual(acceptRecord(record())?.outbox, []);
    assert.deepEqual(acceptRecord(record())?.drafts, {});
  });

  it('битые элементы очереди отбрасываются по одному, корректный сохраняется', () => {
    // Ловит потерю всей очереди из-за одного повреждённого элемента.
    const item = { key: 'k', convId: 'c', content: 'x', fileNames: [], uploaded: [], status: 'sending', attempts: 0, retryAt: 0 };
    const got = acceptRecord({ ...record(), outbox: [null, {}, item] });
    assert.deepEqual(got?.outbox, [item]);
  });

  it('битая сводка и сообщение не обрушивают подъём соседних годных строк', () => {
    // Ловит бесконечный сбой запуска на одной повреждённой записи IndexedDB.
    const goodMessage = { ...msg('m1'), author: { id: 'a' }, createdAt: '2026-01-01T00:00:00Z', reactions: [] };
    const accepted = acceptRecord({ ...record(), summaries: [null, summary('c')], messages: { c: [null, goodMessage] }, gone: [1, 'dead'] });
    assert.ok(accepted);
    assert.deepEqual(accepted.summaries.map((x) => x.id), ['c']);
    assert.deepEqual(accepted.messages.c.map((x) => x.id), ['m1']);
    assert.deepEqual(accepted.gone, ['dead']);
    assert.doesNotThrow(() => hydrateState(accepted));
    assert.deepEqual(acceptRecord({ ...record(), summaries: [null], messages: { c: [null] } })?.messages.c, []);
  });

  it('битая исходящая не мешает восстановить годную очередь', () => {
    // Ловит вечное «отправляется» без status и неверные индексы потерянных файлов.
    const good = { key: 'ok', convId: 'c', content: 'x', fileNames: ['a'], uploaded: [{ id: 'att' }], status: 'sending', attempts: 1 };
    const broken = [{ ...good, status: 'waiting' }, { ...good, attempts: Infinity }, { ...good, fileNames: [1] }, { ...good, uploaded: [{}] }];
    assert.deepEqual(acceptRecord({ ...record(), outbox: [...broken, good] })?.outbox, [good]);
  });

  it('черновики принимают только верную форму, текст режется на 4000 символах', () => {
    // Ловит падение поля ввода на повреждённом кеше и безграничный черновик.
    const drafts = { good: { text: 'x'.repeat(4001), replyToId: null }, reply: { text: 'ok', replyToId: 'm' },
      wrong: { text: 1, replyToId: null }, missing: { text: 'x' }, broken: null };
    const got = acceptRecord({ ...record(), drafts })?.drafts;
    assert.equal(got?.good.text.length, 4000);
    assert.deepEqual(got?.reply, { text: 'ok', replyToId: 'm' });
    assert.equal(got?.wrong, undefined);
    assert.equal(got?.missing, undefined);
    assert.equal(got?.broken, undefined);
  });

  it('первый кадр из кеша помечает окна протухшими и не оживляет чужую ленту', () => {
    // Ловит показ старых ссылок и сообщений беседы, исчезнувшей из списка.
    const r = { ...record(), messages: { c: [msg('m2'), msg('m1')], other: [msg('m3')] }, gone: ['dead'] };
    const hydrated = hydrateState(r);
    assert.deepEqual(hydrated.messages.c.map((x) => x.id), ['m1', 'm2']);
    assert.equal(hydrated.messages.other, undefined);
    assert.equal(hydrated.conv.windows.c.stale, true);
    assert.equal(hydrated.conv.msgPts.m1, 3);
    assert.equal(hydrated.conv.gone.dead, true);
  });

  it('удаление последней записи сервера стирает весь кеш инстанса, а не один аккаунт', () => {
    // Ловит оставшиеся личные сообщения после удаления сервера из реестра.
    const removed = [{ federationInstanceId: ' NODE-1/ ', apiUrl: 'https://old', userId: 'a' }];
    assert.deepEqual(cacheWipeOnRemove(removed, []), { instances: [' NODE-1/ '], keys: [] });
    assert.deepEqual(cacheWipeOnRemove([{ userId: 'a' }], []), { instances: [], keys: [] });
  });

  it('при второй записи того же сервера стирается только ушедший человек, общий остаётся', () => {
    // Ловит удаление черновиков действующего аккаунта при удалении лишней записи в реестре.
    const removed = [{ federationInstanceId: 'NODE-1/', apiUrl: 'https://old', userId: 'a' }];
    const other = [{ federationInstanceId: 'node-1', apiUrl: 'https://new', userId: 'b' }];
    assert.deepEqual(cacheWipeOnRemove(removed, other), { instances: [], keys: ['node-1|a'] });
    assert.deepEqual(cacheWipeOnRemove(removed, [{ ...other[0], userId: 'a' }]), { instances: [], keys: [] });
    assert.deepEqual(cacheWipeOnRemove(
      [{ apiUrl: 'HTTPS://VOICE.EXAMPLE.TEST/api/', userId: 'a' }],
      [{ apiUrl: 'https://voice.example.test/api', userId: 'b' }],
    ), { instances: [], keys: ['https://voice.example.test/api|a'] });
  });
});
