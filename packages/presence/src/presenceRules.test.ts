import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PresenceMap } from '@gusvoice/shared';
import { TrackSource } from 'livekit-server-sdk';
import {
  admitFrame,
  admitSocket,
  buildParticipantList,
  clientIpFrom,
  mapParticipant,
  newSocketBudget,
  PRESENCE_WS_LIMITS,
  type PresenceParticipant,
  visibleSnapshot,
} from './presenceRules.js';

const participant = (
  identity: string,
  patch: Partial<PresenceParticipant> = {},
): PresenceParticipant => ({ identity, name: identity, tracks: [], ...patch });
const track = (source: TrackSource, muted = false) => ({ source, muted });

describe('фильтрация presence по видимым каналам', () => {
  const map: PresenceMap = { public: [], private: [] };

  it('пустой набор видимости возвращает пустую карту', () => {
    // Ловит выдачу полной presence-карты пользователю без доступных голосовых каналов.
    assert.deepEqual(visibleSnapshot(map, new Set()), {});
  });

  it('невидимый существующий канал исключается, а видимый сохраняется', () => {
    // Ловит раскрытие состава приватного канала рядом с разрешённым.
    assert.deepEqual(visibleSnapshot(map, new Set(['public'])), { public: [] });
  });

  it('видимый id без записи в snapshot не создаёт выдуманный пустой канал', () => {
    // Ловит отличие «канал не активен» от реально полученной пустой presence-записи.
    assert.deepEqual(visibleSnapshot(map, new Set(['missing'])), {});
  });
});

describe('отображение участника LiveKit', () => {
  it('переносит метаданные, mute/deafen и опубликованные источники', () => {
    // Ловит потерю аватара или неверные индикаторы камеры, экрана и серверного мута.
    assert.deepEqual(
      mapParticipant(
        participant('u1', {
          name: 'Маша',
          metadata: JSON.stringify({ avatarUrl: 'https://media/avatar.png' }),
          attributes: { deafened: '1' },
          tracks: [
            track(TrackSource.MICROPHONE, true),
            track(TrackSource.CAMERA),
            track(TrackSource.SCREEN_SHARE),
          ],
        }),
        new Set(['u1']),
      ),
      {
        userId: 'u1',
        displayName: 'Маша',
        avatarUrl: 'https://media/avatar.png',
        muted: true,
        serverMuted: true,
        deafened: true,
        speaking: false,
        screensharing: true,
        camera: true,
      },
    );
  });

  it('битые metadata не роняют snapshot, а пустое имя заменяется identity', () => {
    // Ловит падение всего presence-сервиса от чужих metadata и пустую подпись участника.
    const result = mapParticipant(participant('u1', { name: '', metadata: '{bad' }), new Set());
    assert.equal(result.avatarUrl, null);
    assert.equal(result.displayName, 'u1');
  });

  it('PTT-простой не изображается ручным выключением микрофона', () => {
    // Ловит постоянный mic-off бейдж у пользователя push-to-talk между нажатиями.
    const result = mapParticipant(
      participant('u1', { attributes: { ptt: '1' }, tracks: [track(TrackSource.MICROPHONE, true)] }),
      new Set(),
    );
    assert.equal(result.muted, false);
  });

  it('отсутствующий микрофон считается выключенным', () => {
    // Ловит показ активного микрофона участнику, который вообще не публикует mic-track.
    assert.equal(mapParticipant(participant('u1'), new Set()).muted, true);
  });
});

describe('итоговый ростер голосового канала', () => {
  it('нативный screen-companion исчезает из ростера и зажигает экран владельцу', () => {
    // Ловит двойного участника либо потерянный индикатор нативной демонстрации.
    const result = buildParticipantList(
      [participant('owner'), participant('owner#screen', { tracks: [track(TrackSource.SCREEN_SHARE)] })],
      new Set(),
    );
    assert.deepEqual(result.list.map((p) => p.userId), ['owner']);
    assert.equal(result.list[0].screensharing, true);
  });

  it('companion без screen-track удаляется, но владельцу экран не приписывается', () => {
    // Ловит слияние условий «это ghost» и «он действительно публикует экран».
    const result = buildParticipantList([participant('owner'), participant('owner#screen')], new Set());
    assert.deepEqual(result.list.map((p) => p.userId), ['owner']);
    assert.equal(result.list[0].screensharing, false);
  });

  it('осиротевший companion не создаёт владельца из воздуха', () => {
    // Ловит фантомную строку после того, как основной участник уже покинул комнату.
    const result = buildParticipantList(
      [participant('gone#screen', { tracks: [track(TrackSource.SCREEN_SHARE)] })],
      new Set(),
    );
    assert.deepEqual(result.list, []);
  });

  it('мут ушедшего возвращается как stale, не помечает других и не мутирует входной Set', () => {
    // Ловит перенос server-mute на соседа и скрытый побочный эффект чистого правила.
    const muted = new Set(['gone', 'present']);
    const result = buildParticipantList([participant('present')], muted);
    assert.deepEqual(result.staleMutedIds, ['gone']);
    assert.equal(result.list[0].serverMuted, true);
    assert.deepEqual([...muted], ['gone', 'present']);
  });

  it('одинаковые displayName стабильно разводятся по userId', () => {
    // Ловит перетасовку сайдбара на каждом reconcile при недетерминированном ответе LiveKit.
    const result = buildParticipantList(
      [participant('b', { name: 'Одинаково' }), participant('a', { name: 'Одинаково' })],
      new Set(),
    );
    assert.deepEqual(result.list.map((p) => p.userId), ['a', 'b']);
  });
});

