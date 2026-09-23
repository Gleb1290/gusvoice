import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { forgetPlace, lastPlace, rememberPlace } from './lastPlace.js';

let values = new Map<string, string>();
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
});

describe('последнее место внутри инстанса', () => {
  it('сервер, канал и личка переживают запись и чтение', () => {
    // Ловит возврат на пустой экран после обычного обновления страницы.
    const place = { instanceId: 'home', serverId: 's1', channelId: 'c1', dmId: 'd1' };
    rememberPlace(place);
    assert.deepEqual(lastPlace('home'), place);
  });

  it('запись другого инстанса не используется и пустой id ничего не читает', () => {
    // Ловит открытие чужого сервера после возвращения на домашний инстанс.
    rememberPlace({ instanceId: 'peer', serverId: 's1' });
    assert.equal(lastPlace('home'), null);
    assert.equal(lastPlace(null), null);
  });

  it('поля неверного типа отбрасываются по одному', () => {
    // Ловит протаскивание повреждённого хранилища в навигацию старта.
    values.set('gv_last_place', JSON.stringify({ instanceId: 'home', serverId: 42, channelId: 'c1', dmId: false }));
    assert.deepEqual(lastPlace('home'), { instanceId: 'home', serverId: undefined, channelId: 'c1', dmId: undefined });
  });

  it('битый JSON считается отсутствующим местом', () => {
    // Ловит падение всего приложения из-за одной оборванной записи localStorage.
    values.set('gv_last_place', '{broken');
    assert.equal(lastPlace('home'), null);
  });

  it('забытое место больше не восстанавливается', () => {
    // Ловит цикл возврата на уже закрытый или удалённый сервер.
    rememberPlace({ instanceId: 'home', serverId: 'gone' });
    forgetPlace();
    assert.equal(lastPlace('home'), null);
  });
});
