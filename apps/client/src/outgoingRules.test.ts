import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addOutgoing,
  outgoingFailed,
  outgoingFilesLabel,
  outgoingRetry,
  outgoingSent,
  sendErrorText,
} from './outgoingRules.js';

const rows = [
  { key: 'a', content: 'A', files: [], replyToId: null, status: 'sending' as const, error: null, feedId: 'feed-a', afterId: '1' },
  { key: 'b', content: 'B', files: [], replyToId: null, status: 'sending' as const, error: null, feedId: 'feed-b', afterId: '2' },
];

describe('сообщения, которые ещё отправляются', () => {
  it('добавление и успешная отправка не меняют чужие строки и их дополнительные поля', () => {
    // Ловит пересборку очереди с потерей привязки к ленте или удалением не того сообщения.
    const added = addOutgoing(rows, { ...rows[0], key: 'c', content: 'C' });
    assert.deepEqual(added.map((x) => x.key), ['a', 'b', 'c']);
    assert.deepEqual(outgoingSent(added, 'b'), [rows[0], added[2]]);
    assert.equal(outgoingSent(rows, 'missing')[0], rows[0]);
  });

  it('отказ и повтор меняют только адресную строку, сохраняя поля ленты', () => {
    // Ловит ошибку одного запроса, покрасившую всю очередь, и зависшую старую причину после retry.
    const failed = outgoingFailed(rows, 'b', 'нет связи');
    assert.equal(failed[0], rows[0]);
    assert.deepEqual(failed[1], { ...rows[1], status: 'failed', error: 'нет связи' });
    const retried = outgoingRetry(failed, 'b');
    assert.deepEqual(retried[1], rows[1]);
    assert.equal(retried[1]?.feedId, 'feed-b');
    assert.equal(retried[1]?.afterId, '2');
  });

  it('смена инстанса гасит строку, а коды федерации становятся человеческими', () => {
    // Ловит ложную ошибку после навигации и показ технического кода человеку.
    assert.equal(sendErrorText({ switched: true }), null);
    assert.notEqual(sendErrorText(new Error('federation.guest_forbidden')), 'federation.guest_forbidden');
    assert.equal(sendErrorText(''), 'не удалось отправить');
    assert.equal(sendErrorText(new Error('обычная ошибка')), 'обычная ошибка');
  });

  it('подпись вложений различает пустой, один и несколько файлов', () => {
    // Ловит «undefined и ещё -1» и неверный счётчик скрытых вложений.
    assert.equal(outgoingFilesLabel([]), null);
    assert.equal(outgoingFilesLabel(['a.png']), 'a.png');
    assert.equal(outgoingFilesLabel(['a.png', 'b.jpg', 'c.gif']), 'a.png и ещё 2');
  });
});
