import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { pinchStep } from './lightboxZoom';
import {
  dismissDim, dismissResult, gestureAxis, isDoubleTap, nearMediaEdge, pageDragOffset, pageSwipeResult,
  stripWindow, tapZone, wheelPageStep, wheelZoomStep, zoomAt,
} from './lightboxGestures';

describe('жесты просмотрщика', () => {
  it('различает оси касания, листает по порогу или согласованному броску и упруго удерживает край', () => {
    // Случайное изменение порогов превращает диагональ или бросок назад в неожиданный переход между личными фото.
    assert.equal(gestureAxis(9, 9), 'wait');
    assert.equal(gestureAxis(20, 5), 'page');
    assert.equal(gestureAxis(5, 20), 'dismiss');
    assert.equal(gestureAxis(0, -25), 'dismiss');
    assert.equal(gestureAxis(15, 20), 'none');
    assert.equal(pageSwipeResult(-100, 0, 300, true, true), 0, 'ровно треть ширины ещё не перелистывает');
    assert.equal(pageSwipeResult(-101, 0, 300, true, true), 1, 'за треть ширины листает вперёд');
    assert.equal(pageSwipeResult(0, -700, 300, true, true), 0, 'бросок без сдвига не задаёт направление');
    assert.equal(pageSwipeResult(-5, -700, 300, true, true), 1, 'быстрый бросок по направлению сдвига листает');
    assert.equal(pageSwipeResult(-5, 700, 300, true, true), 0, 'бросок против движения возвращает текущую страницу');
    assert.equal(pageSwipeResult(-120, 0, 300, true, false), 0, 'за отсутствующим соседом не листает');
    assert.equal(pageSwipeResult(120, 0, 300, false, true), 0, 'предыдущей страницы тоже может не быть');
    assert.equal(pageDragOffset(90, false, true), 30, 'у края движение сжимается втрое');
    assert.equal(pageDragOffset(-90, false, true), -90, 'свободное направление не замедляется');
  });

  it('закрывает только за H/6, затемняет до пола и точно задаёт зоны тапов', () => {
    // Ошибка на границе делает жест закрытия слишком чувствительным или не позволяет закрыть просмотр вообще.
    assert.equal(dismissResult(100, 600), false, 'ровно шестая часть высоты не закрывает');
    assert.equal(dismissResult(101, 600), true, 'чуть дальше границы закрывает');
    assert.equal(dismissResult(900, 600), true);
    assert.equal(dismissDim(0, 600), 1);
    assert.equal(dismissDim(300, 600), 0.15, 'у половины высоты фон уже на минимальной яркости');
    assert.equal(dismissDim(900, 600), 0.15, 'затемнение не уходит ниже пола');
    assert.equal(tapZone(99, 800), -1);
    assert.equal(tapZone(100, 800), 0, 'сама граница зоны не считается краем');
    assert.equal(tapZone(400, 800), 0);
    assert.equal(tapZone(700, 800), 0);
    assert.equal(tapZone(701, 800), 1);
    assert.equal(tapZone(134, 2_000), -1, 'полоса ограничена 135 пикселями');
    assert.equal(tapZone(135, 2_000), 0);
  });

  it('двойной тап, масштабирование под курсором и колесо сохраняют ожидаемую геометрию', () => {
    // Центрирование вместо точки касания заметно уводило бы фото из-под пальца во время приближения.
    assert.equal(isDoubleTap({ t: 100, x: 20, y: 30 }, 360, 50, 30), true, 'обе границы двойного тапа включительны');
    assert.equal(isDoubleTap({ t: 100, x: 20, y: 30 }, 361, 50, 30), false, 'поздний тап уже отдельный');
    assert.equal(isDoubleTap({ t: 100, x: 20, y: 30 }, 200, 51, 30), false, 'далёкий тап уже отдельный');
    const zoomed = zoomAt({ zoom0: 1, pan0: { x: 0, y: 0 }, center: { x: 100, y: 100 }, point: { x: 130, y: 120 }, zoom: 2, min: 0.5, max: 3 });
    assert.deepEqual(zoomed, { zoom: 2, pan: { x: -30, y: -20 } }, 'точка (130,120) остаётся на месте при увеличении');
    assert.equal(zoomAt({ zoom0: 1, pan0: { x: 0, y: 0 }, center: { x: 0, y: 0 }, point: { x: 0, y: 0 }, zoom: 9, min: 0.5, max: 2 }).zoom, 2, 'масштаб не выше max');
    assert.equal(zoomAt({ zoom0: 1, pan0: { x: 0, y: 0 }, center: { x: 0, y: 0 }, point: { x: 0, y: 0 }, zoom: 0.1, min: 0.5, max: 2 }).zoom, 0.5, 'масштаб не ниже min');
    assert.equal(wheelZoomStep(1, -1, 0.5, 3), 1.25);
    assert.equal(wheelZoomStep(3, -1, 0.5, 3), 3);
    assert.equal(wheelZoomStep(1, 1, 0.5, 3), 0.75);
    assert.equal(wheelZoomStep(1, 0, 0.5, 3), 1);
    assert.deepEqual(wheelPageStep(15, 0, 20, 0), { acc: 35, step: 0 });
    assert.deepEqual(wheelPageStep(35, 0, 5, 0), { acc: 0, step: 1 }, 'накопленные 40 px листают и сбрасывают серию');
    assert.deepEqual(wheelPageStep(0, -1, 0, 1), { acc: 0, step: -1 }, 'строчный режим листает одним событием');
    assert.deepEqual(wheelPageStep(0, 20, -10, 0), { acc: 20, step: 0 }, 'берётся направление большей оси');
  });

  it('окно миниатюр и подгрузка медиа включают края без выхода за длину', () => {
    // На больших историях окно ограничивает DOM, а граница загрузки должна включать последний допустимый индекс.
    assert.deepEqual(stripWindow(0, 0), [0, 0]);
    assert.deepEqual(stripWindow(5, 0), [0, 5]);
    assert.deepEqual(stripWindow(100, 50), [30, 71]);
    assert.deepEqual(stripWindow(100, 99), [59, 100]);
    assert.equal(nearMediaEdge(0, 0), 0);
    assert.equal(nearMediaEdge(2, 20), -1);
    assert.equal(nearMediaEdge(3, 20), 0);
    assert.equal(nearMediaEdge(17, 20), 1);
    assert.equal(nearMediaEdge(16, 20), 0);
  });

  it('реальные мутанты ломают бросок, порог края, закрытие и резиновое сопротивление', () => {
    // Четыре независимые регрессии были бы заметны только на точной границе или при потере соседа.
    const source = readFileSync(fileURLToPath(new URL('./lightboxGestures.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const load = (code: string) => {
      const module = { exports: {} as Record<string, unknown> };
      runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module, exports: module.exports,
        require(id: string) { assert.equal(id, './lightboxZoom', 'zoomAt использует только чистые pinch rules'); return { pinchStep }; },
      });
      return module.exports as typeof import('./lightboxGestures');
    };
    const reject = (mutant: string, check: (api: ReturnType<typeof load>) => void, message: string) => {
      assert.notEqual(mutant, source, `${message}: mutation applies`);
      const api = load(mutant);
      assert.throws(() => check(api), assert.AssertionError, message);
    };
    const fling = source.replace('Math.sign(vx) === Math.sign(dx)', 'true');
    reject(fling, (api) => assert.equal(api.pageSwipeResult(-5, 700, 300, true, true), 0, 'противоположный бросок не листает'), 'удалённая проверка направления броска');
    const edge = source.replace('index >= len - 1 - margin', 'index > len - 1 - margin');
    reject(edge, (api) => assert.equal(api.nearMediaEdge(17, 20), 1, 'сам индекс границы уже близко к краю'), 'исключённая граница подгрузки');
    const dismiss = source.replace('dy > height / 6', 'dy > height / 3');
    reject(dismiss, (api) => assert.equal(api.dismissResult(101, 600), true, 'превышение H/6 закрывает viewer'), 'порог закрытия ошибочно сдвинут на H/3');
    const noRubber = source.replace('return blocked ? dx / 3 : dx;', 'return dx;');
    reject(noRubber, (api) => assert.equal(api.pageDragOffset(90, false, true), 30, 'отсутствующий предыдущий сосед создаёт резину'), 'отсутствует резиновое сопротивление');
  });
});
