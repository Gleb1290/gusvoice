import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyUnread, historyLoadPlan, isFeedOnScreen, seedReads, seedServerCounts, type UnreadState } from './channelRules.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const countSource = readFileSync(new URL('./channelRules.ts', import.meta.url), 'utf8');
function countsModule(anchor: string, replacement: string): typeof import('./channelRules') {
  assert.equal(countSource.split(anchor).length - 1, 1, 'единственный якорь');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(countSource.replace(anchor, replacement), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports as typeof import('./channelRules');
}

describe('R180 засев счётчиков серверов', () => {
  function maximum(fn = seedServerCounts) {
    const live = { unreadServers: { a: 5, b: 2 }, mentionServers: { a: 2, b: 5 } };
    const result = fn([{ id: 'a', unread: 3, mentions: 7 }, { id: 'b', unread: 7, mentions: 3 }], live, null);
    assert.equal(result.unreadServers.a, 5, 'max непрочитанных');
    assert.equal(result.unreadServers.b, 7, 'рост непрочитанных');
    assert.equal(result.mentionServers.a, 7, 'рост обращений');
    assert.equal(result.mentionServers.b, 5, 'max обращений');
    assert.deepEqual(live, { unreadServers: { a: 5, b: 2 }, mentionServers: { a: 2, b: 5 } });
  }
  function open(fn = seedServerCounts) {
    const live = { unreadServers: {}, mentionServers: {} };
    assert.equal(fn([{ id: 'open', unread: 9, mentions: 8 }], live, 'open') === live, true, 'открытый пропускается');
    assert.equal(fn([{ id: 'open', unread: 9, mentions: 8 }], live, null).unreadServers.open, 9);
  }
  function zero(fn = seedServerCounts) {
    const live = { unreadServers: {}, mentionServers: {} };
    assert.equal(fn([{ id: 'zero', unread: 0, mentions: 0 }], live, null) === live, true, 'нули не записываются');
  }
  it('живой и серверный максимум выбираются независимо в обеих картах без мутации входа', () => {
    // Поздний HTTP-ответ не должен уменьшать счётчик уже полученного события.
    maximum();
  });
  it('открытый сервер пропускается, тот же сервер вне открытого экрана получает счётчики', () => {
    // Иначе прочитанный сервер снова становится непрочитанным на холодном старте.
    open();
  });
  it('отсутствующие, нечисловые и неположительные счётчики не создают записей', () => {
    // Некорректный ответ не должен засорять карты нулём или бесконечным бейджем.
    for (const value of [undefined, NaN, 0, -1, Infinity, -Infinity, 0.99]) {
      const live = { unreadServers: { keep: 4 }, mentionServers: { keep: 2 } };
      assert.equal(seedServerCounts([{ id: 'bad', unread: value, mentions: value }], live, null) === live, true);
      assert.equal('bad' in live.unreadServers, false); assert.equal('bad' in live.mentionServers, false);
    }
    zero();
  });
  it('дроби округляются вниз, а единица сохраняется в обеих картах', () => {
    // Граница floor не должна создавать дробный бейдж или терять минимальное положительное число.
    const result = seedServerCounts([{ id: 'a', unread: 1, mentions: 1.99 }, { id: 'b', unread: 7.9, mentions: 2 }],
      { unreadServers: {}, mentionServers: {} }, null);
    assert.deepEqual(result, { unreadServers: { a: 1, b: 7 }, mentionServers: { a: 1, b: 2 } });
  });
  it('без роста сохраняется объект целиком, при росте копируется только изменённая карта', () => {
    // Лишние копии вызывают рендеры, а изменение общей карты портит предыдущий снимок стора.
    const live = { unreadServers: { a: 5 }, mentionServers: { a: 3 } };
    assert.equal(seedServerCounts([], live, null) === live, true);
    assert.equal(seedServerCounts([{ id: 'a', unread: 5, mentions: 2 }], live, null) === live, true);
    const u = seedServerCounts([{ id: 'a', unread: 6 }], live, null);
    assert.equal(u === live, false); assert.equal(u.unreadServers === live.unreadServers, false);
    assert.equal(u.mentionServers === live.mentionServers, true);
    const m = seedServerCounts([{ id: 'a', mentions: 4 }], live, null);
    assert.equal(m.unreadServers === live.unreadServers, true); assert.equal(m.mentionServers === live.mentionServers, false);
    assert.deepEqual(live, { unreadServers: { a: 5 }, mentionServers: { a: 3 } });
  });
  for (const [name, anchor, replacement, scenario, message] of [
    ['перезапись вместо максимума', 'if (u > (unreadServers[s.id] ?? 0))', 'if (u > 0)', maximum, 'max непрочитанных'],
    ['бейдж открытого сервера', 'if (s.id === currentServerId) continue;', 'if (false) continue;', open, 'открытый пропускается'],
    ['запись нулей', 'if (u > (unreadServers[s.id] ?? 0))', 'if (u >= (unreadServers[s.id] ?? 0))', zero, 'нули не записываются'],
  ] as const) it(`мутант «${name}» нарушает поведение засева`, () => {
    // Целый модуль и original-first отделяют ошибку контракта от ошибки VM-харнесса.
    scenario();
    assert.throws(() => scenario(countsModule(anchor, replacement).seedServerCounts),
      e => e instanceof assert.AssertionError && e.message.includes(message));
  });
});

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

describe('видимость ленты канала', () => {
  it('на компьютере выбранный канал всегда считается видимым', () => {
    // Ловит перенос мобильного правила на десктоп, где список и лента видны одновременно.
    assert.equal(isFeedOnScreen({ id: 'c1', currentId: 'c1', mobile: false, mobilePane: 'list' }), true);
  });

  it('на телефоне выбранный канал видим только на экране содержимого', () => {
    // Ловит потерю непрочитанного, пока человек смотрит список каналов телефона.
    assert.equal(isFeedOnScreen({ id: 'c1', currentId: 'c1', mobile: true, mobilePane: 'list' }), false);
    assert.equal(isFeedOnScreen({ id: 'c1', currentId: 'c1', mobile: true, mobilePane: 'content' }), true);
  });

  it('другой или отсутствующий текущий канал не считается видимым', () => {
    // Ловит отметку чужого канала прочитанным лишь из-за открытой ленты рядом.
    assert.equal(isFeedOnScreen({ id: 'c2', currentId: 'c1', mobile: false, mobilePane: 'content' }), false);
    assert.equal(isFeedOnScreen({ id: 'c1', currentId: null, mobile: false, mobilePane: 'content' }), false);
  });

  it('личная беседа видима только в разделе ЛС, а канал — только в разделе сервера', () => {
    // Ловит тихую отметку прочитанным у выбранной, но сейчас закрытой другим разделом ленты.
    const base = { id: 'same', currentId: 'same', mobile: false, mobilePane: 'content' as const };
    assert.equal(isFeedOnScreen({ ...base, kind: 'dm', view: 'server' }), false);
    assert.equal(isFeedOnScreen({ ...base, kind: 'dm', view: 'dm' }), true);
    assert.equal(isFeedOnScreen({ ...base, kind: 'channel', view: 'dm' }), false);
    assert.equal(isFeedOnScreen({ ...base, kind: 'channel', view: 'server' }), true);
  });
});

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
