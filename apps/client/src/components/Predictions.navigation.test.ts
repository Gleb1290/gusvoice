import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as economy from '../economy';
import * as rules from '../predictionRules';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const source = sourceOf('Predictions');
const noop = () => {};
type Edit = readonly [string, string];
function fixture(raw: string, phone: boolean) {
  let backed = 0, closed = 0, apiCalls = 0;
  const state = { predictions: { s: { enabled: true, canManage: true, events: [], skewMs: 0 } },
    economy: { s: { settings: { gamesFeePercent: 10 } } } };
  const scene = load<typeof import('./Predictions')>(new URL('./Predictions.tsx', import.meta.url), raw, {
    '@gusvoice/shared': shared, '../predictionRules': rules, '../wheelRules': wheel, '../economy': economy,
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state), voiceIsHere: () => true },
    '../api': { api: new Proxy({}, { get: () => () => { apiCalls++; throw new Error('R358/predictions/setup/неожиданный запрос'); } }) },
    '../benchMock': { isMockEconomy: () => false }, '../confirm': { confirmAction: noop },
    '../economyClient': { ensurePredictions: noop }, '../phoneLayout': { usePhoneLayout: () => phone },
    '../assets/predictions/host.png': { default: '/synthetic-host.png' }, '../assets/guscoin.svg': { default: '/synthetic-coin.svg' },
    './Icon': { Icon: () => React.createElement('i') }, './Duel': { useNowTick: () => 0, useDuelPeople: () => noop },
    './BottomSheet': { BottomSheet: ({ children, title, onBack }: { children: React.ReactNode; title: string; onBack: () => void }) =>
      React.createElement('section', { 'data-sheet-title': title }, React.createElement('button', { className: 'sheet-back', onClick: onBack }, 'Назад'), children) },
  }, { requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
  return { element: React.createElement(scene.default, { serverId: 's', onBack: () => { backed++; }, onClose: () => { closed++; } }),
    backed: () => backed, closed: () => closed, apiCalls: () => apiCalls };
}
function one<T extends Element>(host: ParentNode, selector: string): T {
  const all = host.querySelectorAll<T>(selector); assert.equal(all.length, 1, `R358/predictions/check/один ${selector}`); return all[0];
}
async function click(el: HTMLButtonElement) { await React.act(async () => { el.click(); for (let n = 0; n < 6; n++) await Promise.resolve(); }); }
async function check(raw: string, phone: boolean) {
  await environment(async (host, render) => {
    const f = fixture(raw, phone); await render(f.element);
    const back = () => one<HTMLButtonElement>(host, phone ? '.sheet-back' : '.ew-head .wh-back');
    one(host, '.pr-feed');
    if (!phone) assert.equal(back().textContent?.trim(), 'Активности', 'R358/predictions/check/лента — уровень активностей');
    await click(one<HTMLButtonElement>(host, '.pr-new'));
    one(host, '.pr-editor');
    assert.equal(host.querySelector('.pr-feed'), null, 'R358/predictions/check/редактор вместо ленты');
    if (!phone) {
      assert.equal(back().textContent?.trim(), 'Назад', 'R358/predictions/check/редактор внутри события');
      assert.equal(one(host, '#pr-title').textContent?.trim(), 'Новое событие', 'R358/predictions/check/заголовок редактора');
    } else assert.equal(one(host, '[data-sheet-title]').getAttribute('data-sheet-title'), 'Новое событие', 'R358/predictions/check/заголовок листа');
    await click(back());
    assert.equal(f.backed(), 0, 'R358/predictions/check/редактор возвращает в ленту, а не из сцены');
    assert.equal(f.closed(), 0, 'R358/predictions/check/редактор не закрывает сцену');
    one(host, '.pr-feed');
    assert.equal(host.querySelector('.pr-editor'), null, 'R358/predictions/check/редактор убран');
    if (!phone) assert.equal(back().textContent?.trim(), 'Активности', 'R358/predictions/check/подпись ленты восстановлена');
    await click(back());
    assert.equal(f.backed(), 1, 'R358/predictions/check/лента вызывает внешний onBack');
    assert.equal(f.closed(), 0, 'R358/predictions/check/назад — не закрытие');
    assert.equal(f.apiCalls(), 0, 'R358/predictions/check/навигация без API');
  });
}
for (const phone of [false, true]) {
  it(`R358 ${phone ? 'телефон' : 'ПК'}: новое событие возвращает в ленту, лента — к Активностям`, async () => {
    const edits: Edit[] = phone
      ? [["onBack={mode === 'new' ? () => setMode('feed') : onBack}", 'onBack={onBack}']]
      : [["{mode === 'new' ? 'Назад' : 'Активности'}", "{'Активности'}"],
        ["onClick={mode === 'new' ? () => setMode('feed') : onBack}", 'onClick={onBack}'],
        ["onClick={mode === 'new' ? () => setMode('feed') : onBack}", "onClick={mode === 'new' ? () => setMode('feed') : onClose}"]];
    await check(source, phone);
    for (const [from, to] of edits) {
      await counterfact(async () => {
        assert.equal(source.split(from).length - 1, 1, 'R358/predictions/setup/единственная игла');
        await assert.rejects(check(source.replace(from, to), phone),
          e => e instanceof assert.AssertionError && e.message.startsWith('R358/predictions/check/'),
          'контрфакт нарушает навигацию, не падает на загрузке/эффекте');
      });
      await check(source, phone);
    }
  });
}
