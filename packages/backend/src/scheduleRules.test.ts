import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRipe, parseIsoInstant, peerPresence, sameTarget, schedFailurePlan, schedPayloadHash,
  schedRetryDelayMs, schedSendDecision, scheduleTarget, scheduledLimit, scheduledMediaLimit,
  scheduledMediaLimitBody, SCHEDULED_MEDIA_BYTES_PER_USER_MAX,
} from './scheduleRules.js';

describe('чистые правила отложенных сообщений', () => {
  it('ISO-парсер принимает календарные края и отвергает несуществующие даты и часы', () => {
    // Date.parse нормализует невозможные даты; пояс обязателен, иначе один текст зависит от TZ сервера.
    assert.notEqual(parseIsoInstant('2024-02-28T12:00:00Z'), null);
    assert.notEqual(parseIsoInstant('2024-02-29T12:00:00Z'), null);
    for (const invalid of [
      '2023-02-29T12:00:00Z', '2024-02-30T12:00:00Z', '2024-02-28T24:00:00Z',
      '2024-02-28T12:00:60Z', '2024-02-28T12:00:00', '2024-02-28T12:00:00+15:00', '2024-02-28T12:00:00.1234567Z',
    ]) assert.equal(parseIsoInstant(invalid), null, invalid);
    assert.notEqual(parseIsoInstant('2024-02-28T12:00:00+14:00'), null);
    assert.notEqual(parseIsoInstant('2024-02-28T12:00:00.123456Z'), null);
  });

  it('режим времени принимает grace и годовые границы, но отвергает их за пределом и неоднозначный режим', () => {
    // Минутная поблажка спасает часы клиента; точный год допустим, а обе границы исключают off-by-one.
    const now = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(scheduleTarget({ sendAt: '2025-12-31T23:59:00.000Z' }, now).ok, true);
    assert.deepEqual(scheduleTarget({ sendAt: '2025-12-31T23:58:59.999Z' }, now), { ok: false, error: 'send_at in the past' });
    assert.equal(scheduleTarget({ sendAt: '2027-01-01T00:00:00.000Z' }, now).ok, true);
    assert.deepEqual(scheduleTarget({ sendAt: '2027-01-01T00:00:00.001Z' }, now), { ok: false, error: 'send_at too far' });
    assert.deepEqual(scheduleTarget({}, now), { ok: false, error: 'schedule mode required' });
    assert.deepEqual(scheduleTarget({ sendAt: '2026-02-01T00:00:00Z', whenOnline: true }, now), { ok: false, error: 'schedule mode required' });
    assert.deepEqual(scheduleTarget({ whenOnline: false }, now), { ok: false, error: 'schedule mode required' });
    assert.deepEqual(scheduleTarget({ sendAt: 'garbage' }, now), { ok: false, error: 'bad send_at' });
    assert.deepEqual(scheduleTarget({ whenOnline: true }, now), { ok: true, target: { sendAt: null, whenOnline: true } });
  });

  it('сравнивает target по миллисекундам и не смешивает режимы', () => {
    // Отсутствие содержательного изменения не должно создавать лишнюю запись журнала.
    const at = new Date('2026-10-05T12:00:00.123Z');
    assert.equal(sameTarget({ sendAt: new Date(at), whenOnline: false }, { sendAt: at, whenOnline: false }), true);
    assert.equal(sameTarget({ sendAt: new Date(at.getTime() - 1), whenOnline: false }, { sendAt: at, whenOnline: false }), false);
    assert.equal(sameTarget({ sendAt: null, whenOnline: true }, { sendAt: at, whenOnline: false }), false);
    assert.equal(sameTarget({ sendAt: at, whenOnline: false }, { sendAt: null, whenOnline: true }), false);
  });

  it('хеш замысла стабилен по s1 и меняется при изменении каждого поля запроса', () => {
    // silent, ответ или режим — часть принятого замысла: повтор изменённого запроса не должен считаться тем же заданием.
    const target = { sendAt: new Date('2026-10-06T12:00:00.000Z'), whenOnline: false } as const;
    const base = { conversationId: 'c1', content: 'текст', replyToId: 'm1', silent: false, target };
    const hash = schedPayloadHash(base);
    assert.equal(hash, 'd98eee80b1881430e44a87bcdabfdf8a8c0bada0b30e39848b2c827d4654dd7d');
    assert.equal(schedPayloadHash({ ...base }), hash);
    assert.equal(schedPayloadHash({ ...base, attachmentIds: [] }), hash, 'пустой список сохраняет текстовый отпечаток s1');
    assert.notEqual(schedPayloadHash({ ...base, attachmentIds: ['file-a'] }), hash, 'id файла входит в новый отпечаток');
    assert.notEqual(
      schedPayloadHash({ ...base, attachmentIds: ['file-a', 'file-b'] }),
      schedPayloadHash({ ...base, attachmentIds: ['file-b', 'file-a'] }),
      'порядок файлов является частью запроса и меняет отпечаток',
    );
    assert.notEqual(schedPayloadHash({ ...base, conversationId: 'c2' }), hash);
    assert.notEqual(schedPayloadHash({ ...base, content: 'другой' }), hash);
    assert.notEqual(schedPayloadHash({ ...base, replyToId: 'm2' }), hash);
    assert.notEqual(schedPayloadHash({ ...base, silent: true }), hash);
    assert.notEqual(schedPayloadHash({ ...base, target: { sendAt: null, whenOnline: true } }), hash);
    assert.notEqual(schedPayloadHash({ ...base, target: { sendAt: new Date(target.sendAt.getTime() + 1), whenOnline: false } }), hash);
  });

  it('временной режим созревает ровно на границе sendAt', () => {
    // Граница не должна теряться из-за сравнения строго «меньше» вместо «меньше или равно».
    const now = new Date('2026-10-05T12:00:00Z');
    assert.equal(isRipe({ sendAt: now, whenOnline: false, failedAt: null, nextAttemptAt: null }, now, 'offline'), true);
    assert.equal(isRipe({ sendAt: new Date(now.getTime() + 1), whenOnline: false, failedAt: null, nextAttemptAt: null }, now, 'offline'), false);
  });

  it('режим «в сети» ждёт невидимого и оживает при видимом онлайне', () => {
    // Иначе сообщение раскрыло бы отправителю невидимый статус собеседника.
    const row = { sendAt: null, whenOnline: true, failedAt: null, nextAttemptAt: null };
    assert.equal(peerPresence({ exists: true, deleted: false, connected: true, status: 'invisible' }), 'offline');
    assert.equal(isRipe(row, new Date(), 'offline'), false);
    assert.equal(isRipe(row, new Date(), 'online'), true);
    assert.equal(peerPresence({ exists: false, deleted: false, connected: true, status: 'online' }), 'gone');
    assert.equal(peerPresence({ exists: true, deleted: true, connected: true, status: 'online' }), 'gone');
    assert.equal(peerPresence({ exists: true, deleted: false, connected: false, status: 'online' }), 'offline');
    assert.equal(peerPresence({ exists: true, deleted: false, connected: true, status: 'dnd' }), 'online');
  });

  it('не повторяет сдавшуюся строку и ждёт nextAttemptAt', () => {
    // Сбой не должен превращаться в горячий бесконечный цикл планировщика.
    const now = new Date('2026-10-05T12:00:00Z');
    assert.equal(isRipe({ sendAt: now, whenOnline: false, failedAt: now, nextAttemptAt: null }, now, 'online'), false);
    assert.equal(isRipe({ sendAt: now, whenOnline: false, failedAt: null, nextAttemptAt: new Date(now.getTime() + 1) }, now, 'online'), false);
    assert.equal(isRipe({ sendAt: now, whenOnline: false, failedAt: null, nextAttemptAt: now }, now, 'online'), true);
  });

  it('экспоненциальная задержка имеет начальную и верхнюю границы', () => {
    // Ловит нулевую задержку после первой ошибки и повторы чаще часа при большом attempts.
    assert.equal(schedRetryDelayMs(1), 30_000);
    assert.equal(schedRetryDelayMs(2), 60_000);
    assert.equal(schedRetryDelayMs(7), 1_920_000);
    assert.equal(schedRetryDelayMs(99), 3_600_000);
    assert.deepEqual(schedFailurePlan(7, new Date('2026-10-05T12:00:00Z')), { attempts: 8, giveUp: true, nextAttemptAt: null });
    assert.deepEqual(schedFailurePlan(6, new Date('2026-10-05T12:00:00Z')), {
      attempts: 7, giveUp: false, nextAttemptAt: new Date('2026-10-05T12:32:00Z'),
    });
  });

  it('предел пропускает ровно максимум и отвергает следующее сообщение', () => {
    // Проверяет обе стороны границы и приоритет лимита беседы, когда достигнуты оба.
    assert.equal(scheduledLimit({ inConversation: 99, total: 499 }), null);
    assert.deepEqual(scheduledLimit({ inConversation: 100, total: 499 }), { scope: 'conversation', max: 100 });
    assert.deepEqual(scheduledLimit({ inConversation: 0, total: 500 }), { scope: 'user', max: 500 });
  });

  it('предел файлов пропускает 20-е и ровно 1 ГиБ, но отказывает на следующем файле или байте', () => {
    // Парковка живёт дольше загрузки: строгие грани не дают принять 21-й альбом или переложить лишний байт в бакет.
    assert.equal(scheduledMediaLimit({ mediaInConversation: 19, parkedBytes: 0, addBytes: 1 }), null);
    const twentyFirst = scheduledMediaLimit({ mediaInConversation: 20, parkedBytes: 0, addBytes: 1 });
    assert.deepEqual(twentyFirst, { scope: 'conversation', max: 20 });
    assert.deepEqual(scheduledMediaLimitBody(twentyFirst!), {
      error: 'Отложенных с файлами в одной беседе — не больше 20', reason: 'scheduled_media_limit', scope: 'conversation', max: 20,
    });
    assert.equal(scheduledMediaLimit({ mediaInConversation: 0, parkedBytes: SCHEDULED_MEDIA_BYTES_PER_USER_MAX - 1, addBytes: 1 }), null);
    const tooLarge = scheduledMediaLimit({ mediaInConversation: 0, parkedBytes: SCHEDULED_MEDIA_BYTES_PER_USER_MAX, addBytes: 1 });
    assert.deepEqual(tooLarge, { scope: 'user', maxBytes: SCHEDULED_MEDIA_BYTES_PER_USER_MAX });
    assert.deepEqual(scheduledMediaLimitBody(tooLarge!), {
      error: 'Файлы в отложенных сообщениях — не больше 1 ГБ: отправьте или удалите часть',
      reason: 'scheduled_media_limit', scope: 'user', maxBytes: SCHEDULED_MEDIA_BYTES_PER_USER_MAX,
    });
  });

  it('отбрасывает исчезнувшего автора, но оставляет peer-gone для автора', () => {
    // Ушедший автор не должен отправить сообщение от своего имени после выхода из беседы.
    assert.equal(schedSendDecision({ authorMember: false, authorDeleted: false, peerExists: true, peerDeleted: false }), 'drop');
    assert.equal(schedSendDecision({ authorMember: true, authorDeleted: true, peerExists: true, peerDeleted: true }), 'drop');
    assert.equal(schedSendDecision({ authorMember: true, authorDeleted: false, peerExists: true, peerDeleted: true }), 'peer-gone');
    assert.equal(schedSendDecision({ authorMember: true, authorDeleted: false, peerExists: true, peerDeleted: false }), 'send');
  });
});
