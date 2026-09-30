import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DROP_COOLDOWN_MS,
  DROP_SETTLE_MS,
  getStreamQuality,
  layerChoices,
  resolutionText,
  shownPref,
  stepDrop,
  streamHasLayers,
  wantedLayer,
} from './streamQuality.js';

describe('выбор слоя чужого показа', () => {
  it('скрытое окно и неоткрытый показ всегда просят экономный слой', () => {
    // Ловит расход полного потока, когда картинку физически никто не видит.
    for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
      assert.equal(wantedLayer(pref, { windowHidden: true, watched: true }), 'low');
      assert.equal(wantedLayer(pref, { windowHidden: false, watched: false }), 'low');
    }
    assert.equal(wantedLayer('auto', { windowHidden: false, watched: true }), 'high');
    assert.equal(wantedLayer('medium', { windowHidden: false, watched: true }), 'medium');
  });

  it('слои распознаются и по simulcast, и по нескольким слоям SVC', () => {
    // Ловит исчезновение меню у VP9 и ложное меню у одиночного потока.
    assert.equal(streamHasLayers(undefined), false);
    assert.equal(streamHasLayers({ simulcasted: true }), true);
    assert.equal(streamHasLayers({ trackInfo: { layers: [{}, {}] } }), true);
    assert.equal(streamHasLayers({ trackInfo: { layers: [{}] } }), false);
  });

  it('три реальных слоя подписываются сверху вниз без выдуманного разрешения', () => {
    // Ловит старое меню, где «Среднее» у двухслойного показа ничего не меняло.
    assert.deepEqual(layerChoices({ layers: [
      { width: 640, height: 360 }, { width: 2560, height: 1440 }, { width: 1280, height: 720 },
    ] }), [
      { pref: 'high', label: '1440p' },
      { pref: 'medium', label: '720p' },
      { pref: 'low', label: '360p' },
    ]);
    assert.deepEqual(layerChoices({ layers: [{ width: 1920, height: 1080 }, { width: 960, height: 540 }] }), [
      { pref: 'high', label: '1080p' }, { pref: 'low', label: '540p' },
    ]);
  });

  it('слои берутся из первого codec, а один, пустой и повреждённый набор выбора не дают', () => {
    // Ловит несовместимость с описанием VP9 и кнопку, которая не может ничего переключить.
    assert.deepEqual(layerChoices({ codecs: [{ layers: [{ width: 1280, height: 720 }, { width: 640, height: 360 }] }] }), [
      { pref: 'high', label: '720p' }, { pref: 'low', label: '360p' },
    ]);
    assert.deepEqual(layerChoices({ layers: [{ width: 1280, height: 720 }] }), []);
    assert.deepEqual(layerChoices({ layers: [{ width: 0, height: 0 }] }), []);
    assert.deepEqual(layerChoices(undefined), []);
  });

  it('несуществующее среднее честно показывается как верхний слой', () => {
    // Ловит отметку «Среднее» при фактически получаемом верхнем слое двухслойного показа.
    const two = layerChoices({ layers: [{ width: 1280, height: 720 }, { width: 640, height: 360 }] });
    assert.equal(shownPref('medium', two), 'high');
    assert.equal(shownPref('low', two), 'low');
    assert.equal(shownPref('high', []), 'auto');
  });
});

describe('детектор непрошенного падения качества', () => {
  it('ультраширокий кадр сообщает только на втором низком замере и молчит две минуты', () => {
    // Ловит сравнение с объявленным 1440p вместо лучшего реально увиденного ультраширокого кадра.
    let r = stepDrop(null, { key: 'show:high', w: 2560, h: 1068, now: 0 });
    r = stepDrop(r.next, { key: 'show:high', w: 2560, h: 1068, now: DROP_SETTLE_MS });
    r = stepDrop(r.next, { key: 'show:high', w: 1280, h: 534, now: DROP_SETTLE_MS + 3_000 });
    assert.equal(r.notify, false);
    r = stepDrop(r.next, { key: 'show:high', w: 1280, h: 534, now: DROP_SETTLE_MS + 6_000 });
    assert.equal(r.notify, true);
    r = stepDrop(r.next, { key: 'show:high', w: 1280, h: 534, now: DROP_SETTLE_MS + 9_000 });
    assert.equal(r.notify, false);
    assert.equal(r.next.notifiedAt, DROP_SETTLE_MS + 6_000);
    assert.equal(DROP_COOLDOWN_MS, 120_000);
  });

  it('смена пропорций и запрошенного слоя начинает измерение заново', () => {
    // Ловит ложный тост после растягивания окна или собственного переключения качества.
    let r = stepDrop(null, { key: 'a', now: 10 });
    r = stepDrop(r.next, { key: 'a', w: 1920, h: 1080, now: 10 + DROP_SETTLE_MS });
    r = stepDrop(r.next, { key: 'a', w: 1000, h: 1000, now: 20_000 });
    assert.equal(r.notify, false);
    assert.deepEqual([r.next.bestW, r.next.bestH, r.next.low], [1000, 1000, 0]);
    const changed = stepDrop(r.next, { key: 'b', w: 500, h: 500, now: 21_000 });
    assert.equal(changed.notify, false);
    assert.equal(changed.next.bestH, 0);
    assert.equal(changed.next.settleUntil, 21_000 + DROP_SETTLE_MS);
  });

  it('нулевой размер не подписывается, а мусор в хранилище даёт авто', () => {
    // Ловит «0×720» в UI и протекание неизвестного значения до LiveKit.
    assert.equal(resolutionText(0, 720), null);
    assert.equal(resolutionText(1280, 720), '1280×720');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => 'ultra' },
    });
    assert.equal(getStreamQuality(), 'auto');
  });
});
