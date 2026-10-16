import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as nav from './settingsNav';
const source = readFileSync(new URL('./settingsNav.ts', import.meta.url), 'utf8');
function check(m = nav) {
  const apps = m.sectionOf('apps');
  assert.equal(m.sectionSub(apps, true), 'Android и обновления', 'подпись телефона');
  assert.equal(m.sectionSub(apps, false), apps.sub, 'подпись ПК');
  for (const section of m.SECTIONS.filter(s => s.key !== 'apps')) for (const phone of [true, false])
    assert.equal(m.sectionSub(section, phone), section.sub, 'прочие разделы сохраняют подписи');
}
it('R174 приложения телефона обещают Android и обновления, ПК и другие разделы сохраняют подписи', () => {
  // Телефон не должен обещать настройки десктопа, но переименование всех разделов тоже ошибка.
  check();
});
it('R174 контрфакт телефонной подписи приложений на ПК отвергается', () => {
  // Мутируем настоящий модуль, а не повторяем его условие в тесте.
  check(); const anchor = "phoneUi && section.key === 'apps'"; assert.equal(source.split(anchor).length - 1, 1);
  const module = { exports: {} as typeof nav };
  runInNewContext(ts.transpileModule(source.replace(anchor, "section.key === 'apps'"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  assert.throws(() => check(module.exports), e => e instanceof assert.AssertionError && e.message.includes('подпись ПК'));
});
