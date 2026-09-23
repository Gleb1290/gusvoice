import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyPassphraseError, openKey, sameSecret, sealKey } from './keyEnvelope.js';

describe('зашифрованный конверт ключа', () => {
  it('правильный пароль возвращает исходные байты, чужой — явную ошибку пароля', () => {
    const bytes = Buffer.from('private-key');
    const sealed = sealKey(bytes, 'correct horse');
    assert.deepEqual(openKey(sealed, 'correct horse'), bytes);
    assert.throws(() => openKey(sealed, 'wrong'), KeyPassphraseError);
  });

  it('один ключ дважды получает разные соль и вектор', () => {
    const a = sealKey(Buffer.from('same'), 'password');
    const b = sealKey(Buffer.from('same'), 'password');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notDeepEqual(a, b);
  });

  it('параметры KDF читаются из конверта и их подмена ломает открытие', () => {
    const sealed = sealKey(Buffer.from('key'), 'password');
    assert.throws(() => openKey({ ...sealed, n: sealed.n / 2 }, 'password'), KeyPassphraseError);
  });

  it('обрубок, чужая метка и неизвестная версия дают управляемую ошибку', () => {
    const sealed = sealKey(Buffer.from('long-enough-private-key'), 'password');
    assert.throws(() => openKey({ ...sealed, data: sealed.data.slice(0, -4) }, 'password'), KeyPassphraseError);
    assert.throws(() => openKey({ ...sealed, tag: Buffer.alloc(16).toString('base64') }, 'password'), KeyPassphraseError);
    assert.throws(() => openKey({ ...sealed, v: 2 }, 'password'), /неизвестный формат/);
  });

  it('сверка секрета принимает только точное совпадение и не падает на другой длине', () => {
    assert.equal(sameSecret('secret', 'secret'), true);
    assert.equal(sameSecret('secret', 'secre'), false);
  });
});
