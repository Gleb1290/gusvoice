import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EFFECT_MS,
  FEATHER_COUNT,
  FEATHER_COUNT_MAX,
  featherCount,
  freshEffects,
  pendingEffects,
  planEffect,
  targetPoint,
  type EffectConditions,
} from './effects.js';

const ok = (patch: Partial<EffectConditions> = {}): EffectConditions => ({
  tabHidden: false,
  fullscreen: false,
  sameServer: true,
  reducedMotion: false,
  target: { x: 100, y: 20 },
  ...patch,
});

describe('что показывать при таких условиях', () => {
  it('в обычной обстановке летим в цель', () => {
    assert.deepEqual(planEffect(ok()), { kind: 'fly', to: { x: 100, y: 20 } });
  });

  it('🔴 цели нет — показываем НА МЕСТЕ, а не летим по угаданным координатам', () => {
    // Узкое окно, свёрнутый сайдбар, открытые ЛС: чипа на экране нет. Полёт «примерно туда» — это и
    // есть тот баг, который вылезает у одного человека из семнадцати.
    assert.deepEqual(planEffect(ok({ target: null })), { kind: 'inplace' });
  });

  it('скрытая вкладка — не показываем и НЕ откладываем', () => {
    // rAF в фоне не идёт вовсе; всплывшее через двадцать минут читается как поломка.
    assert.deepEqual(planEffect(ok({ tabHidden: true })), { kind: 'skip', reason: 'hidden' });
  });

  it('полноэкранный показ — не лезем поверх', () => {
    assert.deepEqual(planEffect(ok({ fullscreen: true })), { kind: 'skip', reason: 'fullscreen' });
  });

  it('🔴 событие с ДРУГОГО сервера — отказ, а не запасной вид', () => {
    // Вспышка без понятного контекста читается как сбой, а не как награда.
    assert.deepEqual(planEffect(ok({ sameServer: false })), { kind: 'skip', reason: 'other-server' });
  });

  it('выключенная анимация — смена состояния без движения', () => {
    // Полный экран и вращение — два самых рискованных типа движения для вестибулярных расстройств,
    // а осыпание перьев это оба сразу. Ускоренная версия тут не подходит: убирать надо ДВИЖЕНИЕ.
    assert.deepEqual(planEffect(ok({ reducedMotion: true })), { kind: 'static' });
  });

  it('порядок проверок: отказы РАНЬШЕ доступности', () => {
    // Иначе человек с выключенной анимацией «показывал» бы эффекты в скрытой вкладке.
    assert.deepEqual(planEffect(ok({ reducedMotion: true, tabHidden: true })), { kind: 'skip', reason: 'hidden' });
  });

  it('порядок проверок: скрытая вкладка важнее чужого сервера', () => {
    assert.deepEqual(planEffect(ok({ tabHidden: true, sameServer: false })), { kind: 'skip', reason: 'hidden' });
  });
});

describe('где цель', () => {
  const vp = { width: 1200, height: 800 };

  it('центр видимого прямоугольника', () => {
    assert.deepEqual(targetPoint({ left: 100, top: 40, width: 60, height: 20 }, vp), { x: 130, y: 50 });
  });

  it('узла нет — цели нет', () => {
    assert.equal(targetPoint(null, vp), null);
  });

  it('нулевые размеры считаем отсутствием цели', () => {
    // `display: none` и ещё не смонтированный узел дают нули, а не отсутствие прямоугольника.
    assert.equal(targetPoint({ left: 10, top: 10, width: 0, height: 0 }, vp), null);
  });

  it('🔴 за краем окна цели нет, даже если узел в дереве', () => {
    // Свёрнутый сайдбар оставляет чип в DOM, но уводит за экран — полёт ушёл бы за границу.
    assert.equal(targetPoint({ left: -300, top: 40, width: 60, height: 20 }, vp), null);
    assert.equal(targetPoint({ left: 1400, top: 40, width: 60, height: 20 }, vp), null);
  });
});

