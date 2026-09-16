import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyUnread, historyLoadPlan, seedReads, type UnreadState } from './channelRules.js';

const emptyState = (): UnreadState => ({
  unreadCounts: {},
  mentionCounts: {},
  unreadServers: {},
  mentionServers: {},
});

const bootstrap = (
  channelIds: string[],
  reads: Record<string, { unread: number; mentions: number }> = {},
): Parameters<typeof seedReads>[1] =>
  ({ channels: channelIds.map((id) => ({ id })), reads }) as unknown as Parameters<typeof seedReads>[1];

describe('учёт входящего сообщения', () => {
  it('событие старого бэкенда без serverId всё равно увеличивает канал', () => {
    // Ловит тихую потерю непрочитанного при рассинхроне версий клиента и сервера.
    const result = applyUnread(emptyState(), {
      channelId: 'c1',
      mentioned: false,
      currentServerId: 's1',
    });
    assert.deepEqual(result.unreadCounts, { c1: 1 });
    assert.deepEqual(result.unreadServers, {});
  });

  it('повторные сообщения и упоминания накапливаются независимо', () => {
    // Ловит перезапись существующего счётчика единицей вместо инкремента.
    const state: UnreadState = {
      unreadCounts: { c1: 4 },
      mentionCounts: { c1: 2 },
      unreadServers: {},
      mentionServers: {},
    };
    const result = applyUnread(state, {
      channelId: 'c1',
      mentioned: true,
      currentServerId: 's1',
    });
    assert.deepEqual(result.unreadCounts, { c1: 5 });
    assert.deepEqual(result.mentionCounts, { c1: 3 });
  });

  it('сообщение открытого сервера не ставит второй бейдж на его иконку', () => {
    // Ловит дублирование видимого канального счётчика ещё и на текущем сервере.
    const state = emptyState();
    const result = applyUnread(state, {
      channelId: 'c1',
      serverId: 's1',
      mentioned: true,
      currentServerId: 's1',
    });
    assert.strictEqual(result.unreadServers, state.unreadServers);
    assert.strictEqual(result.mentionServers, state.mentionServers);
  });

  it('сообщение чужого сервера увеличивает его серверные счётчики', () => {
    // Ловит исчезновение бейджа сервера, каналы которого сейчас не показаны в интерфейсе.
    const state: UnreadState = {
      unreadCounts: {},
      mentionCounts: {},
      unreadServers: { s2: 3 },
      mentionServers: { s2: 1 },
    };
    const result = applyUnread(state, {
      channelId: 'c2',
      serverId: 's2',
      mentioned: true,
      currentServerId: 's1',
    });
    assert.deepEqual(result.unreadServers, { s2: 4 });
    assert.deepEqual(result.mentionServers, { s2: 2 });
  });

  it('обычное сообщение чужого сервера не меняет счётчик упоминаний', () => {
    // Ловит ложный адресный бейдж у любого непрочитанного сообщения.
    const state = emptyState();
    const result = applyUnread(state, {
      channelId: 'c2',
      serverId: 's2',
      mentioned: false,
      currentServerId: 's1',
    });
    assert.deepEqual(result.unreadServers, { s2: 1 });
    assert.strictEqual(result.mentionServers, state.mentionServers);
  });
});

describe('восстановление счётчиков из bootstrap', () => {
  it('счётчики каналов других серверов сохраняются', () => {
    // Ловит потерю непрочитанного на остальных серверах при открытии одного из них.
    const result = seedReads(
      { unreadCounts: { foreign: 7 }, mentionCounts: { foreign: 2 } },
      bootstrap(['local'], { local: { unread: 3, mentions: 1 } }),
      null,
    );
    assert.deepEqual(result.unreadCounts, { foreign: 7, local: 3 });
    assert.deepEqual(result.mentionCounts, { foreign: 2, local: 1 });
  });

  it('старые счётчики текущего сервера заменяются точными числами сервера', () => {
    // Ловит прежнее схлопывание чисел в булеву точку и сохранение устаревших значений.
    const result = seedReads(
      { unreadCounts: { a: 99, b: 99 }, mentionCounts: { a: 99, b: 99 } },
      bootstrap(['a', 'b'], {
        a: { unread: 4, mentions: 2 },
        b: { unread: 0, mentions: 0 },
      }),
      null,
    );
    assert.deepEqual(result.unreadCounts, { a: 4 });
    assert.deepEqual(result.mentionCounts, { a: 2 });
  });

  it('открытый канал не становится непрочитанным заново', () => {
    // Ловит возврат бейджа сразу после того, как пользователь открыл и прочитал канал.
    const result = seedReads(
      { unreadCounts: {}, mentionCounts: {} },
      bootstrap(['open', 'other'], {
        open: { unread: 5, mentions: 3 },
        other: { unread: 2, mentions: 1 },
      }),
      'open',
    );
    assert.deepEqual(result.unreadCounts, { other: 2 });
    assert.deepEqual(result.mentionCounts, { other: 1 });
  });

  it('отсутствующий reads очищает старые данные текущего сервера', () => {
    // Ловит доверие локальному кешу вопреки серверной истине «всё прочитано».
    const result = seedReads(
      { unreadCounts: { local: 5, foreign: 4 }, mentionCounts: { local: 2, foreign: 1 } },
      bootstrap(['local']),
      null,
    );
    assert.deepEqual(result.unreadCounts, { foreign: 4 });
    assert.deepEqual(result.mentionCounts, { foreign: 1 });
  });
});

describe('план загрузки истории', () => {
  it('текстовый канал без кеша ждёт обязательную загрузку', () => {
    // Ловит показ пустого канала до прихода его первой истории.
    assert.deepEqual(historyLoadPlan({ channelType: 'text', hasCache: false }), {
      refetch: true,
      blocking: true,
    });
  });

  it('текстовый канал с кешем показывает его сразу, но обновляет в фоне', () => {
    // Ловит как сетевую задержку открытия, так и вечную дыру после потерянного message.create.
    assert.deepEqual(historyLoadPlan({ channelType: 'text', hasCache: true }), {
      refetch: true,
      blocking: false,
    });
  });

  it('голосовой и неизвестный типы историю сообщений не запрашивают', () => {
    // Ловит бессмысленный запрос истории для сущностей, у которых текстовой ленты нет.
    assert.deepEqual(historyLoadPlan({ channelType: 'voice', hasCache: false }), {
      refetch: false,
      blocking: false,
    });
    assert.deepEqual(historyLoadPlan({ hasCache: false }), { refetch: false, blocking: false });
  });
});
