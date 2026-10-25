import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  DROP_COOLDOWN_MS,
  DROP_SETTLE_MS,
  getStreamQuality,
  layerChoices,
  needsLayerResend,
  resolutionText,
  shownPref,
  stepDrop,
  streamHasLayers,
  streamQualityMenu,
  wantedLayer,
} from './streamQuality.js';

type QualityRules = typeof import('./streamQuality.js');

function loadQualityModule(raw: string): QualityRules {
  // Меню проверяем внутри целого модуля, а не вырванной формулой с искусственными зависимостями.
  const module = { exports: {} as QualityRules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports,
    localStorage: { getItem: () => null },
    require: (id: string) => {
      assert.equal(id, 'react', `Неописанный импорт меню качества: ${id}`);
      return { useSyncExternalStore: () => assert.fail('Чистое меню не вызывает React-хук') };
    },
  });
  return module.exports;
}

function rejectMenuMutation(from: string, to: string, verify: (api: QualityRules) => void, message: string): void {
  const source = readFileSync(new URL('./streamQuality.ts', import.meta.url), 'utf8');
  verify(loadQualityModule(source));
  assert.equal(source.split(from).length - 1, 1, 'точка мутации меню единственная');
  const mutant = loadQualityModule(source.replace(from, to));
  // Загрузка мутанта вне assert.throws: синтаксическая ошибка не доказывает защиту поведения.
  assert.throws(() => verify(mutant),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message));
}

describe('R278 повтор слоя после новой подписки', () => {
  it('новый трек с уже выбранным экономным слоем требует повторной отправки серверу', () => {
    // SFU забыл LOW при отписке, хотя библиотека всё ещё считает его установленным.
    assert.equal(needsLayerResend('low', 'low', true), true);
  });

  it('тот же трек с тем же слоем не требует повторной отправки на каждом событии стора', () => {
    // Без проверки свежести подписки любое обновление стора снова посылало бы запрос слоя.
    assert.equal(needsLayerResend('low', 'low', false), false);
  });

  it('новый трек с другим запрошенным слоем оставляет смену качества обычному пути', () => {
    // emitTrackUpdate повторяет старое качество: при смене HIGH на LOW нужен setVideoQuality.
    assert.equal(needsLayerResend('high', 'low', true), false);
  });

  it('тот же трек с другим слоем не подменяет смену качества повтором старого', () => {
    // Парный случай: ручной выбор слоя без переподписки тоже обязан пройти обычным путём.
    assert.equal(needsLayerResend('high', 'low', false), false);
  });

  function verifyResend(api: QualityRules): void {
    assert.equal(api.needsLayerResend('low', 'low', true), true, 'R278 свежая подписка повторяет равный слой');
    assert.equal(api.needsLayerResend('low', 'low', false), false, 'R278 прежняя подписка не повторяет равный слой');
    assert.equal(api.needsLayerResend('high', 'low', true), false, 'R278 новый слой меняется обычным путём');
    assert.equal(api.needsLayerResend('high', 'low', false), false, 'R278 прежний трек меняет слой обычным путём');
  }

  it('игнорирование свежести подписки отвергается после проверки оригинала', () => {
    // Отличает восстановление после отписки от лишних повторов на каждом apply.
    rejectMenuMutation('return freshSubscription && requested === wanted;', 'return requested === wanted;',
      verifyResend, 'R278 прежняя подписка не повторяет равный слой');
  });

  it('повтор старого качества при любом новом треке отвергается после проверки оригинала', () => {
    // Одна свежесть недостаточна: иначе новый трек не получит изменённый человеком LOW.
    rejectMenuMutation('return freshSubscription && requested === wanted;', 'return freshSubscription;',
      verifyResend, 'R278 новый слой меняется обычным путём');
  });
});

