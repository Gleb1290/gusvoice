import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  catchupPlan,
  changeAudience,
  countsAsUnread,
  decodeCursor,
  directKey,
  encodeCursor,
  idempotencyDecision,
  isSortKey,
  journalLockOrder,
  messageView,
  nextSortKey,
  payloadHash,
  previewText,
  readKeyMax,
  type JournalEntry,
} from './convRules.js';

describe('порядок беседы', () => {
  it('часы растут строго даже после отката времени', () => {
    // Ловит одинаковые ключи при двух отправках за одну микросекунду и после отката часов.
    assert.equal(nextSortKey(100, 0), 100);
    assert.equal(nextSortKey(100, 100), 101);
    assert.equal(nextSortKey(50, 100), 101);
    assert.equal(nextSortKey(102, 100), 102);
  });

  it('ключ допускает ноль и последний точный integer, но не округлённые числа', () => {
    // Ловит слипание соседних ключей при JSON-обмене после 2^53.
    for (const v of [0, Number.MAX_SAFE_INTEGER]) assert.equal(isSortKey(v), true);
    for (const v of [-1, 1.5, '5', NaN, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isSortKey(v), false);
    const one = 1_800_000_000_000_000;
    assert.notEqual(JSON.stringify(one), JSON.stringify(one + 1));
  });

  it('пара людей имеет один ключ независимо от инициатора', () => {
    // Ловит создание двух личных бесед для одной пары.
    assert.equal(directKey('b', 'a'), 'a:b');
    assert.equal(directKey('a', 'b'), 'a:b');
  });

  it('курсор возвращает точный ключ и id, а мусор отвергается', () => {
    // Ловит потерю страницы или 500 на поддельном курсоре.
    const c = { sortKey: 1_800_000_000_000_001, id: 'abcd-1234' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    for (const bad of ['1_', '_x', 'a_b', '12345678901234567_x', `${2 ** 53}_x`, '1_a/b', '1_a b', `1_${'x'.repeat(65)}`]) {
      assert.equal(decodeCursor(bad), null, bad);
    }
    assert.deepEqual(decodeCursor(`0_${'x'.repeat(64)}`), { sortKey: 0, id: 'x'.repeat(64) });
  });

  it('отметка прочтения не откатывается от запоздавшего устройства', () => {
    // Ловит повторно вспыхнувшие непрочитанные после старой вкладки.
    assert.equal(readKeyMax(8, 3), 8);
    assert.equal(readKeyMax(8, 9), 9);
  });
});

describe('повтор отправки и видимость', () => {
  const base = { conversationId: 'c', content: 'текст', attachmentRefs: ['a', 'b'], replyToId: null };

  it('отпечаток не зависит от порядка полей объекта и формы пустой цитаты', () => {
    // Ловит ложный 409 при штатном повторе того же сообщения.
    const hash = payloadHash(base);
    assert.equal(payloadHash({ replyToId: undefined, attachmentRefs: ['a', 'b'], content: 'текст', conversationId: 'c' }), hash);
    assert.equal(hash, createHash('sha256').update(JSON.stringify(['p1', 'c', 'текст', ['a', 'b'], null])).digest('hex'));
  });

  it('другая беседа, текст, порядок файлов или цитата меняют отпечаток', () => {
    // Ловит возврат чужого сообщения или молчаливое принятие изменённого повтора.
    const hash = payloadHash(base);
    assert.notEqual(payloadHash({ ...base, conversationId: 'other' }), hash);
    assert.notEqual(payloadHash({ ...base, content: 'другое' }), hash);
    assert.notEqual(payloadHash({ ...base, attachmentRefs: ['b', 'a'] }), hash);
    assert.notEqual(payloadHash({ ...base, replyToId: 'm' }), hash);
  });

  it('отсутствующая, равная и отличающаяся запись различаются', () => {
    // Ловит дубликат или переиспользование clientId с другим содержимым.
    assert.equal(idempotencyDecision(undefined, 'h'), 'insert');
    assert.equal(idempotencyDecision('h', 'h'), 'replay');
    assert.equal(idempotencyDecision('other', 'h'), 'conflict');
    assert.equal(idempotencyDecision(null, 'h'), 'conflict');
  });

  it('надгробие, спрятанное и чужое придержанное невидимы адресно', () => {
    // Ловит показ удалённого текста или утечку блокировки через чужой экран.
    const msg = { authorId: 'a', withheld: false, deletedAt: null, hiddenFor: [] as string[], sortKey: 10 };
    assert.equal(messageView(msg, 'b'), 'full');
    assert.equal(countsAsUnread(msg, 'b', 9), true);
    assert.equal(countsAsUnread(msg, 'b', 10), false);
    assert.equal(countsAsUnread(msg, 'a', 0), false);
    assert.equal(messageView({ ...msg, deletedAt: new Date() }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, hiddenFor: ['b'] }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, withheld: true }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, withheld: true }, 'a'), 'full');
    assert.equal(countsAsUnread({ ...msg, withheld: true }, 'b', 0), false);
  });
});

