import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RemoteTrack } from 'livekit-client';
import { installLivekitTweaks } from './livekitTweaks.js';

describe('правка вечного цикла LiveKit', () => {
  it('после установки метод не планирует requestAnimationFrame', () => {
    // Ловит возврат вечного цикла отрисовки на каждую голосовую дорожку.
    let frames = 0;
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => ++frames });
    installLivekitTweaks();
    const track = Object.create(RemoteTrack.prototype) as { registerTimeSyncUpdate: () => void };
    track.registerTimeSyncUpdate();
    assert.equal(frames, 0);
  });

  it('повторная установка остаётся безопасной', () => {
    // Ловит двойную инициализацию приложения, превращённую в исключение до подключения.
    assert.doesNotThrow(() => installLivekitTweaks());
    assert.doesNotThrow(() => installLivekitTweaks());
  });
});
