import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FED_BACKUP_NOTE, FEDERATION_OFF, LOCAL_NAME_FED_HINT, neighborNameHint, overviewAfterError,
  SWITCH_REFUSAL_TEXT, switchSourceHint } from './fedOverview.js';

describe('чистые правила обзора федерации', () => {
  it('404 — выключенная федерация, прочие статусы остаются ошибками', () => {
    // Сервер без федеративных маршрутов штатно отвечает 404: это не должно выглядеть как авария админки.
    assert.equal(overviewAfterError(404), FEDERATION_OFF);
    assert.equal(FEDERATION_OFF.status, 'off');
    assert.deepEqual(FEDERATION_OFF.contacts, []);
    for (const status of [400, 401, 403, 500, undefined]) assert.equal(overviewAfterError(status), null);
  });

  it('подсказка соседям появляется только когда локальное имя есть, а имя федерации ещё пусто', () => {
    // Пустое имя федерации теперь использует обычное название, но не создаёт сохранённую настройку.
    assert.equal(neighborNameHint('  Гнездо  ', null),
      'Пусто — соседи видят название инстанса «Гнездо». Чтобы они видели другое, впишите его сюда и сохраните.');
    assert.equal(neighborNameHint('Гнездо', 'Свои'), null);
    assert.equal(neighborNameHint('  ', null), null);
    assert.equal(neighborNameHint(null, null), null);
    assert.match(LOCAL_NAME_FED_HINT, /Федерация/);
  });

  it('R257 env объясняет блокировку, а panel и off не обещают несуществующего ограничения', () => {
    // Иначе свой выключатель панели выглядит неизменяемой настройкой из файла.
    assert.match(switchSourceHint('env') ?? '', /\.env/);
    assert.match(switchSourceHint('env') ?? '', /отсюда не выключается/);
    assert.equal(switchSourceHint('panel'), null);
    assert.equal(switchSourceHint('off'), null);
  });

  it('R257 три отказа различают общий флаг, ЛС и необходимость сначала включить федерацию', () => {
    // Текст про ключ или общий сбой не помогает исправить конкретный отказ тумблера.
    assert.deepEqual(Object.keys(SWITCH_REFUSAL_TEXT).sort(), ['dm_env_locked', 'env_locked', 'federation_off']);
    assert.match(SWITCH_REFUSAL_TEXT.env_locked, /Федерация.*\.env.*перезапуск/);
    assert.match(SWITCH_REFUSAL_TEXT.dm_env_locked, /Личные сообщения.*\.env/);
    assert.equal(SWITCH_REFUSAL_TEXT.federation_off, 'Сначала включите федерацию.');
  });

  it('R257 заметка о переносе требует вместе базу и fed-keys', () => {
    // Только один из двух бэкапов не даёт восстановить прежнюю личность инстанса.
    assert.match(FED_BACKUP_NOTE, /вместе/);
    assert.match(FED_BACKUP_NOTE, /резервную копию базы/);
    assert.match(FED_BACKUP_NOTE, /папку fed-keys/);
  });
});
