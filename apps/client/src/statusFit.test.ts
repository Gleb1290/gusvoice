import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as text from './lastSeenText';
import { React, environment } from './components/R171.phoneHarness';
import type * as Fit from './statusFit';

const source = readFileSync(new URL('./statusFit.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source, globals: Record<string, unknown> = {}): typeof Fit {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, ...globals,
    require: (id: string) => {
      if (id === 'react') return React;
      assert.equal(id, './lastSeenText', 'явная чистая граница формулировок'); return text;
    } });
  return module.exports as typeof Fit;
}
function changed(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь мутанта');
  return source.replace(anchor, replacement);
}
const date = (day: number, h: number, m = 0, s = 0) => new Date(2026, 9, day, h, m, s);
function forms(at: Date | null, now: Date, tail: string[], raw = source) {
  const seen = { online: false, at: at?.toISOString() ?? null, approx: null };
  assert.deepEqual(Array.from(load(raw).lastSeenForms(seen, now)), [text.lastSeenLabel(seen, now), ...tail], 'формы от полной к короткой');
}
for (const [name, at, now, tail] of [
  ['только что, 59 секунд', date(12, 20, 0, 1), date(12, 20, 1), ['только что']],
  ['одна минута', date(12, 20), date(12, 20, 1), ['был(а) 1 мин назад', '1 мин назад']],
  ['59 минут', date(12, 19, 1), date(12, 20), ['был(а) 59 мин назад', '59 мин назад']],
  ['60 минут', date(12, 19), date(12, 20), ['был(а) 1 ч назад', '1 ч назад']],
  ['11 часов 59 минут', date(12, 8, 1), date(12, 20), ['был(а) 11 ч назад', '11 ч назад']],
  ['12 часов сегодня', date(12, 3, 53), date(12, 15, 53), ['был(а) в 03:53']],
  ['вчера после полудня', date(11, 3, 53), date(12, 15), ['вчера в 03:53']],
  ['ночью в шесть, заход после 18', date(11, 19), date(12, 6), ['был(а) 11 ч назад', '11 ч назад']],
  ['в шесть пятьдесят девять, заход в 19', date(11, 19), date(12, 6, 59), ['был(а) 11 ч назад', '11 ч назад']],
  ['в семь, заход в 19', date(11, 19), date(12, 7), ['вчера в 19:00']],
  ['в шесть, заход ровно в 18', date(11, 18), date(12, 6), ['вчера в 18:00']],
  ['давность более суток без дополнительных форм', date(10, 23, 30), date(12, 6), []],
  ['будущая дата', date(12, 20, 1), date(12, 20), ['только что']],
] as const) it(`R182 статус «${name}» сохраняет полную форму первой и правильные сокращения`, () => {
  // Ошибка временной границы меняет смысл статуса или сокращает его до измерения ширины.
  forms(at, now, [...tail]);
});
it('R182 полночь переводит сегодня во вчера, старая дата остаётся единственной формой', () => {
  // Календарный день, а не ровно 24 часа, определяет слово «вчера».
  forms(date(11, 3, 53), date(11, 23, 59), ['был(а) в 03:53']);
  forms(date(11, 3, 53), date(12, 0), ['вчера в 03:53']);
  forms(date(9, 3, 53), date(12, 0), []);
});
it('R182 все 1–59 минут и 1–11 часов имеют полную, сокращённую и минимальную формы в том же порядке', () => {
  // Сокращение сохраняет число на всём диапазоне, а не только на выбранных примерах.
  const now = date(12, 20);
  for (let n = 1; n < 60; n++) forms(new Date(now.getTime() - n * 60000), now, [`был(а) ${n} мин назад`, `${n} мин назад`]);
  for (let n = 1; n < 12; n++) forms(new Date(now.getTime() - n * 3600000), now, [`был(а) ${n} ч назад`, `${n} ч назад`]);
});
it('R182 online, отсутствующее и битое время и все примерные статусы не создают запасных форм', () => {
  // Примерный статус нельзя превращать в выдуманное точное время.
  const now = date(12, 20);
  for (const approx of [null, 'recently', 'week', 'month', 'long'] as const) {
    const v = { online: false, at: null, approx };
    assert.deepEqual(Array.from(load().lastSeenForms(v, now)), [text.lastSeenLabel(v, now)]);
  }
  for (const v of [{ online: true, at: date(12, 3).toISOString(), approx: null },
    { online: false, at: 'bad-date', approx: 'recently' as const }])
    assert.deepEqual(Array.from(load().lastSeenForms(v, now)), [text.lastSeenLabel(v, now)]);
});
it('R182 выбор формы берёт первую необрезанную, последнюю при тесноте и безопасен для нуля и одной формы', () => {
  // Перебор не должен выходить за список или пропускать полностью помещающийся статус.
  const r = load();
  for (const count of [0, 1]) assert.equal(r.pickStatusForm(count, () => assert.fail('лишняя проба')), 0);
  for (const fits of [0, 1, 2, -1]) {
    const calls: number[] = [];
    assert.equal(r.pickStatusForm(3, i => { calls.push(i); return i !== fits; }), fits < 0 ? 2 : fits);
    assert.deepEqual(calls, fits === 0 ? [0] : [0, 1]);
  }
});
function fake(widths = [120, 80, 40], available = 80) {
  const nodes = widths.map((_, i) => ({ hidden: i > 0 }));
  let reads = 0;
  const status = { isConnected: true, clientWidth: available,
    querySelectorAll: () => { reads++; return nodes; },
    get scrollWidth() { return widths[nodes.findIndex(n => !n.hidden)] ?? 0; } };
  return { status: status as unknown as HTMLElement, nodes, reads: () => reads, widths };
}
function fit(raw = source) {
  const r = load(raw);
  for (const [space, chosen] of [[121, 0], [120, 0], [119, 1], [80, 1], [79, 2], [0, 2]]) {
    const f = fake(undefined, space); r.fitStatusForms(f.status);
    assert.equal(f.nodes.filter(n => !n.hidden).length, 1, 'видна ровно одна форма');
    assert.equal(f.nodes.findIndex(n => !n.hidden), chosen, 'первая помещающаяся форма');
  }
  const single = fake([90], 0); single.nodes[0].hidden = true;
  r.fitStatusForms(single.status); assert.equal(single.nodes[0].hidden, true, 'одноформный DOM не меняется');
  const empty = fake([]); r.fitStatusForms(empty.status); assert.equal(empty.nodes.length, 0);
}
it('R182 измерение ширины выбирает ровно одну форму, равная ширина помещается, одноформный DOM не трогается', () => {
  // Фейковые размеры проверяют решение, не несуществующий layout happy-dom.
  fit();
});
async function hook(raw = source, unmountBeforeFont = false) {
  await environment(async (_host, render) => {
    const f = fake(); let barWidth = 300, actionWidth = 60;
    const actions = { get offsetWidth() { return actionWidth; } };
    const bar = { get clientWidth() { return barWidth; }, querySelector: () => actions };
    Object.assign(f.status, { closest: () => bar });
    let ready!: () => void; const fontReady = new Promise<void>(resolve => { ready = resolve; });
    const observers: Array<{ callback: () => void; observed: unknown[]; disconnected: boolean }> = [];
    class Observer {
      entry: typeof observers[number];
      constructor(callback: () => void) { this.entry = { callback, observed: [], disconnected: false }; observers.push(this.entry); }
      observe(node: unknown) { this.entry.observed.push(node); }
      disconnect() { this.entry.disconnected = true; }
    }
    const r = load(raw, { ResizeObserver: Observer, document: { fonts: { ready: fontReady } } });
    const ref = { current: f.status };
    function Probe({ value }: { value: string }) { r.useStatusFit(ref, value); return null; }
    await render(React.createElement(Probe, { value: 'first' }));
    assert.equal(observers.length, 1, 'наблюдатель ширины подключён');
    assert.equal(observers[0].observed.length, 2, 'наблюдаются шапка и кнопки');
    const before = f.reads(); observers[0].callback(); assert.equal(f.reads(), before, 'одинаковая ширина не перемеряется');
    barWidth++; observers[0].callback(); assert.equal(f.reads(), before + 1);
    actionWidth++; observers[0].callback(); assert.equal(f.reads(), before + 2);
    await render(React.createElement(Probe, { value: 'first' })); assert.equal(f.reads(), before + 2);
    await render(React.createElement(Probe, { value: 'second' }));
    assert.equal(f.reads(), before + 3, 'смена key перемеряет'); assert.equal(observers[0].disconnected, true);
    if (unmountBeforeFont) await render(null);
    const beforeFont = f.reads(); await React.act(async () => { ready(); await fontReady; });
    assert.equal(f.reads(), beforeFont + (unmountBeforeFont ? 0 : 1), 'шрифт перемеряет только живой effect');
    await render(null); assert.equal(observers[1].disconnected, true, 'unmount отключает наблюдатель');
    const after = f.reads(); await React.act(async () => { await fontReady; }); assert.equal(f.reads(), after);
  });
}
it('R182 hook реагирует на key, ширину шапки и кнопок и загрузку шрифта, сохраняя тишину при прежней ширине и cleanup', async () => {
  // Зацикленный observer перегружает шапку, забытая отписка меняет уже закрытый экран.
  await hook();
});
it('R182 шрифт, догрузившийся после unmount, не перемеряет закрытый статус', async () => {
  // Отложенное обещание не должно обходить cleanup, даже если fake-DOM ещё isConnected.
  await hook(source, true);
});
it('R182 hook безопасен без текущего узла, шапки, ResizeObserver и API шрифтов', async () => {
  // Старый браузер и ещё не установленный ref не должны ломать первое открытие беседы.
  await environment(async (_host, render) => {
    const f = fake(); Object.assign(f.status, { closest: () => null });
    const r = load(source, { document: {} });
    const ref = { current: null as HTMLElement | null };
    function Probe({ value }: { value: string }) { r.useStatusFit(ref, value); return null; }
    await render(React.createElement(Probe, { value: 'empty' })); assert.equal(f.reads(), 0);
    ref.current = f.status;
    await render(React.createElement(Probe, { value: 'mounted' }));
    assert.equal(f.reads(), 1); assert.equal(f.nodes.findIndex(n => !n.hidden), 1);
    await render(null);
  });
});
for (const [name, anchor, replacement] of [
  ['всегда форма номер один', 'const idx = pickStatusForm(list.length, (i) => {\n    show(i);\n    return status.scrollWidth > status.clientWidth;\n  });', 'const idx = 1;'],
  ['перевёрнутая теснота', 'status.scrollWidth > status.clientWidth', 'status.scrollWidth < status.clientWidth'],
] as const) it(`R182 мутант «${name}» отвергается измерением ширины`, () => {
  // Whole-module original-first и адресное утверждение проверяют именно выбор формы.
  fit(); assert.throws(() => fit(changed(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes('первая помещающаяся'));
});
it('R182 потеря ResizeObserver обнаруживается подпиской hook на реальные изменения ширины', async () => {
  // Без observer первоначально верная форма устаревает после изменения кнопок шапки.
  await hook(); await assert.rejects(hook(changed("bar && typeof ResizeObserver !== 'undefined'", 'false')),
    e => e instanceof assert.AssertionError && e.message.includes('наблюдатель ширины'));
});
for (const [name, anchor, replacement, at, now, tail] of [
  ['сегодня без короткой формы', 'return [full, `был(а) в ${hhmm(at)}`];', 'return [full];', date(12, 3, 53), date(12, 20), ['был(а) в 03:53']],
  ['вчера без короткой формы', 'const forms = [full, `вчера в ${hhmm(at)}`];', 'const forms = [full];', date(11, 3, 53), date(12, 20), ['вчера в 03:53']],
] as const) it(`R182 мутант «${name}» обнаруживается сохранением читаемой формы`, () => {
  // Короткая форма нужна только при тесноте, но должна существовать до замера.
  forms(at, now, [...tail]); assert.throws(() => forms(at, now, [...tail], changed(anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes('формы от полной'));
});
