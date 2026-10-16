import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./phoneLayout.ts', import.meta.url), 'utf8');
function check(raw = source) {
  // Узкий десктоп не должен терять клавиатурные настройки, а браузер телефона — получать их.
  for (const [mobile, tauri, width, expected] of [
    [true, true, 1000, true], [false, false, 760, true],
    [false, true, 760, false], [false, false, 761, false],
  ] as const) {
    const module = { exports: {} as { isPhoneUiNow(): boolean } };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, window: { matchMedia: (query: string) => {
        assert.equal(query, '(max-width: 760px)'); return { matches: width <= 760 };
      } }, require: (id: string) => {
        if (id === './hotkeys') return { isMobile: () => mobile, isTauri: () => tauri };
        if (id === 'react') return {};
        throw new Error(`Неописанная граница ${id}`);
      } });
    assert.equal(module.exports.isPhoneUiNow(), expected, `${mobile}/${tauri}/${width}`);
  }
}
it('R169 телефонное приложение и узкий браузер получают телефонный вид, узкий Tauri и широкий браузер — нет', () => check());
it('R169 удаление исключения Tauri обнаруживается на узком настольном окне', () => {
  check(); const anchor = '!isTauri() && phoneNow()';
  assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => check(source.replace(anchor, 'phoneNow()')), assert.AssertionError);
});
