import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTACTS_MAX, contactLink, parseContacts } from './contacts.js';

describe('контакты держателя инстанса', () => {
  it('опасные схемы и похожая на них почта никогда не становятся ссылкой', () => {
    const dangerous = [
      { kind: 'url', value: 'javascript:alert(1)' },
      { kind: 'url', value: 'data:text/html,x' },
      { kind: 'url', value: 'http://plain.example' },
      { kind: 'url', value: 'file:///tmp/x' },
      { kind: 'url', value: 'tg://resolve?domain=user' },
      { kind: 'email', value: 'javascript:alert(1)@x.example' },
    ];
    for (const contact of dangerous) {
      assert.equal(contactLink({ ...contact, label: '' }).href, null, contact.value);
    }
  });

  it('разрешённые почта, Telegram, Matrix и https становятся ссылками', () => {
    assert.equal(contactLink({ kind: 'email', label: '', value: 'admin@example.org' }).href, 'mailto:admin@example.org');
    assert.equal(contactLink({ kind: 'telegram', label: '', value: '@gusvoice' }).href, 'https://t.me/gusvoice');
    assert.equal(contactLink({ kind: 'matrix', label: '', value: '@admin:example.org' }).href, 'https://matrix.to/#/@admin:example.org');
    assert.equal(contactLink({ kind: 'url', label: '', value: 'https://example.org/help' }).href, 'https://example.org/help');
  });

  it('телефон и неизвестный новый вид намеренно остаются текстом', () => {
    assert.equal(contactLink({ kind: 'phone', label: '', value: '+7 999 000-00-00' }).href, null);
    assert.equal(contactLink({ kind: 'future', label: '', value: 'opaque' }).href, null);
  });

  it('разбор соседа выбрасывает негодные записи по одной и берёт не больше пяти', () => {
    const raw = [
      null,
      { kind: 'text', value: '' },
      ...Array.from({ length: CONTACTS_MAX + 3 }, (_, i) => ({ kind: 'text', label: `L${i}`, value: `V${i}` })),
    ];
    const parsed = parseContacts(raw);
    assert.equal(parsed.length, CONTACTS_MAX);
    assert.deepEqual(parsed.map((c) => c.value), ['V0', 'V1', 'V2', 'V3', 'V4']);
  });
});