describe('числа эффектов', () => {
  it('частые эффекты укладываются в правило 500 мс для повторяемых действий', () => {
    assert.ok(EFFECT_MS.tip <= 500);
  });

  it('редкий праздничный эффект длиннее, но с потолком', () => {
    // ⚠️ Эффект рос дважды по живой проверке: 2600 → 4200 (перья не успевали пролететь окно) →
    // 6500 («слишком коротко для своей цены»). Потолок остаётся — бесконечный эффект читается как
    // зависание, — но он про здравый предел, а не про круглое число: восемь секунд это уже не
    // награда, а ожидание.
    assert.ok(EFFECT_MS.feathers > EFFECT_MS.tip);
    assert.ok(EFFECT_MS.feathers <= 8000);
  });

  it('частиц заведомо меньше границы, на которой канва проседает', () => {
    // 60 кадров держатся на 200–300 частицах, на 1000+ падает до 22. Эффект срабатывает как раз
    // тогда, когда запас производительности у человека минимальный: он играет или смотрит показ.
    assert.ok(FEATHER_COUNT <= 200);
  });

  it('плотность растёт с площадью окна', () => {
    // Постоянное число частиц на широком мониторе выглядит редкой пылью, а не осыпанием: именно
    // это и было «перьев маловато» на живой проверке.
    assert.ok(featherCount(3440, 1440) > featherCount(1920, 1080));
    assert.ok(featherCount(1920, 1080) > featherCount(1366, 768));
    assert.ok(featherCount(7680, 4320) <= FEATHER_COUNT_MAX, 'потолок обязан оставаться');
    assert.ok(featherCount(320, 240) >= FEATHER_COUNT, 'на крошечном окне осыпание не должно исчезать');
  });
});

describe('очередь отложенных эффектов', () => {
  const item = (at: number, id = String(at)) => ({ at, id });

  it('новый встаёт в конец', () => {
    const out = pendingEffects([item(100, 'a')], item(200, 'b'), { now: 200, maxAgeMs: 1000, max: 3 });
    assert.deepEqual(out.map((q) => q.id), ['a', 'b']);
  });

  it('🔴 `front` возвращает припаркованный ПЕРЕД теми, кто встал за ним', () => {
    // Иначе порядок «кто когда щипнул» переврётся: припаркованный прилетел раньше.
    const out = pendingEffects([item(200, 'b')], item(100, 'a'), { now: 200, maxAgeMs: 1000, max: 3, front: true });
    assert.deepEqual(out.map((q) => q.id), ['a', 'b']);
  });

  it('🔴 протухшее выбрасывается: вернулся через час — залпа за вечер не будет', () => {
    const out = pendingEffects([item(0, 'old')], item(5000, 'new'), { now: 5000, maxAgeMs: 1000, max: 3 });
    assert.deepEqual(out.map((q) => q.id), ['new']);
  });

  it('ровно на границе срока уже протухло', () => {
    assert.deepEqual(freshEffects([item(0)], 1000, 1000), []);
    assert.deepEqual(freshEffects([item(0)], 999, 1000).length, 1);
  });

  it('потолок держится: очередь не запирает человека под осыпанием', () => {
    const list = [item(1, 'a'), item(2, 'b'), item(3, 'c')];
    const out = pendingEffects(list, item(4, 'd'), { now: 4, maxAgeMs: 1000, max: 3 });
    assert.equal(out.length, 3);
    // Лишним оказывается САМЫЙ НОВЫЙ: потерять четвёртый подряд лучше, чем перевернуть очередь.
    assert.deepEqual(out.map((q) => q.id), ['a', 'b', 'c']);
  });

  it('припаркованный вытесняет самый новый, а не сам себя', () => {
    const list = [item(2, 'b'), item(3, 'c'), item(4, 'd')];
    const out = pendingEffects(list, item(1, 'a'), { now: 4, maxAgeMs: 1000, max: 3, front: true });
    assert.deepEqual(out.map((q) => q.id), ['a', 'b', 'c']);
  });
});
