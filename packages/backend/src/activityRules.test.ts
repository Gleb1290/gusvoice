import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_TTL_MS,
  effectiveOf,
  isEmptyRecord,
  sameEffective,
  setSource,
  sweepExpired,
  type ActivityRecord,
} from './activityRules.js';

const steam = { name: 'Portal 2', appId: 620 };
const client = { name: 'Minecraft' };

describe('выбор показываемой игровой активности', () => {
  it('отсутствующая запись означает отсутствие игры', () => {
    // Ловит создание фиктивной активности для пользователя без heartbeat.
    assert.equal(effectiveOf(undefined, 1_000), null);
  });

  it('живой Steam имеет приоритет над живым client', () => {
    // Ловит показ менее авторитетного локального детекта вместо Steam.
    const rec: ActivityRecord = {
      steam: { game: steam, expiresAt: 2_000 },
      client: { game: client, expiresAt: 2_000 },
    };
    assert.deepEqual(effectiveOf(rec, 1_000), steam);
  });

  it('после истечения Steam видимым становится ещё живой client', () => {
    // Ловит исчезновение активности вместо fallback на второй источник.
    const rec: ActivityRecord = {
      steam: { game: steam, expiresAt: 1_000 },
      client: { game: client, expiresAt: 2_000 },
    };
    assert.deepEqual(effectiveOf(rec, 1_000), client);
  });

  it('за миллисекунду до TTL запись жива, ровно в TTL уже истекла', () => {
    // Ловит расхождение границы между чтением активности и фоновым sweep.
    const rec: ActivityRecord = { client: { game: client, expiresAt: 2_000 } };
    assert.deepEqual(effectiveOf(rec, 1_999), client);
    assert.equal(effectiveOf(rec, 2_000), null);
  });
});

describe('переходы источников активности', () => {
  it('новый источник получает точный TTL от переданного now', () => {
    // Ловит зависимость чистого правила от системных часов или неверную единицу времени.
    assert.deepEqual(setSource(undefined, 'client', client, 5_000), {
      client: { game: client, expiresAt: 5_000 + ACTIVITY_TTL_MS },
    });
  });

  it('обновление источника не мутирует исходную запись', () => {
    // Ловит скрытое изменение Map-значения до сравнения before/after и пропущенный broadcast.
    const original: ActivityRecord = { client: { game: client, expiresAt: 10_000 } };
    const snapshot = structuredClone(original);
    const next = setSource(original, 'steam', steam, 20_000);
    assert.deepEqual(original, snapshot);
    assert.notEqual(next, original);
    assert.deepEqual(next.client, original.client);
  });

  it('null снимает только свой источник и не мутирует другой', () => {
    // Ловит ситуацию, где закрытие локальной игры гасит продолжающийся Steam.
    const original: ActivityRecord = {
      steam: { game: steam, expiresAt: 10_000 },
      client: { game: client, expiresAt: 10_000 },
    };
    const next = setSource(original, 'client', null, 1_000);
    assert.deepEqual(next, { steam: original.steam });
    assert.ok(original.client);
  });

  it('sweep удаляет срок ровно сейчас, сохраняет будущий и не мутирует вход', () => {
    // Ловит несовпадающий полуинтервал и разрушение записи во время итерации хранилища.
    const original: ActivityRecord = {
      steam: { game: steam, expiresAt: 2_000 },
      client: { game: client, expiresAt: 2_001 },
    };
    const next = sweepExpired(original, 2_000);
    assert.deepEqual(next, { client: original.client });
    assert.ok(original.steam);
    assert.notEqual(next, original);
  });
});

describe('сравнение и пустота activity record', () => {
  it('эффективные игры равны только при одинаковых name и appId', () => {
    // Ловит лишние broadcast для того же состояния и пропуск реальной смены Steam appId.
    assert.equal(sameEffective(null, null), true);
    assert.equal(sameEffective(steam, { ...steam }), true);
    assert.equal(sameEffective(steam, { name: steam.name, appId: 621 }), false);
    assert.equal(sameEffective(steam, client), false);
    assert.equal(sameEffective(steam, null), false);
  });

  it('пустой record удаляется из хранилища, а один источник уже считается содержимым', () => {
    // Ловит накопление пустых пользователей или удаление ещё живой записи.
    assert.equal(isEmptyRecord({}), true);
    assert.equal(isEmptyRecord({ client: { game: client, expiresAt: 1 } }), false);
  });
});