describe('журнал и догонка', () => {
  it('замки людей берутся в общем порядке и без дублей', () => {
    // Ловит взаимную блокировку встречных отправок двух участников.
    const entries: JournalEntry[] = ['b', 'a', 'b'].map((userId) => ({ userId, conversationId: 'c', kind: 'msg', messageId: 'm' }));
    assert.deepEqual(journalLockOrder(entries), ['a', 'b']);
  });

  it('адресаты действий не раскрывают придержанное и личное удаление', () => {
    // Ловит лишнюю запись журнала у блокировщика или собеседника.
    const common = { actorId: 'a', memberIds: ['b', 'a'], withheld: false, blockedActor: new Set(['b']) };
    for (const action of ['create', 'edit', 'delete-both'] as const) {
      assert.deepEqual(changeAudience({ ...common, action }), ['a', 'b']);
      assert.deepEqual(changeAudience({ ...common, action, withheld: true }), ['a']);
    }
    assert.deepEqual(changeAudience({ ...common, action: 'delete-me' }), ['a']);
    assert.deepEqual(changeAudience({ ...common, action: 'react' }), ['a']);
    assert.deepEqual(changeAudience({ ...common, action: 'react', blockedActor: new Set() }), ['a', 'b']);
  });

  it('потерянный журнал и клиент впереди сервера требуют нового снимка', () => {
    // Ловит тихую потерю изменений после очистки журнала или восстановления базы.
    assert.deepEqual(catchupPlan(4, { pts: 10, minPts: 5 }, [], 2), { reset: true, pts: 10 });
    assert.deepEqual(catchupPlan(11, { pts: 10, minPts: 5 }, [], 2), { reset: true, pts: 10 });
    assert.deepEqual(catchupPlan(5, { pts: 10, minPts: 5 }, [], 2), { reset: false, pts: 10, more: false, rows: [] });
  });

  it('при неполной странице курсор указывает на последнюю отданную строку', () => {
    // Ловит пропуск хвоста при следующем запросе догонки.
    const rows = [{ pts: 6 }, { pts: 7 }, { pts: 8 }];
    assert.deepEqual(catchupPlan(5, { pts: 9, minPts: 5 }, rows, 2),
      { reset: false, pts: 7, more: true, rows: rows.slice(0, 2) });
    assert.deepEqual(catchupPlan(5, { pts: 9, minPts: 5 }, rows.slice(0, 2), 2),
      { reset: false, pts: 9, more: false, rows: rows.slice(0, 2) });
  });
});

describe('анонс беседы', () => {
  it('200 символов остаются целыми, 201 обрезается с многоточием', () => {
    // Ловит превышение лимита и лишнее многоточие на точной границе.
    assert.equal(previewText('x'.repeat(200)), 'x'.repeat(200));
    assert.equal(previewText('x'.repeat(201)), `${'x'.repeat(199)}…`);
  });

  it('переносы строк схлопываются, а эмодзи не разрываются пополам', () => {
    // Ловит битый Unicode в кратком тексте беседы.
    assert.equal(previewText(' один\n\tдва '), 'один два');
    assert.equal(previewText('🙂🙂🙂', 2), '🙂…');
  });
});
