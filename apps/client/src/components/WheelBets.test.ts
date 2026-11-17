import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { WheelBetDto } from '@gusvoice/shared';
import * as rules from '../wheelRules';
import type { WheelBetsProps } from './WheelBets';
import { React, environment, load, sourceOf, click } from './R171.phoneHarness';

function component() {
  return load<typeof import('./WheelBets')>(new URL('./WheelBets.tsx', import.meta.url), sourceOf('WheelBets'), {
    '../wheelRules': rules,
  }).WheelBets;
}
const bet = (userId: string, amount = 10, pick: WheelBetDto['pick'] = 1): WheelBetDto => ({ userId, amount, pick });
const roster = (count: number, prefix = 'user') => Array.from({ length: count }, (_, i) => bet(`${prefix}${i + 1}`));
const props = (bets: readonly WheelBetDto[], changes: Partial<WheelBetsProps> = {}): WheelBetsProps => ({
  roundId: 'round-1', bets, nameOf: id => id, avatarOf: () => null, meId: null, ...changes,
});
const cards = (host: ParentNode) => Array.from(host.querySelectorAll('li:not([aria-hidden="true"])'));
const names = (host: ParentNode) => cards(host).map(card => card.querySelector('.wh-live-bets-name')?.textContent);
const previous = '[aria-label="Предыдущая страница ставок"]';
const next = '[aria-label="Следующая страница ставок"]';
const disabled = (host: ParentNode, selector: string) => host.querySelector<HTMLButtonElement>(selector)?.disabled;

it('два выбора участника объединяются в сумму ставок, отдельно видны выбранные числа и суммы', async () => {
  await environment(async (host, render) => {
    const WheelBets = component();
    await render(React.createElement(WheelBets, props([bet('me', 10, 1), bet('other', 7, 20), bet('me', 30, 5)], {
      meId: 'me', nameOf: id => id === 'me' ? 'Ты' : 'Сосед',
    })));
    assert.deepEqual(names(host), ['Ты', 'Сосед']);
    assert.equal(cards(host)[0].querySelector('strong')?.textContent?.trim(), '40');
    assert.equal(cards(host)[0].querySelector('.wh-live-bets-picks')?.textContent, 'На 1: 10 · На 5: 30');
    assert.equal(cards(host)[1].querySelector('strong')?.textContent?.trim(), '7');
    assert.equal(host.querySelector('h3')?.textContent, 'Ставки раунда · 2');
    assert.equal(host.querySelectorAll('li').length, 4);
    assert.equal(disabled(host, previous), true);
    assert.equal(disabled(host, next), true);
  });
});

it('девять участников листаются по четыре, последняя страница сохраняет четыре места', async () => {
  await environment(async (host, render) => {
    const WheelBets = component();
    await render(React.createElement(WheelBets, props(roster(9))));
    assert.deepEqual(names(host), ['user1', 'user2', 'user3', 'user4']);
    assert.equal(host.querySelector('[aria-live]')?.textContent, '1/3');
    assert.equal(disabled(host, previous), true);
    await click(host, next);
    assert.deepEqual(names(host), ['user5', 'user6', 'user7', 'user8']);
    await click(host, next);
    assert.deepEqual(names(host), ['user9']);
    assert.equal(host.querySelectorAll('li').length, 4);
    assert.equal(host.querySelectorAll('li[aria-hidden="true"]').length, 3);
    assert.equal(host.querySelector('[aria-live]')?.textContent, '3/3');
    assert.equal(disabled(host, next), true);
    await click(host, previous);
    assert.deepEqual(names(host), ['user5', 'user6', 'user7', 'user8']);
  });
});

it('новый раунд сразу открывается с первой страницы и позволяет подписать прошлый раунд', async () => {
  await environment(async (host, render) => {
    const WheelBets = component();
    await render(React.createElement(WheelBets, props(roster(9))));
    await click(host, next);
    await render(React.createElement(WheelBets, props(roster(5, 'new'), {
      roundId: 'round-2', title: 'Ставки прошлого раунда',
    })));
    assert.deepEqual(names(host), ['new1', 'new2', 'new3', 'new4']);
    assert.equal(host.querySelector('[aria-live]')?.textContent, '1/2');
    assert.equal(host.querySelector('section')?.getAttribute('aria-label'), 'Ставки прошлого раунда');
    assert.equal(host.querySelector('h3')?.textContent, 'Ставки прошлого раунда · 5');
    assert.equal(disabled(host, previous), true);
  });
});

it('при удалении участников страница ограничивается и не возвращается при пополнении списка', async () => {
  await environment(async (host, render) => {
    const WheelBets = component();
    await render(React.createElement(WheelBets, props(roster(9))));
    await click(host, next);
    await click(host, next);
    await render(React.createElement(WheelBets, props(roster(5))));
    assert.deepEqual(names(host), ['user5']);
    assert.equal(host.querySelector('[aria-live]')?.textContent, '2/2');
    await render(React.createElement(WheelBets, props(roster(9))));
    assert.deepEqual(names(host), ['user5', 'user6', 'user7', 'user8']);
    await render(React.createElement(WheelBets, props(roster(2))));
    assert.deepEqual(names(host), ['user1', 'user2']);
    assert.equal(host.querySelector('[aria-live]')?.textContent, '1/1');
  });
});

it('полное длинное имя доступно в title, крупная ставка читаема, пустой раунд не оставляет старых данных', async () => {
  await environment(async (host, render) => {
    const WheelBets = component();
    const name = 'Длинное отображаемое имя '.repeat(20);
    await render(React.createElement(WheelBets, props([bet('long', 1_000_000_000)], { nameOf: () => name })));
    assert.equal(cards(host)[0].querySelector('.wh-live-bets-name')?.getAttribute('title'), name);
    assert.ok((cards(host)[0].querySelector('strong')?.textContent?.trim().length ?? 0) < 12);
    assert.equal(cards(host)[0].querySelector('strong')?.getAttribute('title'), 'Сумма ставок: 1 000 000 000');
    await render(React.createElement(WheelBets, props([], { emptyText: 'Ставок нет' })));
    assert.deepEqual(names(host), []);
    assert.equal(host.querySelector('p')?.textContent, 'Ставок нет');
    await render(React.createElement(WheelBets, props([bet('stale')], { roundId: null })));
    assert.deepEqual(names(host), []);
    assert.equal(host.querySelector('p')?.textContent, 'Пока никто не поставил');
    assert.equal(host.querySelector('section')?.getAttribute('aria-label'), 'Ставки раунда');
    assert.equal(host.querySelectorAll('li[aria-hidden="true"]').length, 4);
    assert.equal(disabled(host, previous), true);
    assert.equal(disabled(host, next), true);
  });
});
