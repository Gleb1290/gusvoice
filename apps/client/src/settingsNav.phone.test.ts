import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as nav from './settingsNav';

const source = readFileSync(new URL('./settingsNav.ts', import.meta.url), 'utf8');
function check(module = nav) {
  // Парная проверка не даёт «починить телефон» удалением групп у всех пользователей.
  for (const mobile of [true, false]) {
    const ids = module.visibleSections({ federation: false, desktop: false, mobile }).flatMap(s => s.groups.map(g => g.id));
    for (const id of ['set-g-stream', 'set-g-windows', 'set-g-hotkeys', 'set-g-sidebar', 'set-g-send'])
      assert.equal(ids.includes(id), !mobile, id);
    assert.equal(ids.includes('set-g-swipe'), mobile);
  }
}
it('R169 телефон скрывает пять компьютерных групп и сохраняет свайп, компьютер делает обратное', () => check());
for (const id of ['set-g-stream', 'set-g-windows']) it(`R169 потеря notMobile у ${id} обнаруживается телефонной навигацией`, () => {
  check(); const anchor = new RegExp(`(\\{ id: '${id}',[^\\n]*), notMobile: true( \\})`, 'g');
  assert.equal([...source.matchAll(anchor)].length, 1);
  const raw = source.replace(anchor, '$1$2'); const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports });
  assert.throws(() => check(module.exports as typeof nav), assert.AssertionError);
});
