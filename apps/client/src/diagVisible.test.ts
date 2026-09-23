import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagVisible } from './diagVisible.js';

describe('видимость диагностики', () => {
  it('свежее разрешение профиля включает диагностику вопреки старому флагу инстанса', () => {
    // Ловит вечное отключение диагностики у сервера, добавленного до появления флага.
    assert.equal(diagVisible(true, false), true);
  });

  it('свежий запрет профиля выключает диагностику вопреки сохранённому флагу', () => {
    // Ловит показ сбора диагностики после того, как сервер его уже отключил.
    assert.equal(diagVisible(false, true), false);
  });

  it('старый сервер без поля профиля использует известный флаг инстанса', () => {
    // Ловит несовместимость со старым бэкендом, который ещё не присылает diagPreview.
    assert.equal(diagVisible(undefined, true), true);
    assert.equal(diagVisible(undefined, false), false);
  });
});
