import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rules from './screenShareDialogRules';

for (const [current, tab, tabs, id] of [
  [{ sourceId: '7', isWindow: true }, 'window', ['window', 'screen'], '7'],
  [{ sourceId: '7', isWindow: false }, 'screen', ['window', 'screen'], '7'],
  [{ deviceId: 'cam' }, 'camera', ['camera'], 'cam'],
] as const) it(`R304 смена ${tab} открывает текущую карточку и не предлагает другой вид показа`, () => {
  assert.deepEqual(rules.shareDialogTabs('switch', current), tabs);
  assert.equal(rules.shareDialogInitialTab('switch', current), tab);
  assert.equal(rules.shareDialogInitialSelection('switch', current), id);
  assert.equal(rules.isCurrentCard('switch', tab, id, current), true);
  for (const other of ['window', 'screen', 'camera'] as const) if (other !== tab)
    assert.equal(rules.isCurrentCard('switch', other, id, current), false, 'id без вида недостаточно');
  assert.equal(rules.isCurrentCard('start', tab, id, current), false);
  assert.equal(rules.isCurrentCard('switch', tab, 'other', current), false);
});
it('R304 старт сохраняет все вкладки и пустой выбор, смена имеет собственный заголовок и пояснение качества', () => {
  assert.deepEqual(rules.shareDialogTabs('start'), ['window', 'screen', 'camera']);
  assert.equal(rules.shareDialogInitialTab('start'), 'window'); assert.equal(rules.shareDialogInitialSelection('start'), null);
  assert.equal(rules.shareDialogTitle('start'), 'Демонстрация экрана');
  assert.equal(rules.shareDialogTitle('switch'), 'Сменить источник показа');
  assert.equal(rules.SHARE_SWITCH_QUALITY_NOTE, 'Качество меняется только новым показом');
});
for (const mode of ['start', 'switch'] as const) it(`R304 кнопка ${mode}: пусто, занято и уже выбранное проверяются независимо`, () => {
  assert.equal(rules.shareDialogConfirmDisabled(mode, null, false, false), true);
  assert.equal(rules.shareDialogConfirmDisabled(mode, 'x', true, false), true);
  assert.equal(rules.shareDialogConfirmDisabled(mode, 'x', false, false), false);
  assert.equal(rules.shareDialogConfirmDisabled(mode, 'x', false, true), mode === 'switch');
  assert.equal(rules.shareDialogConfirmLabel(mode, true, true), mode === 'switch' ? 'Переключение…' : 'Запуск…');
  assert.equal(rules.shareDialogConfirmLabel(mode, false, true), mode === 'switch' ? 'Уже показывается' : 'Начать трансляцию');
  assert.equal(rules.shareDialogConfirmLabel(mode, false, false), mode === 'switch' ? 'Показывать это' : 'Начать трансляцию');
});
