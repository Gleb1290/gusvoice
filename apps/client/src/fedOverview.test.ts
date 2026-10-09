import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEDERATION_OFF, LOCAL_NAME_FED_HINT, neighborNameHint, overviewAfterError } from './fedOverview.js';

describe('чистые правила обзора федерации', () => {
  it('404 — выключенная федерация, прочие статусы остаются ошибками', () => {
    // Сервер без федеративных маршрутов штатно отвечает 404: это не должно выглядеть как авария админки.
    assert.equal(overviewAfterError(404), FEDERATION_OFF);
    assert.equal(FEDERATION_OFF.status, 'off');
    assert.deepEqual(FEDERATION_OFF.contacts, []);
    for (const status of [400, 401, 403, 500, undefined]) assert.equal(overviewAfterError(status), null);
  });

  it('подсказка соседям появляется только когда локальное имя есть, а имя федерации ещё пусто', () => {
    // Локальное имя не отправляется соседям само: человек должен явно выбрать отдельное имя для федерации.
    assert.match(neighborNameHint('  Гнездо  ', null) ?? '', /«Гнездо»/);
    assert.equal(neighborNameHint('Гнездо', 'Свои'), null);
    assert.equal(neighborNameHint('  ', null), null);
    assert.equal(neighborNameHint(null, null), null);
    assert.match(LOCAL_NAME_FED_HINT, /Федерация/);
  });
});
