import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DmChannel, Message } from '@gusvoice/shared';
import { applyDmDelete, dmIncomingDecision, mergeDmChannel, mergeDmUpdate, seedDmList } from './dmListRules.js';

const dm = (id: string, lastMessageAt: string | null, unread?: number): DmChannel => ({
  id,
  otherUser: { id: `u-${id}`, username: id, displayName: id, avatarUrl: null },
  createdAt: '2026-09-01T00:00:00.000Z',
  lastMessageAt,
  ...(unread === undefined ? {} : { unread }),
});

const message = (reactions?: Message['reactions']): Message => ({
  id: 'm1',
  channelId: 'dm1',
  author: { id: 'u1', username: 'u1', displayName: 'U1', avatarUrl: null },
  content: 'до',
  attachments: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  editedAt: null,
  reactions: reactions ?? [],
  replyTo: null,
});

describe('список личных бесед', () => {
  it('удаление последнего сообщения возвращает беседу на прежнее место', () => {
    // Ловит применение правила mergeDmChannel, которое не допускает законного уменьшения времени.
    const result = applyDmDelete(
      [dm('first', '2026-09-20T13:00:00.000Z', 1), dm('second', '2026-09-20T12:00:00.000Z')],
      ['first'], 'first', { lastMessageAt: '2026-09-20T11:00:00.000Z' }, null,
    );
    assert.deepEqual(result.dms.map((d) => d.id), ['second', 'first']);
    assert.equal(result.dms[1]?.lastMessageAt, '2026-09-20T11:00:00.000Z');
    assert.equal(applyDmDelete(result.dms, result.unreadDms, 'first', { lastMessageAt: null }, null).dms[1]?.lastMessageAt, null);
  });

  it('новое число после удаления ставит и снимает флаг непрочитанного', () => {
    // Ловит залипшую единицу после удаления единственного непрочитанного сообщения.
    const start = [dm('one', null, 2)];
    const cleared = applyDmDelete(start, ['one'], 'one', { unread: 0 }, null);
    assert.equal(cleared.dms[0]?.unread, 0);
    assert.deepEqual(cleared.unreadDms, []);
    const raised = applyDmDelete(cleared.dms, cleared.unreadDms, 'one', { unread: 1 }, null);
    assert.equal(raised.dms[0]?.unread, 1);
    assert.deepEqual(raised.unreadDms, ['one']);
  });

  it('удаление на открытом экране не возвращает серверное непрочитанное', () => {
    // Ловит краткую вспышку счётчика, пока запаздывает отметка прочитанного.
    const result = applyDmDelete([dm('open', null, 0)], [], 'open', { unread: 3 }, 'open');
    assert.equal(result.dms[0]?.unread, 0);
    assert.deepEqual(result.unreadDms, []);
  });

  it('старое событие без полей и отсутствующая беседа не портят список', () => {
    // Ловит очистку времени старым сервером и падение на событии удалённой из списка беседы.
    const source = [dm('one', '2026-09-20T10:00:00.000Z', 2)];
    assert.deepEqual(applyDmDelete(source, ['one'], 'one', {}, null), { dms: source, unreadDms: ['one'] });
    assert.deepEqual(applyDmDelete(source, ['one'], 'missing', { unread: 0 }, null), { dms: source, unreadDms: ['one'] });
  });
  it('событие без unread сохраняет счётчик и не откатывает время', () => {
    // Ловит замену записи целиком: следующий dm.create снова считал бы непрочитанное от нуля.
    const result = mergeDmChannel(
      [dm('same', '2026-09-20T12:00:00.000Z', 5)],
      dm('same', '2026-09-20T11:00:00.000Z'),
    );
    assert.equal(result[0]?.unread, 5);
    assert.equal(result[0]?.lastMessageAt, '2026-09-20T12:00:00.000Z');
  });

  it('новая и обновлённая беседы сортируются по настоящей свежести', () => {
    // Ловит добавление новой беседы в фиксированное место и неверный порядок после позднего события.
    const old = dm('old', '2026-09-20T10:00:00.000Z', 1);
    const newer = dm('new', '2026-09-20T12:00:00.000Z');
    assert.deepEqual(mergeDmChannel([old], newer).map((d) => d.id), ['new', 'old']);
    assert.deepEqual(
      mergeDmChannel([newer, old], dm('old', '2026-09-20T13:00:00.000Z')).map((d) => d.id),
      ['old', 'new'],
    );
  });

  it('загрузка списка гасит только открытую беседу и собирает остальные числа', () => {
    // Ловит мигающий счётчик прямо под читающим и потерю непрочитанного в соседней беседе.
    const result = seedDmList([dm('open', null, 3), dm('other', null, 2), dm('read', null, 0)], 'open');
    assert.equal(result.dms.find((d) => d.id === 'open')?.unread, 0);
    assert.deepEqual(result.unreadDms, ['other']);
  });

  it('null не исключает из непрочитанного ни одну беседу', () => {
    // Ловит случай старта на серверном экране, когда выбранный когда-то dm ошибочно считается прочитанным.
    assert.deepEqual(seedDmList([dm('one', null, 1), dm('two', null, 2)], null).unreadDms.sort(), ['one', 'two']);
  });
});

describe('обновление личного сообщения', () => {
  it('правка сохраняет уже видимые реакции, а без них принимает реакции ответа', () => {
    // Ловит превращение моей реакции в чужую из-за ответа, собранного глазами редактора.
    const previous = message([{ emoji: '👍', count: 1, me: true }]);
    const incoming = { ...message([{ emoji: '🔥', count: 2, me: false }]), content: 'после' };
    assert.deepEqual(mergeDmUpdate(previous, incoming).reactions, previous.reactions);
    assert.deepEqual(mergeDmUpdate({ ...previous, reactions: undefined as never }, incoming).reactions, incoming.reactions);
  });
});

describe('решение по входящему ЛС', () => {
  it('своё эхо не считается, не читается и не уведомляет', () => {
    // Ловит двойной счётчик и звук от собственного сообщения с другого устройства.
    assert.deepEqual(dmIncomingDecision({ mine: true, onScreen: false, focused: false, dnd: false }), {
      countUnread: false,
      markRead: false,
      sound: false,
      osNotify: false,
    });
  });

  it('видимое в активном окне только отмечается прочитанным', () => {
    // Ловит Б8: собеседник отвечает на глазах, а клиент всё равно играет звук.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: true, focused: true, dnd: false }), {
      countUnread: false,
      markRead: true,
      sound: false,
      osNotify: false,
    });
  });

  it('открытая беседа в свёрнутом окне остаётся непрочитанной и уведомляет', () => {
    // Ловит тихую отметку прочитанным, когда лента формально открыта, но человек её не видит.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: true, focused: false, dnd: false }), {
      countUnread: true,
      markRead: false,
      sound: true,
      osNotify: true,
    });
  });

  it('сообщение вне экрана считается и уведомляет, а DND глушит только шум', () => {
    // Ловит режим «не беспокоить», который вместе со звуком теряет сам счётчик сообщения.
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: false, focused: true, dnd: false }), {
      countUnread: true,
      markRead: false,
      sound: true,
      osNotify: true,
    });
    assert.deepEqual(dmIncomingDecision({ mine: false, onScreen: false, focused: false, dnd: true }), {
      countUnread: true,
      markRead: false,
      sound: false,
      osNotify: false,
    });
  });
});
