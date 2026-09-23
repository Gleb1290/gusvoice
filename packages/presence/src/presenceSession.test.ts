import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PresenceServerMessage } from '@gusvoice/shared';
import {
  classifyVisibility,
  createPresenceSocketSession,
  visibleChanged,
  type PresenceSessionDeps,
} from './presenceSession.js';

const snapshot = (visible: Set<string>): PresenceServerMessage => ({
  t: 'presence.snapshot',
  channels: Object.fromEntries([...visible].map((id) => [id, []])),
  occupied: {},
});

function harness(overrides: Partial<PresenceSessionDeps> = {}) {
  const sent: PresenceServerMessage[] = [];
  let closes = 0;
  let snapshots = 0;
  const deps: PresenceSessionDeps = {
    verifyToken: () => ({}),
    fetchVisible: async () => ({ outcome: 'ok', visible: new Set(['a']) }),
    snapshot: async (visible) => (snapshots += 1, snapshot(visible)),
    send: (msg) => void sent.push(msg),
    close: () => void (closes += 1),
    ...overrides,
  };
  const session = createPresenceSocketSession(deps);
  return { session, sent, closes: () => closes, snapshots: () => snapshots };
}

describe('классификация ответа видимости presence (#143)', () => {
  it('только 401 и 403 означают отозванную сессию', () => {
    // Ловит закрытие голосовых сокетов при выкладке или временной ошибке бэкенда.
    assert.equal(classifyVisibility(401), 'revoked');
    assert.equal(classifyVisibility(403), 'revoked');
    for (const status of [null, 0, 199, 300, 500, 502]) assert.equal(classifyVisibility(status), 'unavailable');
  });

  it('весь диапазон 2xx считается успешным', () => {
    // Парный принимающий случай ловит проверку только на один конкретный код 200.
    assert.equal(classifyVisibility(200), 'ok');
    assert.equal(classifyVisibility(204), 'ok');
    assert.equal(classifyVisibility(299), 'ok');
  });

  it('сравнение наборов игнорирует порядок, но замечает размер и замену элемента', () => {
    // Ловит лишние снимки после перестановки и пропуск замены при прежнем размере.
    assert.equal(visibleChanged(new Set(['a', 'b']), new Set(['b', 'a'])), false);
    assert.equal(visibleChanged(new Set(['a']), new Set(['a', 'b'])), true);
    assert.equal(visibleChanged(new Set(['a', 'b']), new Set(['a', 'c'])), true);
  });
});

