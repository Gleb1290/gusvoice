import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Permission } from '@gusvoice/shared';
import { TrackSource } from 'livekit-server-sdk';
import { publishGrant, publishSources, voiceTokenMetadata } from './livekitRules.js';

describe('источники публикации LiveKit', () => {
  it('без прав список пуст и canPublish обязательно false', () => {
    // Ловит опасную семантику LiveKit: пустой список при canPublish=true означает «разрешено всё».
    assert.deepEqual(publishGrant(0n), {
      canPublish: false,
      canPublishData: false,
      canPublishSources: [],
    });
  });

  it('одно право SPEAK разрешает только микрофон', () => {
    // Ловит неявную выдачу камеры или экрана вместе с голосом.
    assert.deepEqual(publishSources(Permission.SPEAK), [TrackSource.MICROPHONE]);
    assert.equal(publishGrant(Permission.SPEAK).canPublish, true);
  });

  it('серверный мут убирает единственный микрофон и запрещает публикацию', () => {
    // Ловит повторную публикацию микрофона после mute через новый трек или переподключение.
    assert.deepEqual(publishGrant(Permission.SPEAK, true), {
      canPublish: false,
      canPublishData: false,
      canPublishSources: [],
    });
  });

  it('серверный мут сохраняет разрешённую камеру', () => {
    // Ловит чрезмерный mute, который вместе с голосом выключает видео участника.
    assert.deepEqual(publishGrant(Permission.SPEAK | Permission.VIDEO, true).canPublishSources, [TrackSource.CAMERA]);
    assert.equal(publishGrant(Permission.SPEAK | Permission.VIDEO, true).canPublish, true);
  });

  it('legacy STREAM даёт камеру и оба источника демонстрации', () => {
    // Ловит потерю совместимости старых ролей или звука screen-share.
    assert.deepEqual(publishSources(Permission.STREAM), [
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ]);
  });

  it('публикация data зависит только от SEND_MESSAGES и не от server-mute', () => {
    // Ловит случайное отключение служебных LiveKit-данных вместе с микрофоном.
    assert.equal(publishGrant(Permission.SEND_MESSAGES, false).canPublishData, true);
    assert.equal(publishGrant(Permission.SEND_MESSAGES, true).canPublishData, true);
    assert.equal(publishGrant(Permission.SPEAK, false).canPublishData, false);
  });
});

describe('метаданные голосового токена', () => {
  it('отсутствующий avatarUrl сериализуется как явный null', () => {
    // Ловит исчезающее поле, из-за которого presence сохраняет устаревший аватар.
    assert.deepEqual(JSON.parse(voiceTokenMetadata(0n)), { avatarUrl: null, priority: false });
  });

  it('PRIORITY_SPEAKER и аватар доезжают в JSON независимо от publish-прав', () => {
    // Ловит неверную сортировку говорящих или потерю аватара в LiveKit webhook.
    assert.deepEqual(JSON.parse(voiceTokenMetadata(Permission.PRIORITY_SPEAKER, 'https://media/avatar.png')), {
      avatarUrl: 'https://media/avatar.png',
      priority: true,
    });
  });
});
