import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as rowRules from './dmRowRules';
import * as rules from './dmArchiveRules';

const dm = (id: string, archived?: boolean, unread = 0, markedUnread = false): DmChannel => ({
  id, archived, unread, markedUnread, otherUser: { id: `u-${id}`, displayName: `Имя ${id}` },
} as DmChannel);
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./dmArchiveRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from)); const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, './dmRowRules'); return rowRules; } });
  return module.exports as typeof rules;
}

it('архив отделяется без перестановки и мутации, отсутствие признака оставляет старую беседу в основном списке', () => {
  // Ловит исчезновение бесед старого сервера и изменение исходного порядка при фильтрации.
  const list = [dm('a', true), dm('b'), dm('c', false), dm('d', true)]; const saved = structuredClone(list);
  assert.deepEqual(rules.archivedOnly(list), [list[0], list[3]]);
  assert.deepEqual(rules.withoutArchived(list), [list[1], list[2]]);
  assert.deepEqual(list, saved); assert.deepEqual(rules.archivedOnly([]), []);
  assert.equal(rules.inArchive({}), false);
  assert.equal(rules.archiveMenuLabel(true), 'Вернуть из архива');
  assert.equal(rules.archiveMenuLabel(false), 'В архив');
});

it('непрочитанный архив считает беседы, исключает открытую и учитывает ручную точку без сообщения', () => {
  // Ловит общий счётчик сообщений вместо чатов и красный значок у уже открытого архива.
  const list = [dm('a', true, 90), dm('b', true, 1), dm('c', true, 0, true), dm('d', true, 9), dm('e', false, 4)];
  assert.equal(rules.archiveUnreadChats(list, ['a', 'b', 'e'], null), 3);
  assert.equal(rules.archiveUnreadChats(list, ['a', 'b', 'e'], 'a'), 2);
  assert.equal(rules.archiveUnreadChats([], [], null), 0);
  assert.deepEqual(rules.unreadOutsideArchive(list, ['a', 'b', 'e', 'unknown']), ['e', 'unknown']);
  const ids = ['x']; const kept = rules.unreadOutsideArchive([dm('x')], ids);
  assert.deepEqual(kept, ids); assert.notEqual(kept, ids);
  assert.throws(() => assert.equal(mutant('n++;', 'n += d.unread ?? 0;').archiveUnreadChats(list, ['a','b','e'], null), 3), assert.AssertionError);
  assert.throws(() => assert.deepEqual(mutant('!hidden.has(id)', 'true').unreadOutsideArchive(list, ['a','e']), ['e']), assert.AssertionError);
});

it('превью держит ровно восемь имён, остаток склоняется, прочитанность не выводится из одного числа', () => {
  // Ловит потерю восьмого имени и неверное «и ещё» на границе вместимости.
  const check = (api: typeof rules) => {
    for (const size of [0, 7, 8, 9, 10, 13, 29]) {
      const list = Array.from({ length: size }, (_, i) => dm(String(i), true, i === 0 ? 5 : 0, i === 1));
      const p = api.archivePreview(list, []);
      assert.equal(p.names.length, Math.min(size, 8)); assert.equal(p.more, Math.max(0, size - 8));
      assert.deepEqual(p.names.map(n => n.id), list.slice(0, 8).map(d => d.id));
      if (size) assert.equal(p.names[0].unread, false);
      if (size > 1) assert.equal(p.names[1].unread, true);
      if (size <= 8) assert.equal(p.moreLabel, '');
    }
    for (const [n, label] of [[1, 'чат'], [2, 'чата'], [5, 'чатов'], [21, 'чат']] as const) {
      assert.equal(api.archivePreview(Array.from({ length: 8 + n }, (_, i) => dm(String(i), true)), []).moreLabel, `и ещё ${n} ${label}`);
    }
  };
  check(rules);
  for (const cap of [7, 9]) assert.throws(() => check(mutant('ARCHIVE_PREVIEW_NAMES = 8', `ARCHIVE_PREVIEW_NAMES = ${cap}`)), assert.AssertionError);
  const preview = rules.archivePreview([dm('archive-a', true), dm('archive-b', true)], [], (_id, fallback) => `Подпись ${fallback}`);
  assert.deepEqual(preview.names.map((n) => n.name), ['Подпись Имя archive-a', 'Подпись Имя archive-b']);
});
