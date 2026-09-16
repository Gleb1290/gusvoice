import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customStatusVisible, effectiveDot } from './status.js';

describe('видимость presence-статуса', () => {
  it('владелец профиля всегда видит собственный настоящий статус', () => {
    // Ловит маскировку invisible для самого пользователя, из-за которой настройка выглядит несохранённой.
    assert.equal(effectiveDot('invisible', false, true), 'invisible');
    assert.equal(effectiveDot('away', false, true), 'away');
  });

  it('invisible для остальных неотличим от offline', () => {
    // Ловит прямую утечку выбранного скрытого статуса другим участникам.
    assert.equal(effectiveDot('invisible', true, false), 'offline');
  });

  it('любой статус офлайн-пользователя для остальных становится offline', () => {
    // Ловит показ устаревшего online/dnd/away после закрытия последнего gateway-соединения.
    for (const status of ['online', 'dnd', 'away'] as const) assert.equal(effectiveDot(status, false, false), 'offline');
  });

  it('видимые статусы онлайн-пользователя сохраняются без подмены', () => {
    // Ловит чрезмерную маскировку, превращающую живых участников в офлайн.
    for (const status of ['online', 'dnd', 'away'] as const) assert.equal(effectiveDot(status, true, false), status);
  });

  it('кастомный статус скрывается по тем же privacy-правилам, что и точка', () => {
    // Ловит утечку текста invisible-пользователя при правильно замаскированной точке.
    assert.equal(customStatusVisible('invisible', true, false), false);
    assert.equal(customStatusVisible('online', false, false), false);
    assert.equal(customStatusVisible('away', true, false), true);
    assert.equal(customStatusVisible('invisible', false, true), true);
  });
});