describe('пределы клиентского сокета presence (F0, #139)', () => {
  const small = { bytes: 40, isIdentify: false };

  it('11-й кадр до входа закрывает сокет', () => {
    // Ловит сокет, который бесконечно шлёт мусор, так и не представившись.
    let b = newSocketBudget(0);
    for (let i = 0; i < PRESENCE_WS_LIMITS.maxPreauthFrames; i++) {
      const r = admitFrame(b, small, 0);
      assert.equal(r.ok, true);
      b = r.budget;
    }
    assert.equal(admitFrame(b, small, 0).ok, false);
  });

  it('повтор identify сверх предела закрывает сокет даже после входа', () => {
    // Ловит усилитель: каждое identify — запрос к бэкенду, сокет в цикле нагружал бы его без конца.
    let b = { ...newSocketBudget(0), identified: true };
    for (let i = 0; i < PRESENCE_WS_LIMITS.maxIdentifies; i++) {
      const r = admitFrame(b, { bytes: 200, isIdentify: true }, i);
      assert.equal(r.ok, true);
      b = r.budget;
    }
    assert.equal(admitFrame(b, { bytes: 200, isIdentify: true }, 10).ok, false);
  });

  it('огромный кадр закрывает сокет в любом состоянии', () => {
    // Ловит разбор мегабайтного JSON на каждом кадре.
    const edge = { bytes: PRESENCE_WS_LIMITS.maxFrameBytes, isIdentify: false };
    const big = { bytes: PRESENCE_WS_LIMITS.maxFrameBytes + 1, isIdentify: false };
    assert.equal(admitFrame(newSocketBudget(0), edge, 0).ok, true);
    assert.equal(admitFrame({ ...newSocketBudget(0), identified: true }, edge, 0).ok, true);
    assert.equal(admitFrame(newSocketBudget(0), big, 0).ok, false);
    assert.equal(admitFrame({ ...newSocketBudget(0), identified: true }, big, 0).ok, false);
  });

  it('после входа поток кадров ограничен окном, а честный ping раз в 30 с проходит всегда', () => {
    // Ловит флуд ping-ами после входа и ложное закрытие честного клиента.
    let b = { ...newSocketBudget(0), identified: true };
    for (let i = 0; i < PRESENCE_WS_LIMITS.maxFramesPerWindow; i++) b = admitFrame(b, small, 100).budget;
    assert.equal(admitFrame(b, small, 100).ok, false);

    let honest = { ...newSocketBudget(0), identified: true };
    for (let t = 0; t < 3_600_000; t += 30_000) {
      const r = admitFrame(honest, small, t);
      assert.equal(r.ok, true);
      honest = r.budget;
    }
  });

  it('новый сокет не пускается сверх предела с адреса и на процесс', () => {
    // Ловит накопление тысяч сокетов с одного адреса.
    assert.equal(admitSocket({ total: 0, fromIp: PRESENCE_WS_LIMITS.maxConnsPerIp - 1 }), true);
    assert.equal(admitSocket({ total: 0, fromIp: PRESENCE_WS_LIMITS.maxConnsPerIp }), false);
    assert.equal(admitSocket({ total: PRESENCE_WS_LIMITS.maxTotalConns - 1, fromIp: 0 }), true);
    assert.equal(admitSocket({ total: PRESENCE_WS_LIMITS.maxTotalConns, fromIp: 0 }), false);
  });

  it('внутренние hops справа пропускаются до ближайшего публичного адреса', () => {
    // Ловит предел «на адрес», который за NPM считал бы всех людей одним адресом прокси.
    assert.equal(clientIpFrom('203.0.113.7, 192.168.1.10', '172.18.0.2'), '203.0.113.7');
    assert.equal(clientIpFrom(undefined, '172.18.0.2'), '172.18.0.2');
    assert.equal(clientIpFrom(['198.51.100.1'], '172.18.0.2'), '198.51.100.1');
  });

  it('адрес клиента за прокси берётся справа от подставленной клиентом записи', () => {
    // Главная регрессия О5 должна краснеть и через тонкую обёртку presence, а не только в shared.
    assert.equal(
      clientIpFrom('198.51.100.77, 203.0.113.9', '192.168.1.20'),
      '203.0.113.9',
    );
  });
});
