import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relayTyping, type TypingDeps } from './gatewayTyping.js';

function fixture() {
  const sent: { socket: string; msg: unknown }[] = [];
  const published: { serverId: string; channelId: string; msg: unknown; audience: string[] }[] = [];
  const lookedUp: string[] = [];
  let limited = false;
  let peer: string | null = 'bob';
  let blocked = false;
  let audience: { serverId: string; userIds: string[] } | null = { serverId: 'server', userIds: ['alice', 'bob'] };
  const deps: TypingDeps<string> = {
    rateHit: async () => limited ? 1 : 0,
    dmPeerOf: async (dmId, senderId) => { lookedUp.push(`${dmId}:${senderId}`); return peer; },
    isBlockedBy: async (blockerId, blockedId) => {
      assert.deepEqual([blockerId, blockedId], ['bob', 'alice']);
      return blocked;
    },
    connsOf: (userId) => {
      assert.equal(userId, 'bob');
      return [{ socket: 'bob-phone' }, { socket: 'bob-desktop' }];
    },
    send: (socket, msg) => { sent.push({ socket, msg }); },
    getChannelAudience: async () => audience,
    publishToChannel: async (serverId, channelId, msg, userIds) => {
      published.push({ serverId, channelId, msg, audience: userIds });
    },
  };
  const conn = { userId: 'alice', servers: new Set(['server']) };
  return {
    deps, conn, sent, published, lookedUp,
    limit: () => { limited = true; },
    setPeer: (value: string | null) => { peer = value; },
    block: () => { blocked = true; },
    setAudience: (value: typeof audience) => { audience = value; },
  };
}

describe('доставка события «печатает»', () => {
  it('исчерпанный лимит прекращает обработку до чтения беседы', async () => {
    // Ловит обход rate-limit через частые эфемерные кадры.
    const f = fixture();
    f.limit();
    await relayTyping(f.deps, f.conn, { dmId: 'dm' });
    assert.deepEqual(f.lookedUp, []);
    assert.deepEqual(f.sent, []);
  });

  it('чужая беседа не выдаёт событие никакому соединению', async () => {
    // Ловит подмену dmId для слежения за набором в чужой личной беседе.
    const f = fixture();
    f.setPeer(null);
    await relayTyping(f.deps, f.conn, { dmId: 'foreign' });
    assert.deepEqual(f.lookedUp, ['foreign:alice']);
    assert.deepEqual(f.sent, []);
  });

  it('присланный recipientId игнорируется, а заблокировавшему набор не доходит', async () => {
    // Ловит подмену адресата клиентом и прежнюю инверсию признака блокировки.
    const f = fixture();
    f.block();
    const spoofed = { dmId: 'dm', recipientId: 'mallory' };
    await relayTyping(f.deps, f.conn, spoofed);
    assert.deepEqual(f.sent, []);
  });

  it('обычный набор доходит каждому устройству настоящего собеседника, но не автору', async () => {
    // Ловит потерю одного из устройств собеседника или отражение своего набора отправителю.
    const f = fixture();
    const spoofed = { dmId: 'dm', recipientId: 'mallory' };
    await relayTyping(f.deps, f.conn, spoofed);
    assert.deepEqual(f.sent, [
      { socket: 'bob-phone', msg: { t: 'typing', dmId: 'dm', userId: 'alice' } },
      { socket: 'bob-desktop', msg: { t: 'typing', dmId: 'dm', userId: 'alice' } },
    ]);
  });

  it('канал без подписки или подходящей аудитории молчит', async () => {
    // Ловит рассылку в чужой сервер, несуществующий канал и канал, который автор сам не видит.
    const f = fixture();
    await relayTyping(f.deps, f.conn, { serverId: 'foreign', channelId: 'ch' });
    f.setAudience(null);
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    f.setAudience({ serverId: 'foreign', userIds: ['alice', 'bob'] });
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    f.setAudience({ serverId: 'server', userIds: ['bob'] });
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    assert.deepEqual(f.published, []);
  });

  it('канал получает только зрителей без автора', async () => {
    // Ловит эхо собственного набора и утечку события за границу видимости канала.
    const f = fixture();
    await relayTyping(f.deps, f.conn, { serverId: 'server', channelId: 'ch' });
    assert.deepEqual(f.published, [{
      serverId: 'server', channelId: 'ch', msg: { t: 'typing', channelId: 'ch', userId: 'alice' }, audience: ['bob'],
    }]);
  });
});
