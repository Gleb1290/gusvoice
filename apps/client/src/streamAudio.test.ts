import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampStreamVolume,
  creditScreenOwners,
  loadStreamVolumes,
  MAX_STREAM_VOLUME,
  normalizeStreamVolumes,
  ownerOf,
  streamAudioVolume,
} from './streamAudioRules.js';

/**
 * Громкость чужого стрим-аудио.
 *
 * Повод: звук стрима было слышно, хотя стрим не открывали — достаточно было сидеть в голосовом
 * канале и уйти читать текстовый. Правило «неоткрытый стрим не звучит» жило только в сцене
 * голосового канала, а сцена в этот момент размонтирована.
 *
 * Поэтому здесь на каждое «звучит» есть парное «молчит»: баг был именно в том, что молчание
 * никто не проверял.
 */
const ГРОМКО = () => 1;

describe('стрим не открыт', () => {
  it('молчит, даже если стример в канале и звук идёт', () => {
    assert.equal(streamAudioVolume('petya', [], [], ГРОМКО), 0);
  });

  it('молчит, когда открыт стрим ДРУГОГО человека', () => {
    assert.equal(streamAudioVolume('petya', ['masha'], [], ГРОМКО), 0);
  });

  it('молчит при похожем, но не совпадающем идентификаторе', () => {
    assert.equal(streamAudioVolume('pet', ['petya'], [], ГРОМКО), 0);
  });
});

describe('стрим открыт', () => {
  it('звучит на своей громкости', () => {
    assert.equal(streamAudioVolume('petya', ['petya'], [], () => 0.5), 0.5);
  });

  it('молчит, если его заглушили отдельно', () => {
    assert.equal(streamAudioVolume('petya', ['petya'], ['petya'], ГРОМКО), 0);
  });

  it('звучит, когда открыто несколько стримов сразу', () => {
    assert.equal(streamAudioVolume('petya', ['masha', 'petya'], [], () => 0.8), 0.8);
  });
});

describe('нативный стрим: видео на спутнике, звук на владельце', () => {
  it('звучит и когда аудио опубликовано прямо на открытом спутнике', () => {
    assert.equal(streamAudioVolume('petya#screen', ['petya#screen'], [], () => 0.6), 0.6);
  });

  it('звучит, когда открыт спутник, а звук пришёл от владельца', () => {
    assert.equal(streamAudioVolume('petya', ['petya#screen'], [], () => 0.7), 0.7);
  });

  it('уважает заглушение, выставленное на спутнике', () => {
    assert.equal(streamAudioVolume('petya', ['petya#screen'], ['petya#screen'], ГРОМКО), 0);
  });

  it('не путает чужого владельца со своим спутником', () => {
    assert.equal(streamAudioVolume('masha', ['petya#screen'], [], ГРОМКО), 0);
  });

  it('срезает суффикс только с конца', () => {
    assert.equal(ownerOf('petya#screen'), 'petya');
    assert.equal(ownerOf('petya#screenshot'), 'petya#screenshot');
    assert.equal(ownerOf('petya'), 'petya');
  });
});

describe('значок показа при заходе в канал к показывающему', () => {
  const st = (screensharing: boolean) => ({ speaking: false, muted: false, deafened: false, screensharing });

  it('спутник отдаёт флаг владельцу', () => {
    // Регрессия: значок «показывает экран» ПРОПАДАЛ, стоило зайти в канал к человеку. Снаружи флаг
    // даёт presence (там перенос есть), внутри — живое состояние из LiveKit, где у самого человека
    // `isScreenShareEnabled` = false: видео публикует спутник.
    const next = creditScreenOwners({ petya: st(false), 'petya#screen': st(true) });
    assert.equal(next.petya.screensharing, true);
  });

  it('чужой спутник не зажигает значок соседу', () => {
    const next = creditScreenOwners({ petya: st(false), masha: st(false), 'masha#screen': st(true) });
    assert.equal(next.petya.screensharing, false);
    assert.equal(next.masha.screensharing, true);
  });

  it('спутник без владельца в списке ничего не ломает', () => {
    // Участники приходят не одним куском: спутник может оказаться в срезе раньше владельца.
    const next = creditScreenOwners({ 'petya#screen': st(true) });
    assert.equal(next['petya#screen'].screensharing, true);
    assert.equal(next.petya, undefined);
  });

  it('веб-показ и без спутника остаётся показом', () => {
    // Из браузера человек публикует экран сам, спутника нет — перенос не должен это ГАСИТЬ.
    const next = creditScreenOwners({ petya: st(true) });
    assert.equal(next.petya.screensharing, true);
  });

  it('погасший спутник не гасит владельца обратно', () => {
    // Перенос только ЗАЖИГАЕТ: у владельца может быть свой веб-показ, и затирать его нельзя.
    const next = creditScreenOwners({ petya: st(true), 'petya#screen': st(false) });
    assert.equal(next.petya.screensharing, true);
  });
});

