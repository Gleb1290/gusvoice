import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePushKeys } from './pushKeys.js';

describe('ключи пуша от нативного моста', () => {
  it('отсутствующая и пустая строка означают отсутствие ключей', () => {
    // Ловит отказ всей регистрации на старом APK без метода шифрования.
    for (const raw of [undefined, null, '']) assert.equal(parsePushKeys(raw), null);
  });

  it('битый JSON и JSON null не выбрасывают ошибку наружу', () => {
    // Ловит потерю регистрации из-за повреждённого ответа нативного моста.
    for (const raw of ['{', 'null', '42', '[]']) assert.equal(parsePushKeys(raw), null);
  });

  it('оба строковых поля проходят, лишние поля отбрасываются', () => {
    // Ловит утечку посторонних данных моста в запрос регистрации.
    assert.deepEqual(parsePushKeys(JSON.stringify({ p256dh: 'key', auth: 'secret', privateKey: 'never' })), {
      p256dh: 'key', auth: 'secret',
    });
  });

  it('неполный ключ и поле не строкой отвергаются', () => {
    // Ловит отправку формы, которая упадёт уже на серверной проверке и оставит телефон без пуша.
    for (const raw of ['{}', '{"p256dh":"key"}', '{"p256dh":1,"auth":"secret"}', '{"p256dh":"key","auth":null}']) {
      assert.equal(parsePushKeys(raw), null);
    }
  });
});
