import assert from 'node:assert/strict';
import { it } from 'node:test';
import { composerPreviewLink, nextDismissed, sendNoPreview } from './linkPreviewRules';

it('превью берёт первую внешнюю ссылку без завершающей пунктуации', () => {
  // Ловит запрос превью своего инстанса и включение знаков конца предложения в URL.
  assert.equal(composerPreviewLink('https://own.test/a https://outside.test/x?q=1). https://last.test/', (u) => u.startsWith('https://own.test/')), 'https://outside.test/x?q=1');
  assert.equal(composerPreviewLink('http://outside.test/a!'), 'http://outside.test/a');
  assert.equal(composerPreviewLink('https://first.test/ https://second.test/'), 'https://first.test/');
  for (const text of ['', 'просто текст', 'https://', 'https://own.test/']) assert.equal(composerPreviewLink(text, (u) => u.includes('own.test')), null);
});

it('крестик действует до удаления последней ссылки, без поддержки флаг не отправляется', () => {
  // Ловит неожиданное возвращение скрытого превью и несовместимое поле старому серверу.
  assert.equal(nextDismissed(true, 'https://other.test/'), true);
  assert.equal(nextDismissed(true, null), false);
  assert.equal(nextDismissed(false, 'https://other.test/'), false);
  for (const dismissed of [false, true]) for (const link of [null, 'https://other.test/']) for (const supported of [false, true])
    assert.equal(sendNoPreview(dismissed, link, supported), dismissed && link !== null && supported);
});