describe('потолок громкости стрима', () => {
  it('усиление доходит до 200 % и не дальше', () => {
    // 🔴 Выше единицы — это узел усиления Web Audio, а не громкость элемента воспроизведения: у
    // той диапазон жёстко 0…1, и просьба «сделай громче» без этого упиралась в потолок платформы.
    assert.equal(MAX_STREAM_VOLUME, 2);
    assert.equal(clampStreamVolume(1.6), 1.6);
    assert.equal(clampStreamVolume(5), 2, 'выше потолка не пускаем — там хрип, а не громкость');
  });

  it('ниже нуля не уходит', () => {
    assert.equal(clampStreamVolume(-1), 0);
    assert.equal(clampStreamVolume(0), 0);
  });

  it('🔴 мусор даёт обычную громкость, а не тишину', () => {
    // В localStorage лежат громкости, записанные прошлыми версиями, и туда может попасть что
    // угодно. Онеметь молча хуже, чем играть на 100 %: причину будут искать где угодно, кроме
    // сохранённой настройки.
    assert.equal(clampStreamVolume(Number.NaN), 1);
    assert.equal(clampStreamVolume(Number.POSITIVE_INFINITY), 1);
    assert.equal(clampStreamVolume(undefined as unknown as number), 1);
  });
});

describe('🔴 нормализация загруженного набора — ТА ЖЕ функция, что зовёт стор', () => {
  it('записанная руками пятёрка не доезжает до трека', () => {
    // Раньше эти проверки ходили по локальной копии цикла, объявленной прямо в тесте: удаление
    // нормализации из стора их бы не покрасило. Ложнозелёный тест фикса — ровно та иллюзия
    // защиты, которую мы в этот вечер и разбирали (поймал Codex).
    assert.deepEqual(normalizeStreamVolumes({ 'petya#screen': 5 }), { 'petya#screen': 2 });
  });

  it('нормальные значения переживают загрузку без изменений', () => {
    assert.deepEqual(normalizeStreamVolumes({ a: 0, b: 0.5, c: 2 }), { a: 0, b: 0.5, c: 2 });
  });

  it('любой мусор даёт 100 %, а не тишину — независимо от своей формы', () => {
    assert.deepEqual(normalizeStreamVolumes({ a: '1.5', b: 'абра', c: null, d: undefined }), {
      a: 1,
      b: 1,
      c: 1,
      d: 1,
    });
  });

  it('пустой набор остаётся пустым', () => {
    assert.deepEqual(normalizeStreamVolumes({}), {});
  });
});

describe('🔴 загрузка громкостей из хранилища — та же функция, что зовёт стор', () => {
  const KEY = 'gv_stream_volumes';
  const store = (raw: string | null) => (k: string) => (k === KEY ? raw : null);

  it('разбирает и приводит за один вызов', () => {
    // Мутация: убрать `normalizeStreamVolumes` из тела → падает на пятёрке.
    assert.deepEqual(loadStreamVolumes(store('{"a":5,"b":0.5}'), KEY), { a: 2, b: 0.5 });
  });

  it('пустое хранилище — пустой набор', () => {
    assert.deepEqual(loadStreamVolumes(store(null), KEY), {});
  });

  it('битый JSON не роняет загрузку приложения', () => {
    // Громкости — удобство; падать из-за них на старте нельзя.
    assert.deepEqual(loadStreamVolumes(store('{не json'), KEY), {});
  });

  it('отказ самого хранилища (приватный режим) тоже переживаем', () => {
    assert.deepEqual(
      loadStreamVolumes(() => {
        throw new Error('доступ запрещён');
      }, KEY),
      {},
    );
  });
});
