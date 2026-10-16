import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { ConvGroupService } from '@gusvoice/shared';
import * as convRules from './convSyncRules';
import * as plural from './plural';
import * as rules from './groupChatRules';

const raw = readFileSync(new URL('./groupChatRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Label = typeof rules.groupServiceLabel;
const me = { id: 'me', displayName: 'Имя1' }, peer = { id: 'peer', displayName: 'Имя2' };
const service = (type: ConvGroupService['type'], users = [me]): ConvGroupService => ({ kind: 'group', type, users });
const cases: Array<{ label: string; svc: ConvGroupService; content: string; meId?: string; expected: string }> = [
  { label: 'удаление меня говорится как «вас»', svc: service('remove'), content: 'Автор удалил(а) Имя1', meId: 'me', expected: 'Автор удалил(а) вас' },
  { label: 'удаление меня и другого сохраняет имя другого', svc: service('remove', [peer, me]), content: 'Автор удалил(а) Имя2, Имя1', meId: 'me', expected: 'Автор удалил(а) вас, Имя2' },
  { label: 'чужое удаление не превращается в удаление читателя', svc: service('remove', [peer]), content: 'Автор удалил(а) Имя2', meId: 'me', expected: 'Автор удалил(а) Имя2' },
  { label: 'несовпавший хвост старого сервера остаётся дословным', svc: service('remove'), content: 'Автор удалил(а) иной', meId: 'me', expected: 'Автор удалил(а) иной' },
  { label: 'без meId текст не персонализируется', svc: service('remove'), content: 'Автор удалил(а) Имя1', expected: 'Автор удалил(а) Имя1' },
  { label: 'добавление меня говорится как «добавил(а) вас»', svc: service('add'), content: 'Автор добавил(а) Имя1', meId: 'me', expected: 'Автор добавил(а) вас' },
  { label: 'выход не превращается в удаление или добавление читателя', svc: service('leave'), content: 'Вышел(ла) Имя1', meId: 'me', expected: 'Вышел(ла) Имя1' },
];
const check = (fn: Label, index: number) => {
  const c = cases[index];
  assert.equal(fn(c.svc, c.content, c.meId), c.expected, `G6-label-${index}: ${c.label}`);
};
for (let index = 0; index < cases.length; index++) it(`R214 G6: ${cases[index].label}`, () => check(rules.groupServiceLabel, index));

function load(source: string): Label {
  const module = { exports: {} };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './convSyncRules': convRules, './plural': plural };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `объявленный импорт полного groupChatRules: ${id}`); return deps[id]; } });
  return (module.exports as typeof rules).groupServiceLabel;
}

for (const [label, from, to, index, actual] of [
  ['чужого участника считают читателем', '  if (!users.some((u) => u.id === meId)) return content;\n', '', 2, 'Автор удалил(а) вас, Имя2'],
  ['старый несовпавший хвост всё равно заменяется', 'if (!names || !content.endsWith(names)) return content;', 'if (!names) return content;', 3, 'Автор удалил(а) вас'],
  ['персонализируют и выход', "!meId || (svc.type !== 'remove' && svc.type !== 'add')", '!meId', 6, 'Вышел(ла) вас'],
  ['имя читателя дублируется после вас', 'users.filter((u) => u.id !== meId)', 'users.filter(() => true)', 0, 'Автор удалил(а) вас, Имя1'],
] as const) it(`R214 G6 контрфакт: ${label}`, () => {
  // Полный оригинал проходит тем же loader: несовпадение realm или импортов не выдаётся за персонализацию.
  check(load(raw), index);
  assert.equal(raw.split(from).length - 1, 1, 'у контрфакта один якорь в полном модуле');
  assert.throws(() => check(load(raw.replace(from, to)), index), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(`G6-label-${index}:`) && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === cases[index].expected);
});
