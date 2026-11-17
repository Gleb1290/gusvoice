import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rules from '../duelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

// Полностью заменяет прежний кластер AST/CSS-пинов: проверяем смонтированный арт, а не текст его реализации.
function art() {
  return load<typeof import('./DuelArt')>(new URL('./DuelArt.tsx', import.meta.url), sourceOf('DuelArt'), {
    '../duelRules': rules,
    './Avatar': { Avatar: ({ size, name }: { size: number; name: string }) => React.createElement('span', { 'data-size': size }, name) },
    '../assets/duel/duelist.png': { default: '/goose.png' },
    '../assets/duel/duelist-sash.png': { default: '/sash.png' },
  });
}
const who = { name: 'Гусь', avatar: null };

it('оба дуэлянта загружают гуся, отдельный слой кушака появляется только у соперника', async () => {
  await environment(async (host, render) => {
    const { Duelist } = art();
    await render(React.createElement(React.Fragment, null, React.createElement(Duelist, { side: 'challenger', who, phone: false, mine: true, won: false, lost: false }), React.createElement(Duelist, { side: 'target', who, phone: false, mine: false, won: false, lost: false })));
    await React.act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    assert.equal(host.querySelectorAll('.dc-goose img[src="/goose.png"]').length, 2);
    assert.equal(host.querySelectorAll('.challenger .dc-sash').length, 0);
    assert.equal(host.querySelector('.target .dc-sash')?.getAttribute('src'), '/sash.png');
  });
});

it('фигура передаёт состояние победы и поражения и размер аватара без изменения изображения', async () => {
  await environment(async (host, render) => {
    const { Duelist } = art();
    await render(React.createElement(Duelist, { side: 'target', who, phone: true, mine: true, won: true, lost: false }));
    assert.ok(host.querySelector('.dc-figure.target.me.won'));
    assert.equal(host.querySelector('[data-size]')?.getAttribute('data-size'), '28');
    await render(React.createElement(Duelist, { side: 'target', who, phone: false, mine: false, won: false, lost: true }));
    assert.ok(host.querySelector('.dc-figure.target.lost'));
    assert.equal(host.querySelector('.dc-figure.won'), null);
    assert.equal(host.querySelector('[data-size]')?.getAttribute('data-size'), '36');
  });
});

it('скрытый кубик не рисует точек, раскрытый показывает нужную грань и состояние броска', async () => {
  await environment(async (host, render) => {
    const { Die } = art();
    await render(React.createElement(Die, { v: null, rolling: false }));
    assert.ok(host.querySelector('.dc-die.unknown'));
    assert.equal(host.querySelectorAll('.dc-face i').length, 0);
    await render(React.createElement(Die, { v: 4, rolling: true, stale: true }));
    assert.equal(host.querySelector('.dc-die.unknown'), null);
    assert.ok(host.querySelector('.dc-die.stale .dc-tumble.rolling'));
    assert.equal(host.querySelector<HTMLElement>('.dc-cube')?.style.transform, rules.DIE_FACE_ROT[4]);
    assert.equal(host.querySelectorAll('.dc-face.f4 i').length, 4);
  });
});
