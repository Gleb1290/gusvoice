import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelFromRoom, ROOM_PREFIX, roomForChannel } from './ws.js';

describe('имена голосовых комнат LiveKit', () => {
  it('идентификатор канала получает ровно один служебный префикс', () => {
    // Ловит несовпадение имени комнаты между выдачей токена и обработкой webhook.
    assert.equal(roomForChannel('8eb8f61e-99ea-4ab3-a0d2-4f17f760bf5c'), `${ROOM_PREFIX}8eb8f61e-99ea-4ab3-a0d2-4f17f760bf5c`);
  });

  it('обратное преобразование сохраняет подчёркивания внутри идентификатора', () => {
    // Ловит разбор через split, который обрезал бы допустимую часть после первого подчёркивания.
    assert.equal(channelFromRoom('channel_team_voice_1'), 'team_voice_1');
  });

  it('чужие и похожие имена комнат не принимаются за каналы GusVoice', () => {
    // Ловит обработку webhook из комнаты без точного namespace-префикса приложения.
    assert.equal(channelFromRoom('other_channel_1'), null);
    assert.equal(channelFromRoom('Channel_1'), null);
    assert.equal(channelFromRoom('xchannel_1'), null);
  });
});
