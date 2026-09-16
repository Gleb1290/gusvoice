import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOTIFY_THROTTLE_MS,
  passesThrottle,
  shouldOsNotify,
  shouldOsNotifyDm,
} from './notifyRules.js';

const at = (o: Partial<Parameters<typeof shouldOsNotify>[0]> = {}) => ({
  level: 'all' as const,
  channelLevel: 'all' as const,
  mentioned: false,
  dnd: false,
  focused: false,
  ...o,
});

/**
 * Правила системных уведомлений (#77).
 *
 * Тут важна ПАРНОСТЬ: к каждому «молчим» нужен «звеним», иначе легко получить фичу, которая
 * зелёная в тестах и молчит в бою — ровно так #77 и жил (уведомление звалось только из ветки
 * упоминания, и никто этого не замечал).
 */
describe('когда молчим всегда', () => {
  it('окно в фокусе — человек и так смотрит', () => {
    assert.equal(shouldOsNotify(at({ focused: true })), false);
    assert.equal(shouldOsNotify(at({ focused: true, mentioned: true })), false);
    assert.equal(shouldOsNotifyDm({ level: 'all', dnd: false, focused: true }), false);
  });

  it('«не беспокоить» гасит и упоминание, и ЛС', () => {
    assert.equal(shouldOsNotify(at({ dnd: true })), false);
    assert.equal(shouldOsNotify(at({ dnd: true, mentioned: true })), false);
    assert.equal(shouldOsNotifyDm({ level: 'all', dnd: true, focused: false }), false);
  });

  it('глобально выключено — молчит всё, включая упоминания и ЛС', () => {
    assert.equal(shouldOsNotify(at({ level: 'off' })), false);
    assert.equal(shouldOsNotify(at({ level: 'off', mentioned: true })), false);
    assert.equal(shouldOsNotifyDm({ level: 'off', dnd: false, focused: false }), false);
  });

  it('заглушённый канал молчит даже при глобальном «все»', () => {
    // Иначе «включить все сообщения» разбудило бы каналы, которые человек намеренно заглушил.
    assert.equal(shouldOsNotify(at({ level: 'all', channelLevel: 'none' })), false);
    assert.equal(shouldOsNotify(at({ level: 'all', channelLevel: 'none', mentioned: true })), false);
  });
});

describe('упоминания', () => {
  it('проходят при глобальном «только упоминания»', () => {
    assert.equal(shouldOsNotify(at({ level: 'mentions', channelLevel: 'all', mentioned: true })), true);
  });

  it('проходят, когда канал настроен на «только упоминания»', () => {
    assert.equal(shouldOsNotify(at({ level: 'all', channelLevel: 'mentions', mentioned: true })), true);
    assert.equal(shouldOsNotify(at({ level: 'mentions', channelLevel: 'mentions', mentioned: true })), true);
  });
});

describe('обычные сообщения — нужно разрешение с ОБЕИХ сторон', () => {
  it('глобально «все» + канал «все» → звеним (ради этого всё и делалось)', () => {
    assert.equal(shouldOsNotify(at({ level: 'all', channelLevel: 'all', mentioned: false })), true);
  });

  it('глобально «только упоминания» → обычное молчит', () => {
    // Прежнее поведение приложения; кто его выбрал — не должен получить лавину.
    assert.equal(shouldOsNotify(at({ level: 'mentions', channelLevel: 'all', mentioned: false })), false);
  });

  it('канал «только упоминания» → обычное молчит даже при глобальном «все»', () => {
    assert.equal(shouldOsNotify(at({ level: 'all', channelLevel: 'mentions', mentioned: false })), false);
  });
});

describe('ЛС', () => {
  it('проходят при «только упоминания» — это личное, а не общий чат', () => {
    assert.equal(shouldOsNotifyDm({ level: 'mentions', dnd: false, focused: false }), true);
    assert.equal(shouldOsNotifyDm({ level: 'all', dnd: false, focused: false }), true);
  });
});

describe('троттл', () => {
  it('первое уведомление по каналу проходит', () => {
    assert.equal(passesThrottle(false, undefined, 1_000_000), true);
  });

  it('второе подряд — гасится', () => {
    const t = 1_000_000;
    assert.equal(passesThrottle(false, t, t + 1), false);
    assert.equal(passesThrottle(false, t, t + NOTIFY_THROTTLE_MS - 1), false);
  });

  it('ровно на границе окна — уже проходит', () => {
    const t = 1_000_000;
    assert.equal(passesThrottle(false, t, t + NOTIFY_THROTTLE_MS), true);
  });

  it('упоминание троттл не глушит — оно адресное и редкое', () => {
    const t = 1_000_000;
    assert.equal(passesThrottle(true, t, t + 1), true);
  });

  it('окно настраивается', () => {
    const t = 1_000_000;
    assert.equal(passesThrottle(false, t, t + 50, 100), false);
    assert.equal(passesThrottle(false, t, t + 100, 100), true);
  });
});