describe('жизнь одного presence-сокета (#143)', () => {
  it('битый JWT закрывается с ошибкой до обращения к бэкенду', async () => {
    // Ловит принятие неподписанного токена или ненужную нагрузку видимостью для заведомо чужого клиента.
    let fetches = 0;
    const h = harness({ verifyToken: () => null, fetchVisible: async () => (fetches += 1, { outcome: 'ok', visible: new Set() }) });
    assert.equal(await h.session.identify('bad'), 'invalid-token');
    assert.deepEqual(h.sent, [{ t: 'error', message: 'invalid token' }]);
    assert.equal(h.closes(), 1);
    assert.equal(fetches, 0);
    assert.equal(h.session.token, null);
  });

  it('токен второго фактора не открывает presence-сессию', async () => {
    // Ловит превращение короткого 2FA challenge в полноценную авторизацию сокета.
    let fetches = 0;
    const h = harness({ verifyToken: () => ({ typ: '2fa' }), fetchVisible: async () => (fetches += 1, { outcome: 'ok', visible: new Set() }) });
    assert.equal(await h.session.identify('challenge'), 'invalid-token');
    assert.equal(h.closes(), 1);
    assert.equal(fetches, 0);
  });

  it('отозванный при identify токен закрывается и не сохраняется', async () => {
    // Ловит вечный опрос бэкенда мёртвым токеном после отказа 401/403.
    const h = harness({ fetchVisible: async () => ({ outcome: 'revoked' }) });
    assert.equal(await h.session.identify('revoked'), 'invalid-token');
    assert.equal(h.session.token, null);
    assert.equal(h.closes(), 1);
    assert.equal(h.snapshots(), 0);
  });

  it('успешный identify сохраняет токен и видимость, затем отправляет снимок именно этого набора', async () => {
    // Ловит снимок до установки прав или сохранение кандидата раньше успешной проверки.
    let seen: Set<string> | null = null;
    const h = harness({
      fetchVisible: async () => ({ outcome: 'ok', visible: new Set(['b', 'a']) }),
      snapshot: async (visible) => (seen = new Set(visible), snapshot(visible)),
    });
    assert.equal(await h.session.identify('good'), 'ok');
    assert.equal(h.session.token, 'good');
    assert.deepEqual(h.session.visible, new Set(['b', 'a']));
    assert.deepEqual(seen, new Set(['b', 'a']));
    assert.equal(h.sent[0]?.t, 'presence.snapshot');
  });

  it('недоступный backend при identify открывает пустую живую сессию', async () => {
    // Ловит ошибочное принятие временной недоступности за отзыв токена при первом подключении.
    const h = harness({ fetchVisible: async () => ({ outcome: 'unavailable' }) });
    assert.equal(await h.session.identify('good'), 'ok');
    assert.equal(h.session.token, 'good');
    assert.deepEqual(h.session.visible, new Set());
    assert.deepEqual(h.sent, [snapshot(new Set())]);
    assert.equal(h.snapshots(), 1);
    assert.equal(h.closes(), 0);
  });

  it('refresh до identify ничего не запрашивает', async () => {
    // Ловит фоновый запрос без токена и ошибочное закрытие ещё не представившегося сокета.
    let fetches = 0;
    const h = harness({ fetchVisible: async () => (fetches += 1, { outcome: 'ok', visible: new Set() }) });
    assert.equal(await h.session.refresh(), 'not-identified');
    assert.equal(fetches, 0);
    assert.equal(h.closes(), 0);
  });

  it('неизменный при refresh набор не создаёт и не отправляет новый снимок', async () => {
    // Ловит одинаковую тяжёлую рассылку каждые двадцать секунд из-за порядка элементов Set.
    let fetch = 0;
    const h = harness({ fetchVisible: async () => (++fetch === 1 ? { outcome: 'ok', visible: new Set(['a', 'b']) } : { outcome: 'ok', visible: new Set(['b', 'a']) }) });
    await h.session.identify('good');
    const sentBefore = h.sent.length;
    const snapshotsBefore = h.snapshots();
    assert.equal(await h.session.refresh(), 'unchanged');
    assert.equal(h.sent.length, sentBefore);
    assert.equal(h.snapshots(), snapshotsBefore);
  });

  it('изменившаяся видимость заменяет набор и отправляет новый снимок', async () => {
    // Ловит сохранение устаревших каналов после выдачи или отзыва прав посреди сессии.
    let fetch = 0;
    const h = harness({ fetchVisible: async () => (++fetch === 1 ? { outcome: 'ok', visible: new Set(['a']) } : { outcome: 'ok', visible: new Set(['b']) }) });
    await h.session.identify('good');
    assert.equal(await h.session.refresh(), 'changed');
    assert.deepEqual(h.session.visible, new Set(['b']));
    assert.equal(h.sent.length, 2);
  });

  it('отзыв сессии при refresh закрывает сокет без нового снимка', async () => {
    // Ловит продолжение presence после «выйти везде» или смены пароля.
    let fetch = 0;
    const h = harness({ fetchVisible: async () => (++fetch === 1 ? { outcome: 'ok', visible: new Set(['a']) } : { outcome: 'revoked' }) });
    await h.session.identify('good');
    assert.equal(await h.session.refresh(), 'revoked');
    assert.equal(h.closes(), 1);
    assert.equal(h.sent.length, 1);
  });

  it('недоступный backend сохраняет прежнюю видимость без снимка и разрыва', async () => {
    // Ловит стирание картины голосовых каналов пустым снимком во время выкладки API (#147).
    let fetch = 0;
    const h = harness({ fetchVisible: async () => (++fetch === 1 ? { outcome: 'ok', visible: new Set(['a', 'b']) } : { outcome: 'unavailable' }) });
    await h.session.identify('good');
    const sentBefore = h.sent.length;
    const snapshotsBefore = h.snapshots();
    assert.equal(await h.session.refresh(), 'unavailable');
    assert.deepEqual(h.session.visible, new Set(['a', 'b']));
    assert.equal(h.sent.length, sentBefore);
    assert.equal(h.snapshots(), snapshotsBefore);
    assert.equal(h.closes(), 0);
  });

  it('успешный пустой набор очищает прежнюю видимость и присылает пустой снимок', async () => {
    // Ловит смешение честного «каналов больше не видно» с временно недоступным backend.
    let fetch = 0;
    const h = harness({ fetchVisible: async () => (++fetch === 1 ? { outcome: 'ok', visible: new Set(['a', 'b']) } : { outcome: 'ok', visible: new Set() }) });
    await h.session.identify('good');
    assert.equal(await h.session.refresh(), 'changed');
    assert.deepEqual(h.session.visible, new Set());
    assert.deepEqual(h.sent[1], snapshot(new Set()));
    assert.equal(h.snapshots(), 2);
    assert.equal(h.closes(), 0);
  });
});
