import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as rules from './stageOrderRules';
import * as drag from './useStageDrag';

type Drag = typeof drag;
const source = readFileSync(new URL('./useStageDrag.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string): Drag {
  const module = { exports: {} as Drag };
  const js = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: (id: string) => {
    if (id === 'react') return React;
    if (id === './stageOrderRules') return rules;
    throw Error(`Неизвестный импорт ${id}`);
  } });
  return module.exports;
}
function mutation(anchor: string, replacement: string, check: (module: Drag) => void): void {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь мутанта должен однозначно обозначать реальный код');
  check(drag); // сначала убеждаемся, что контракт описывает настоящий, не мутированный модуль.
  assert.throws(() => check(load(source.replace(anchor, replacement))), assert.AssertionError);
}

// Класс ошибки: край и скорость дрейфуют независимо от поведения, заданного для автопрокрутки.
it('R247 край автопрокрутки и максимальный шаг остаются 48 и 12 экранных пикселей', () => {
  assert.equal(drag.STAGE_DRAG_EDGE_PX, 48);
  assert.equal(drag.STAGE_DRAG_EDGE_SPEED_PX, 12);
});

// Класс ошибки: край зоны включается раньше/позже, или корректная точка внутри получает нулевой шаг.
it('R247 вне зоны и на её точной границе шаг нулевой, сразу внутри он уже не меньше одного', () => {
  const { stageEdgeScrollStep: step } = drag;
  assert.equal(step(200, 100, 300, 48, 12), 0); // середина контейнера.
  assert.equal(step(148.01, 100, 300, 48, 12), 0); // сразу снаружи левой зоны.
  assert.equal(step(251.99, 100, 300, 48, 12), 0); // сразу снаружи правой зоны.
  assert.equal(step(148, 100, 300, 48, 12), 0); // точная граница левой зоны исключена.
  assert.equal(step(252, 100, 300, 48, 12), 0); // точная граница правой зоны исключена.
  assert.equal(step(147.99, 100, 300, 48, 12), -1); // микроскопический остаток округлился бы к нулю без нижней границы.
  assert.equal(step(252.01, 100, 300, 48, 12), 1);
});

// Класс ошибки: знак меняет направление, а ограничение скорости исчезает у самого края.
it('R247 у края и за ним шаг направлен внутрь контейнера и ограничен максимумом', () => {
  const { stageEdgeScrollStep: step } = drag;
  assert.equal(step(100, 100, 300, 48, 12), -12);
  assert.equal(step(70, 100, 300, 48, 12), -12);
  assert.equal(step(300, 100, 300, 48, 12), 12);
  assert.equal(step(330, 100, 300, 48, 12), 12);
  assert.equal(step(100, 100, 300, 48, 12), -step(300, 100, 300, 48, 12));
});

// Класс ошибки: линейная скорость округляется не до ближайшего целого или меняется наклон у границы.
it('R247 шаг растёт линейно от зоны к краю с округлением Math.round', () => {
  const { stageEdgeScrollStep: step } = drag;
  assert.equal(step(123, 100, 300, 48, 12), -6); // 12 × 25/48 = 6,25.
  assert.equal(step(122, 100, 300, 48, 12), -7); // 12 × 26/48 = 6,5 → 7.
  assert.equal(step(124, 100, 300, 48, 12), -6); // 12 × 24/48 = 6.
  assert.equal(step(140, 100, 300, 48, 12), -2); // 12 × 8/48 = 2.
  assert.equal(step(260, 100, 300, 48, 12), 2);
});

// Класс ошибки: тесный контейнер прокручивается сразу с заметной скоростью вместо минимума у четверти.
it('R247 на тесном размере зона ограничена четвертью контейнера', () => {
  const { stageEdgeScrollStep: step } = drag;
  assert.equal(step(126.67, 100, 180, 48, 12), 0); // pos=start+size/3: вне capped-зоны.
  assert.equal(step(120, 100, 180, 48, 12), 0); // pos=start+size/4 — точная граница.
  assert.equal(step(119.99, 100, 180, 48, 12), -1); // сразу внутри зоны остаётся минимальный шаг.
  assert.equal(step(100, 100, 180, 48, 12), -12);
  assert.equal(step(180, 100, 180, 48, 12), 12);
});

// Класс ошибки: некорректный нулевой лимит создаёт движение, NaN-скорость или деление на ноль.
it('R247 неположительная зона или максимальная скорость выключают шаг', () => {
  const { stageEdgeScrollStep: step } = drag;
  for (const zone of [0, -1]) {
    assert.equal(step(100, 100, 300, zone, 12), 0);
    assert.equal(step(150, 100, 300, zone, 12), 0);
  }
  for (const max of [0, -1]) {
    assert.equal(step(100, 100, 300, 48, max), 0);
    assert.equal(step(120, 100, 300, 48, max), 0);
  }
  for (const [start, end] of [[100, 100], [100, 80]]) {
    assert.equal(step(100, start, end, 48, 12), 0, 'нулевой или перевёрнутый размер не задаёт активных краёв');
  }
});

// Класс ошибки: обе равные границе зоны ошибочно активируются или центр выбирает произвольное направление.
it('R247 равноудалённая центральная точка не попадает ни в один край', () => {
  // При валидном size положительные зоны не перекрываются: z <= size/4 < size/2.
  // Поэтому равенство расстояний возможно только вне обеих зон; tie-break между краями недостижим по контракту.
  assert.equal(drag.stageEdgeScrollStep(200, 100, 300, 48, 12), 0);
});

// Класс ошибки: знак, нижняя граница 1 px или ограничение зоны не защищены регрессионной проверкой.
it('R247 мутанты направления, минимального шага и четверти размера убиваются', () => {
  const directions = (m: Drag) => {
    assert.equal(m.stageEdgeScrollStep(100, 100, 300, 48, 12), -12);
    assert.equal(m.stageEdgeScrollStep(300, 100, 300, 48, 12), 12);
  };
  mutation('return -speed(toStart);', 'return speed(toStart);', directions);

  const minStep = (m: Drag) => assert.equal(m.stageEdgeScrollStep(147.99, 100, 300, 48, 12), -1);
  mutation('Math.max(1, Math.round(max * Math.min(1, (z - Math.max(0, d)) / z)))', 'Math.round(max * Math.min(1, (z - Math.max(0, d)) / z))', minStep);

  const cap = (m: Drag) => assert.equal(m.stageEdgeScrollStep(119.99, 100, 180, 48, 12), -1);
  mutation('const z = Math.min(zone, size / 4);', 'const z = zone;', cap);
});
