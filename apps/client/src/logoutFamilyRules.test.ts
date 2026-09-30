import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Instance } from './configRules.js';
import { endGuestSessions, logoutFamilyCore } from './logoutFamilyRules.js';

const inst = (id: string, token: string | null, guestOf?: string, apiUrl = `https://${id}.test`): Instance => ({
  id, name: id, token, guestOf, apiUrl, presenceWs: `wss://${id}.test/ws`, order: 0,
});

describe('выход из семьи инстансов', () => {
  it('сначала передаёт нетронутых гостей с токенами, затем очищает только выбранную семью', () => {
    // Ловит очистку токенов до отзыва гостевых сессий и выход из постороннего домашнего аккаунта.
    const list = [inst('home-a', 'ha'), inst('guest-a', 'ga', 'home-a'), inst('home-b', 'hb'), inst('guest-b', 'gb', 'home-b')];
    let seen: Instance[] = [];
    const next = logoutFamilyCore(list, 'home-a', (guests) => { seen = guests; });
    assert.deepEqual(seen.map((x) => [x.id, x.token]), [['guest-a', 'ga']]);
    assert.deepEqual(next?.map((x) => [x.id, x.token]), [
      ['home-a', null], ['guest-a', null], ['home-b', 'hb'], ['guest-b', 'gb'],
    ]);
    assert.equal(list[0]?.token, 'ha');
  });

  it('выход с гостевой записи находит её дом, а неизвестная запись ничего не меняет', () => {
    // Ловит очистку только одного гостя вместо всей его семьи и лишнюю запись реестра при stale id.
    const list = [inst('home', 'h'), inst('g1', '1', 'home'), inst('g2', '2', 'home')];
    assert.deepEqual(logoutFamilyCore(list, 'g1', () => {})?.map((x) => x.token), [null, null, null]);
    assert.equal(logoutFamilyCore(list, 'missing', () => assert.fail('не должен вызываться')), null);
  });
});

describe('завершение гостевых сессий', () => {
  it('отправляет POST с Bearer и keepalive только записям с адресом и токеном', async () => {
    // Ловит запрос без авторизации, который не отзывает сессию перед перезагрузкой приложения.
    const calls: [string, RequestInit][] = [];
    endGuestSessions([
      inst('ok', 'secret', 'home', 'https://host.test'),
      inst('no-token', null, 'home'),
      inst('no-url', 'token', 'home', ''),
    ], async (url, init) => { calls.push([url, init]); });
    await Promise.resolve();
    assert.deepEqual(calls, [[
      'https://host.test/api/fed/guest-session/end',
      { method: 'POST', headers: { Authorization: 'Bearer secret' }, keepalive: true },
    ]]);
  });

  it('синхронный и асинхронный отказ сети не ломают выход', async () => {
    // Ловит превращение недоступного хоста в блокировку локального logout.
    assert.doesNotThrow(() => endGuestSessions([inst('a', 'x', 'home')], () => { throw new Error('offline'); }));
    endGuestSessions([inst('b', 'y', 'home')], async () => { throw new Error('offline'); });
    await Promise.resolve();
  });
});
