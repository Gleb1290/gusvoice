import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

const raw = readFileSync(new URL('./fedErrorText.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const generic = 'Этот человек принимает сообщения только от своих контактов.';
const policy = 'Этот человек принимает сообщения с других инстансов только от людей с общих серверов.';
function load(source = raw): typeof import('./fedErrorText') {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared', 'единственный реальный импорт целого модуля'); return shared; } });
  return module.exports as typeof import('./fedErrorText');
}
function local(source = raw) {
  assert.equal(load(source).messageErrorText('message_privacy'), generic, 'R212-local-text: отказ отправки переведён словами, без кода протокола');
}
function remote(source = raw) {
  assert.equal(load(source).fedDmOpenText(shared.FED_ERRORS.dmRefused, 'privacy', 'Инстанс1'), generic,
    'R212-fed-text: отказ privacy говорит о контактах человека, не о политике федерации');
}
it('R212 отказ отправки message_privacy получает понятное объяснение контактов', () => local());
for (const code of ['permission_denied', 'message_privacy_extra', 'MESSAGE_PRIVACY', '', 'federation.message_privacy'])
  it(`R212 другой код ${code || 'пустой'} не получает выдуманный отказ приватности`, () => assert.equal(load().messageErrorText(code), null));
it('R212 имя собеседника принимается в тексте, отсутствие и пустое имя дают общую фразу', () => {
  const m = load();
  assert.equal(m.messagePrivacyText('Имя1'), 'Имя1 принимает сообщения только от своих контактов.');
  for (const name of [undefined, null, '']) assert.equal(m.messagePrivacyText(name), generic);
});
it('R212 conv.open privacy получает тот же отказ, независимо от имени инстанса', () => {
  remote(); for (const name of [undefined, null, '']) assert.equal(load().fedDmOpenText(shared.FED_ERRORS.dmRefused, 'privacy', name), generic);
});
it('R212 другие причины conv.open остаются отличимыми от настройки контактов', () => {
  const m = load();
  for (const reason of ['policy', 'future', undefined, null]) assert.equal(m.fedDmOpenText(shared.FED_ERRORS.dmRefused, reason), policy);
  assert.equal(m.fedDmOpenText(shared.FED_ERRORS.dmRefused, 'no_user', 'Инстанс1'), 'Этого человека нет на «Инстанс1».');
});
it('R212 privacy не переводит произвольный незнакомый код conv.open', () => {
  assert.equal(load().fedDmOpenText('unknown_error', 'privacy', 'Инстанс1'), null);
});
for (const [label, from, to, scenario, prefix, actual] of [
  ['код отправки сравнивается с чужим кодом', "raw === 'message_privacy'", "raw === 'other_error'", local, 'R212-local-text:', null],
  ['privacy теряется среди причин федерации', "if (reason === 'privacy') return messagePrivacyText();", "if (reason === 'other') return messagePrivacyText();", remote, 'R212-fed-text:', policy],
] as const) it(`R212 контрфакт текста: ${label}`, () => {
  scenario(raw);
  assert.equal(raw.split(from).length - 1, 1, 'один якорь в целом fedErrorText');
  assert.throws(() => scenario(raw.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === generic);
});
