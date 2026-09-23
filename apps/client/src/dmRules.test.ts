import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dmBlockText, dmEmptyHint } from './dmRules.js';

const guest = { id: 'home', name: 'Соседи' } as never;

describe('личка между инстансами', () => {
  it('двое местных могут открыть личку', () => {
    // Ловит чрезмерный запрет обычной локальной переписки.
    assert.equal(dmBlockText(null, null), null);
  });

  it('гость получает объяснение про себя независимо от дома собеседника', () => {
    // Ловит ошибочный совет выбрать другого собеседника, когда запрет относится к самому гостю.
    assert.match(dmBlockText(guest, null)!, /Вы здесь гость/);
    assert.match(dmBlockText(guest, guest)!, /Вы здесь гость/);
  });

  it('местному объясняют запрет для гостя, а пустой экран меняется по его дому', () => {
    // Ловит интерфейс, который зовёт гостя начать заведомо недоступную личку.
    assert.match(dmBlockText(null, guest)!, /людьми других инстансов/);
    assert.match(dmEmptyHint(guest), /Гостю/);
    assert.match(dmEmptyHint(null), /Откройте участников/);
  });
});
