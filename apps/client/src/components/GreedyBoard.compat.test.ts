import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as rules from '../duelRules';
import * as practice from '../duelPractice';
import * as wheel from '../wheelRules';
import { React, environment, load } from './R171.phoneHarness';

// Полный исходный модуль из git show 03d4a58c:…/DuelScene.tsx, не копия GreedyBoard и не вырезанный eval.
// Snapshot нужен в CI с shallow checkout: git и старая история во время теста не требуются.
const legacy = readFileSync(new URL('./fixtures/DuelScene.03d4a58c.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const blob = createHash('sha1').update(`blob ${Buffer.byteLength(legacy)}\0`).update(legacy).digest('hex');
const noop = () => {};
type BoardProps = { duel: shared.DuelDto; mySide: shared.DuelSide | null; skew: number; now: number; busy: boolean;
  phone: boolean; coin: React.ReactNode; people: (id: string) => { name: string; avatar: null }; onMove: typeof noop };
function board() {
  assert.equal(blob, 'f5be05f61195db2f258d277baa52d883fe5cbe5a', 'R356/legacy/точный исходник указанного коммита');
  const deps = {
    '@gusvoice/shared': shared, '../api': { api: {} }, '../benchMock': { isMockEconomy: () => false },
    '../assets/guscoin.svg': { default: '/synthetic-coin.svg' }, '../assets/duel/judge.png': { default: '/synthetic-judge.png' },
    '../assets/duel/duelist.png': { default: '/synthetic-duelist.png' },
    '../assets/duel/duelist-sash.png': { default: '/synthetic-sash.png' },
    '../duelRules': rules, '../duelPractice': practice, '../wheelRules': wheel,
    '../economyClient': { ensureDuel: noop }, '../phoneLayout': { usePhoneLayout: () => false },
    '../sounds': { playSound: noop }, '../store': { useStore: { getState: () => ({ selfDeafened: true }) } },
    './Avatar': { Avatar: ({ name }: { name: string }) => React.createElement('span', null, name) },
    './Icon': { Icon: () => null }, './BottomSheet': { BottomSheet: () => null },
    './Duel': { CountRing: () => null },
  };
  return load<{ __legacyBoard: React.ComponentType<BoardProps> }>(new URL('./DuelScene.tsx', import.meta.url), legacy + '\nexport { GreedyBoard as __legacyBoard };', deps).__legacyBoard;
}
function full(): shared.DuelDto {
  return { id: 'legacy-greedy', serverId: 'server', channelId: 'channel', game: 'greedy', challengerId: 'a', targetId: 'b',
    amount: 10, feePercent: 10, state: 'playing', inviteUntil: null, commit: 'synthetic-commit', rollNo: 0,
    turnUntil: null, rolls: [], winnerId: null, payout: null, seed: null, reason: null, settledAt: null,
    moveUntil: '2026-10-29T12:00:20Z', greedy: { scores: { challenger: 11, target: 10 }, turn: 'target', turnPoints: 8,
      lastRoll: { by: 'target', die: 6 }, burned: 9, timeouts: { challenger: 2, target: 1 }, seq: 6,
      first: 'challenger', rolls: [6, 1, 2] } };
}
const props = (duel: shared.DuelDto, mySide: shared.DuelSide | null): BoardProps => ({
  duel, mySide, skew: 0, now: Date.parse('2026-10-29T12:00:00Z'), busy: false, phone: false,
  coin: React.createElement('i'), people: id => ({ name: id === 'a' ? 'Первый' : 'Второй', avatar: null }), onMove: noop,
});

for (const viewer of ['challenger', 'target', null] as const) {
  it(`R356 старый GreedyBoard принимает маску для ${viewer ?? 'зрителя'} без новых обязательных полей`, async () => {
    // Старый клиент должен показать типобезопасные нули/неизвестную кость, а не упасть на новом скрытом состоянии.
    await environment(async (host, render) => {
      const Board = board();
      const d = full(); d.greedy = shared.greedyHide(d.greedy!, viewer);
      const saved = JSON.stringify(d);
      await render(React.createElement(Board, props(d, viewer)));
      const scores = [...host.querySelectorAll('.gr-score')].map(el => el.textContent?.replace(/\s+/g, ''));
      assert.deepEqual(scores, [viewer === 'challenger' ? '11/20' : '0/20', viewer === 'target' ? '10+8/20' : '0/20'],
        'R356/legacy/маска сохраняет числовой контракт старой доски');
      assert.equal(host.querySelectorAll('.dc-die.unknown').length, viewer === 'target' ? 0 : 1, 'R356/legacy/null означает неизвестный кубик');
      for (const el of host.querySelectorAll<HTMLElement>('[style]')) assert.doesNotMatch(el.style.cssText, /NaN|undefined/);
      assert.equal(JSON.stringify(d), saved, 'R356/legacy/рендер не портит DTO');
    });
  });
}
it('R356 старый GreedyBoard принимает публичную единицу и пустую маскированную историю', async () => {
  // Нельзя добиваться скрытия удалением самих полей/массива: прежний код читает rolls.length и lastRoll?.die.
  await environment(async (host, render) => {
    const Board = board();
    for (const die of [null, 1] as const) {
      const d = full(); d.greedy!.lastRoll = die === null ? null : { by: 'target', die };
      d.greedy!.rolls = die === null ? [] : [1];
      d.greedy = shared.greedyHide(d.greedy!, null);
      await render(React.createElement(Board, { ...props(d, null), key: String(die) }));
      assert.equal(host.querySelectorAll('.gr-player').length, 2, 'R356/legacy/оба игрока остаются');
      assert.equal(host.querySelector('.gr-bank b')?.textContent, '0', 'R356/legacy/копилка остаётся числом');
      assert.equal(host.querySelectorAll('.dc-die.unknown').length, die === null ? 1 : 0, 'R356/legacy/единица или неизвестный кубик');
      if (die === 1) {
        assert.equal(host.querySelector<HTMLElement>('.dc-cube')?.style.transform, rules.DIE_FACE_ROT[1], 'R356/legacy/именно единица');
        assert.equal(host.querySelector('.gr-burn')?.firstChild?.textContent, 'Единица!', 'R356/legacy/сгорание без чужой суммы');
      }
    }
  });
});
