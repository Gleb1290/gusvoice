import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAMERA_PRESET_ORDER,
  CAMERA_PRESETS,
  cameraCaptureOptions,
  cameraPublishOptions,
} from './cameraSettings.js';

describe('пресеты камеры', () => {
  it('каждый пресет передаёт свои размеры и fps в getUserMedia', () => {
    // Ловит рассинхрон карточки качества с фактическими ограничениями камеры.
    for (const preset of CAMERA_PRESET_ORDER) {
      const p = CAMERA_PRESETS[preset];
      assert.deepEqual(cameraCaptureOptions(preset), {
        resolution: { width: p.width, height: p.height, frameRate: p.maxFramerate },
      });
    }
  });

  it('каждый пресет публикуется одним слоем со своим битрейтом и без потери разрешения', () => {
    // Ловит возврат размытого simulcast или чужого битрейта после переключения камеры.
    for (const preset of CAMERA_PRESET_ORDER) {
      const p = CAMERA_PRESETS[preset];
      assert.deepEqual(cameraPublishOptions(preset), {
        simulcast: false,
        videoEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.maxFramerate },
        degradationPreference: 'maintain-resolution',
      });
    }
  });
});
