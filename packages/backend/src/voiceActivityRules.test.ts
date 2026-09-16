import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoiceParticipant } from '@gusvoice/shared';
import {
  MAX_SAMPLE_MS,
  creditedMs,
  peersOf,
  pickSession,
  planSamples,
  type ChannelSnapshot,
} from './voiceActivityRules.js';

const participant = (userId: string, patch: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  displayName: userId,
  avatarUrl: null,
  muted: false,
  serverMuted: false,
  deafened: false,
  speaking: false,
  screensharing: false,
  camera: false,
  ...patch,
});

const channel = (channelId: string, participants: VoiceParticipant[], serverId = 'server'): ChannelSnapshot => ({
  channelId,
  serverId,
  participants,
});

describe('засчитываемый интервал присутствия', () => {
  it('первое наблюдение, повторный тик и часы назад не придумывают время', () => {
    // После старта бэкенда курсоров нет; начислить время «до того, как увидели» означало бы
    // испортить сухой прогон вымышленными часами присутствия.
    assert.equal(creditedMs(10_000, undefined), 0);
    assert.equal(creditedMs(10_000, 10_000), 0);
    assert.equal(creditedMs(9_999, 10_000), 0);
  });

  it('ровно потолок засчитывается целиком, а опоздавший тик обрезается', () => {
    assert.equal(creditedMs(MAX_SAMPLE_MS, 0), MAX_SAMPLE_MS);
    assert.equal(creditedMs(MAX_SAMPLE_MS + 1, 0), MAX_SAMPLE_MS);
  });
});

describe('обстановка в канале', () => {
  it('не считает самого человека его же собеседником', () => {
    const people = [participant('alice'), participant('bob'), participant('charlie')];
    assert.equal(peersOf(people, 'alice'), 2);
    assert.equal(peersOf([participant('alice')], 'alice'), 0);
  });

  it('выбирает один и тот же канал независимо от порядка Redis-ключей', () => {
    const first = channel('alpha', [participant('alice')]);
    const second = channel('zulu', [participant('alice')]);
    assert.equal(pickSession([second, first]).channelId, 'alpha');
    assert.equal(pickSession([first, second]).channelId, 'alpha');
  });
});

describe('план среза присутствия', () => {
  it('первое наблюдение не пишет нулевые строки, но ставит курсор каждому', () => {
    const r = planSamples(
      [channel('voice', [participant('alice'), participant('bob')])],
      new Map(),
      1_000,
    );

    assert.deepEqual(r.samples, []);
    assert.deepEqual([...r.cursors], [['alice', 1_000], ['bob', 1_000]]);
  });

  it('записывает время, соседей и реальные флаги выбранной сессии', () => {
    const r = planSamples(
      [
        channel('voice', [
          participant('alice', { serverMuted: true }),
          participant('bob', { deafened: true, screensharing: true }),
        ]),
      ],
      new Map([
        ['alice', 1_000],
        ['bob', 1_000],
      ]),
      61_000,
    );

    assert.deepEqual(r.samples, [
      {
        serverId: 'server',
        userId: 'alice',
        channelId: 'voice',
        seconds: 60,
        peers: 1,
        // 🔴 Мьют от МОДЕРАТОРА больше не выдаёт себя за собственный (#124, В1): иначе право
        // `MUTE_MEMBERS` при опущенном `mutedPercent` молча резало бы жертве заработок.
        muted: false,
        serverMuted: true,
        deafened: false,
        screensharing: false, away: false
      },
      {
        serverId: 'server',
        userId: 'bob',
        channelId: 'voice',
        seconds: 60,
        peers: 1,
        muted: false,
        serverMuted: false,
        deafened: true,
        screensharing: true, away: false
      },
    ]);
  });


  it('«отошёл» приходит СНАРУЖИ: presence о статусе не знает (04.09)', () => {
    // Признак живёт в `users.presence_status`, а снимок presence оперирует микрофоном и каналом.
    // Поэтому множество отошедших передаётся отдельным аргументом — и попадает в сырьё, чтобы ретро
    // и любой пересчёт видели ровно то же состояние, что видел тикер.
    const r = planSamples(
      [channel('voice', [participant('alice'), participant('bob')])],
      new Map([
        ['alice', 1_000],
        ['bob', 1_000],
      ]),
      61_000,
      new Set(['bob']),
    );
    assert.deepEqual(
      r.samples.map((s) => [s.userId, s.away]),
      [
        ['alice', false],
        ['bob', true],
      ],
    );
  });

  it('огрызок короче полсекунды отбрасывает, а ровно полсекунды сохраняет как секунду', () => {
    // Регрессия 2026-08-28: раньше положительные миллисекунды проходили фильтр, а после округления
    // становились строкой `seconds: 0`, которая портит подсчёты и ничего не сообщает.
    const source = [channel('voice', [participant('alice')])];
    const below = planSamples(source, new Map([['alice', 1_000]]), 1_499);
    const atBoundary = planSamples(source, new Map([['alice', 1_000]]), 1_500);

    assert.deepEqual(below.samples, []);
    assert.equal(below.cursors.get('alice'), 1_499);
    assert.equal(atBoundary.samples[0]?.seconds, 1);
  });

  it('ушедший выпадает из курсора и возвращение утром не оплачивает ночь', () => {
    const absent = planSamples([], new Map([['alice', 1_000]]), 60_000);
    const returned = planSamples(
      [channel('voice', [participant('alice')])],
      absent.cursors,
      8 * 60 * 60 * 1_000,
    );

    assert.deepEqual([...absent.cursors], []);
    assert.deepEqual(returned.samples, []);
    assert.equal(returned.cursors.get('alice'), 8 * 60 * 60 * 1_000);
  });

  it('две сессии человека дают одну запись из детерминированного канала', () => {
    const r = planSamples(
      [
        channel('zulu', [participant('alice')], 'server-z'),
        channel('alpha', [participant('alice')], 'server-a'),
      ],
      new Map([['alice', 1_000]]),
      61_000,
    );

    assert.equal(r.duplicates, 1);
    assert.deepEqual(r.samples, [
      {
        serverId: 'server-a',
        userId: 'alice',
        channelId: 'alpha',
        seconds: 60,
        peers: 0,
        muted: false,
        serverMuted: false,
        deafened: false,
        screensharing: false, away: false
      },
    ]);
  });

  it('🔴 собственный мьют и мьют модератора — разные факты (#124, В1)', () => {
    // У действий модерации не должно быть денежной цены: замьютить человека — это про разговор, а
    // не про его кошелёк. Формула смотрит на `muted`, поэтому решение модератора обязано лежать
    // отдельно и в неё не попадать.
    const both = planSamples(
      [channel('voice', [participant('alice', { muted: true, serverMuted: true })])],
      new Map([['alice', 1_000]]),
      61_000,
    );
    const onlyModerator = planSamples(
      [channel('voice', [participant('bob', { serverMuted: true })])],
      new Map([['bob', 1_000]]),
      61_000,
    );

    assert.equal(both.samples[0].muted, true, 'сам замьютился — это его выбор, он в формуле');
    assert.equal(both.samples[0].serverMuted, true);
    assert.equal(onlyModerator.samples[0].muted, false, 'замьютил модератор — в формулу НЕ попадает');
    assert.equal(onlyModerator.samples[0].serverMuted, true, 'но факт записан: будет чем объяснить');
  });
});
