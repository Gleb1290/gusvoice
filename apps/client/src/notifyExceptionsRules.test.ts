import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { groupOfMuteTarget } from '@gusvoice/shared';
import * as dmListRules from './dmListRules';
import * as rules from './notifyExceptionsRules';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const dm = (id: string, mute: object | null, group = false) => ({ id, muted: mute, otherUser: { id: group ? `group:${id}` : `u:${id}`, displayName: id, avatarUrl: null }, ...(group ? { group: { id } } : {}) });

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./notifyExceptionsRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      if (id === '@gusvoice/shared') return { groupOfMuteTarget };
      if (id === './dmListRules') return dmListRules;
      throw new Error(`неожиданный импорт ${id}`);
    } });
  return module.exports as typeof rules;
}

it('исключения включают вечную заглушку и soundOnly, исключают истёкшую и помечают group:', () => {
  const rows = [dm('full', { until: null }), dm('sound', { until: null, soundOnly: true }),
    dm('expired', { until: '2026-10-08T11:59:59.000Z' }), dm('group', { until: null }, true)];
  const list = rules.notifyExceptions(rows as never, [], {}, now);
  assert.deepEqual(list.map(x => x.convId), ['full', 'sound', 'group']);
  assert.equal(list[0]?.soundOnly, false); assert.equal(list[1]?.soundOnly, true); assert.equal(list[2]?.group, true);
  const signed = rules.notifyExceptions([dm('peer-a', { until: null })] as never, [], {}, now, (_id, fallback) => `Подпись ${fallback}`);
  assert.equal(signed[0]?.name, 'Подпись peer-a');
  assert.equal(rules.notifyExceptionLabel({ soundOnly: true, left: '3 ч' }), 'Звук выключен · ещё 3 ч');
  assert.equal(rules.notifyExceptionLabel({ soundOnly: false, left: '' }), 'Уведомления выключены · навсегда');
  assert.equal(rules.notifyExceptionsTitle(0), 'Исключения'); assert.equal(rules.notifyExceptionsTitle(3), 'Исключения · 3');
  const broken = mutant('if (!full && !sound) continue;', 'if (!full) continue;');
  assert.throws(() => assert.equal(broken.notifyExceptions(rows as never, [], {}, now).length, 3), assert.AssertionError,
    'мутант выбрасывает беседы, где выключен только звук');
});

it('включённая беседа появляется в исключениях, беззвучность сохраняется, а полная заглушка главнее', () => {
  // События always и mute могут прийти не одновременно: временное пересечение не должно обещать включённые уведомления.
  const rows = [dm('on', null), dm('quiet', { until: null, soundOnly: true }),
    dm('blocked', { until: null }), dm('expired', { until: '2026-10-08T11:59:59.000Z' }), dm('team', null, true)];
  const always = rows.map((row) => row.otherUser.id);
  const list = rules.notifyExceptions(rows as never, [], {}, now, (_id, name) => `Подпись ${name}`, always);
  assert.deepEqual(list.map((e) => e.convId), ['on', 'quiet', 'blocked', 'expired', 'team']);
  assert.deepEqual(list.map((e) => e.enabled === true), [true, true, false, true, true]);
  assert.equal(Object.hasOwn(list[2]!, 'enabled'), false, 'полная заглушка не выдаётся за включённую беседу');
  assert.equal(list[4]!.group, true); assert.equal(list[0]!.name, 'Подпись on');
  assert.equal(rules.notifyExceptionLabel(list[0]!), 'Уведомления включены');
  assert.equal(rules.notifyExceptionLabel(list[1]!), 'Уведомления включены · без звука');
  assert.equal(rules.notifyExceptionLabel(list[2]!), 'Уведомления выключены · навсегда');
  assert.equal(rules.notifyExceptionLabel(list[3]!), 'Уведомления включены');
  assert.deepEqual(rules.notifyExceptions(rows as never, [], {}, now).map((e) => e.convId), ['quiet', 'blocked'],
    'без always прежняя форма списка не меняется');
  const broken = mutant('if (!full && always.includes(d.otherUser.id))', 'if (always.includes(d.otherUser.id))');
  assert.throws(() => assert.equal(broken.notifyExceptions(rows as never, [], {}, now, undefined, always)
    .find((e) => e.convId === 'blocked')?.enabled, undefined, 'полная заглушка главнее включения'), assert.AssertionError);
});

it('действие включения учитывает push4 и общий выключатель своего вида беседы', () => {
  // Группе нельзя показывать действие по выключателю личных чатов и наоборот.
  const check = (api: typeof rules) => {
    for (const group of [false, true]) for (const push4 of [false, true]) {
      const target = group ? 'group:team' : 'peer';
      for (const off of [false, true, undefined]) for (const enabled of [false, true]) {
        const options = { push4, notifyDm: group ? true : off, notifyGroups: group ? off : true, always: enabled ? [target] : [] };
        assert.equal(api.notifyAlwaysAction(target, options), push4 && off === false ? enabled ? 'disable' : 'enable' : null,
          'пункт управляет только выключенным видом и только при push4');
      }
    }
    assert.equal(api.notifyAlwaysAction('group:team', { push4: true, notifyGroups: true, notifyDm: false, always: [] }), null);
    assert.equal(api.notifyAlwaysAction('peer', { push4: true, notifyDm: true, notifyGroups: false, always: [] }), null);
  };
  check(rules);
  const broken = mutant('const off = groupOfMuteTarget(target) !== null ? o.notifyGroups === false : o.notifyDm === false;',
    'const off = o.notifyDm === false;');
  assert.throws(() => check(broken), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('пункт управляет только'));
});