describe('меню качества в окошке показа', () => {
  it('три описанных слоя дают Авто и реальные разрешения сверху вниз с выбором человека', () => {
    // Несортированное описание не должно менять порядок пунктов или выдумывать типовые 1080p.
    const pub = { trackInfo: { layers: [
      { width: 1280, height: 720 }, { width: 640, height: 360 }, { width: 2560, height: 1440 },
    ] } };
    for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
      assert.deepEqual(streamQualityMenu(pref, pub), {
        checked: pref,
        choices: [
          { pref: 'high', label: '1440p' }, { pref: 'medium', label: '720p' }, { pref: 'low', label: '360p' },
        ],
        items: [
          { pref: 'auto', sub: 'лучшее, пока окно видно' },
          { pref: 'high', sub: '1440p' }, { pref: 'medium', sub: '720p' }, { pref: 'low', sub: '360p' },
        ],
      });
    }
  });

  it('два описанных слоя не предлагают средний и отмечают верхний вместо сохранённого среднего', () => {
    // Средний из другого показа здесь не существует, хотя настройка остаётся общей.
    const pub = { trackInfo: { layers: [
      { width: 960, height: 540 }, { width: 1920, height: 1080 },
    ] } };
    assert.deepEqual(streamQualityMenu('medium', pub), {
      checked: 'high',
      choices: [{ pref: 'high', label: '1080p' }, { pref: 'low', label: '540p' }],
      items: [
        { pref: 'auto', sub: 'лучшее, пока окно видно' },
        { pref: 'high', sub: '1080p' }, { pref: 'low', sub: '540p' },
      ],
    });
    for (const pref of ['auto', 'high', 'low'] as const) {
      assert.equal(streamQualityMenu(pref, pub).checked, pref);
    }
  });

  it('описанные слои из codec точнее общего признака simulcasted', () => {
    // Без приоритета описания меню теряет настоящие размеры у VP9 или подменяет их подсказками.
    const pub = { simulcasted: true, trackInfo: { codecs: [{ layers: [
      { width: 720, height: 1280 }, { width: 360, height: 640 },
    ] }] } };
    const result = streamQualityMenu('low', pub);
    assert.deepEqual(result.choices, [{ pref: 'high', label: '720p' }, { pref: 'low', label: '360p' }]);
    assert.deepEqual(result.items, [
      { pref: 'auto', sub: 'лучшее, пока окно видно' },
      { pref: 'high', sub: '720p' }, { pref: 'low', sub: '360p' },
    ]);
    assert.equal(result.checked, 'low');
  });

  it('simulcasted без описания предлагает верхний и экономный без выдуманных разрешений', () => {
    // Наличие нескольких потоков известно, но надпись 720p не подтверждена данными трека.
    for (const trackInfo of [undefined, {}, { layers: [] }]) {
      for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
        assert.deepEqual(streamQualityMenu(pref, { simulcasted: true, trackInfo }), {
          checked: pref === 'medium' ? 'high' : pref,
          choices: [
            { pref: 'high', label: 'как шлёт показывающий' },
            { pref: 'low', label: 'экономит трафик и процессор' },
          ],
          items: [
            { pref: 'auto', sub: 'лучшее, пока окно видно' },
            { pref: 'high', sub: 'как шлёт показывающий' },
            { pref: 'low', sub: 'экономит трафик и процессор' },
          ],
        });
      }
    }
  });

  it('без слоёв остаётся только Авто, даже если ранее был выбран ручной слой', () => {
    // Иначе меню даёт кнопку, которая не способна изменить единственный поток.
    for (const pub of [undefined, {}, { simulcasted: false }, { trackInfo: { layers: [] } },
      { trackInfo: { layers: [{ width: 1920, height: 1080 }] } }]) {
      for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
        assert.deepEqual(streamQualityMenu(pref, pub), {
          checked: 'auto', choices: [], items: [{ pref: 'auto', sub: 'лучшее, пока окно видно' }],
        });
      }
    }
  });

  it('построение меню не сортирует исходное описание и не делит изменяемые пункты между вызовами', () => {
    // Меню сцены и PiP читают одну публикацию, но не должны повреждать друг другу данные.
    const layers = Object.freeze([
      Object.freeze({ width: 640, height: 360 }), Object.freeze({ width: 1920, height: 1080 }),
    ]);
    const pub = Object.freeze({ trackInfo: Object.freeze({ layers }) });
    const first = streamQualityMenu('high', pub);
    first.choices[0].label = 'испорчено';
    first.items[1].sub = 'испорчено';
    const second = streamQualityMenu('high', pub);
    assert.equal(second.choices[0].label, '1080p');
    assert.equal(second.items[1].sub, '1080p');
    assert.deepEqual(layers, [{ width: 640, height: 360 }, { width: 1920, height: 1080 }]);
  });

  it('потеря запасных пунктов simulcasted отвергается после проверки оригинала', () => {
    // Адресный свидетель нужен без описания: описанные слои скрыли бы эту регрессию.
    rejectMenuMutation(': streamHasLayers(pub)', ': false', api => {
      const result = api.streamQualityMenu('low', { simulcasted: true });
      assert.equal(result.choices.map(c => c.pref).join(','), 'high,low', 'неописанный simulcast даёт два выбора');
      assert.equal(result.checked, 'low');
      assert.equal(api.streamQualityMenu('low', undefined).choices.length, 0);
    }, 'неописанный simulcast даёт два выбора');
  });

  it('отметка отсутствующего среднего слоя отвергается после проверки оригинала', () => {
    // Мутант не меняет список пунктов, поэтому проверяем именно отметку, а не только наличие меню.
    rejectMenuMutation('checked: shownPref(pref, choices)', 'checked: pref', api => {
      const two = { trackInfo: { layers: [{ width: 1280, height: 720 }, { width: 640, height: 360 }] } };
      assert.equal(api.streamQualityMenu('medium', two).checked, 'high', 'несуществующий средний отмечает верхний');
      assert.equal(api.streamQualityMenu('low', two).checked, 'low');
    }, 'несуществующий средний отмечает верхний');
  });
});

describe('выбор слоя чужого показа', () => {
  it('без окошка скрытое окно и неоткрытый показ просят экономный слой', () => {
    // Ловит расход полного потока, когда картинку физически никто не видит.
    for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
      assert.equal(wantedLayer(pref, { windowHidden: true, watched: true }), 'low');
      assert.equal(wantedLayer(pref, { windowHidden: false, watched: false }), 'low');
    }
    assert.equal(wantedLayer('auto', { windowHidden: false, watched: true }), 'high');
    assert.equal(wantedLayer('medium', { windowHidden: false, watched: true }), 'medium');
  });

  it('окошко сохраняет выбор человека при скрытом главном окне, авто означает верхний слой', () => {
    // Адресный свидетель игнорирования inPip: картинку поверх игры продолжают смотреть.
    for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
      assert.equal(wantedLayer(pref, { windowHidden: true, watched: true, inPip: true }),
        pref === 'auto' ? 'high' : pref);
    }
  });

  it('явно выключенное окошко не мешает скрытому окну экономить поток', () => {
    // Парный контрфакт: наличие поля inPip не означает открытое окошко.
    for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
      assert.equal(wantedLayer(pref, { windowHidden: true, watched: true, inPip: false }), 'low');
    }
  });

  it('окошко сохраняет выбор и после очистки показов сцены при уходе в текстовый канал', () => {
    // watched=false относится к сцене: её размонтирование не делает вынесенный показ превью.
    for (const windowHidden of [false, true]) {
      for (const pref of ['auto', 'high', 'medium', 'low'] as const) {
        assert.equal(wantedLayer(pref, { windowHidden, watched: false, inPip: true }),
          pref === 'auto' ? 'high' : pref);
        assert.equal(wantedLayer(pref, { windowHidden, watched: false, inPip: false }), 'low');
      }
    }
  });

  it('игнорирование окошка отвергается сценарием скрытого окна после проверки оригинала', () => {
    // Без original-first можно ошибочно засчитать поломку стенда вместо ухудшения видимого показа.
    const source = readFileSync(new URL('./streamQuality.ts', import.meta.url), 'utf8');
    function load(raw: string): typeof import('./streamQuality.js') {
      const module = { exports: {} as typeof import('./streamQuality.js') };
      runInNewContext(ts.transpileModule(raw, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      } }).outputText, {
        module, exports: module.exports,
        localStorage: { getItem: () => null },
        require: (id: string) => {
          assert.equal(id, 'react', `Неописанный импорт качества показа: ${id}`);
          return { useSyncExternalStore: () => assert.fail('Правило выбора слоя не вызывает React-хук') };
        },
      });
      return module.exports;
    }
    const message = 'окошко сохраняет верхний слой под игрой';
    const verify = (api: typeof import('./streamQuality.js')) => {
      assert.equal(api.wantedLayer('auto', { windowHidden: true, watched: true, inPip: true }), 'high', message);
      assert.equal(api.wantedLayer('auto', { windowHidden: true, watched: true, inPip: false }), 'low');
    };
    verify(load(source));
    const from = 'if (!ctx.inPip && (ctx.windowHidden || !ctx.watched))';
    assert.equal(source.split(from).length - 1, 1, 'точка мутации единственная');
    const mutant = load(source.replace(from, 'if (ctx.windowHidden || !ctx.watched)'));
    assert.throws(() => verify(mutant),
      (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message));
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
