import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './hashtagRules';

function mutated(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./hashtagRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: { getItem: () => '[]', setItem: () => undefined } });
  return module.exports as typeof rules;
}

it('вынимаются только полноценные теги на границе слова, кириллица и пунктуация сохраняются', () => {
  assert.deepEqual(rules.extractHashtags('#a #12 a#tag (#tag) #тег #tag,'), ['tag', 'тег', 'tag']);
  assert.deepEqual(rules.extractHashtags('начало #x_y и #два_слова #a1'), ['x_y', 'два_слова', 'a1']);
  assert.deepEqual(rules.extractHashtags('#' + 'я'.repeat(65)), []);
  const mutant = mutated('if (/^\\d+$/.test(m[2])) continue;', 'if (false) continue;');
  assert.throws(() => assert.deepEqual(mutant.extractHashtags('#12'), []), assert.AssertionError,
    'мутант превращает числовую ссылку на сообщение в подсказку хэштега');
});

it('повтор поднимает тег над равными, новый остаётся после равных, а список ограничен 64', () => {
  const seed = [{ tag: 'верх', count: 4 }, { tag: 'старый', count: 2 }, { tag: 'равный', count: 2 }];
  assert.deepEqual(rules.incrementHashtag(seed, 'равный').map(x => x.tag), ['верх', 'равный', 'старый']);
  assert.deepEqual(rules.incrementHashtag(seed, 'новый').map(x => x.tag), ['верх', 'старый', 'равный', 'новый']);
  assert.equal(rules.incrementHashtag(Array.from({ length: 64 }, (_, i) => ({ tag: `t${i}`, count: 10 - i })), 'new').length, 64);
  const scaled = rules.incrementHashtag([{ tag: 'big', count: 0x4000 }, { tag: 'small', count: 4 }], 'big');
  assert.ok(scaled[0]!.count <= 0x2001 && scaled[1]!.count === 2, 'переполненный счётчик делится пополам и не застывает лидером');
  const equalSeed = [{ tag: 'ahead', count: 3 }, { tag: 'repeat', count: 2 }];
  const mutant = mutated('list[i - 1].count > list[i].count', 'list[i - 1].count >= list[i].count');
  assert.throws(() => assert.deepEqual(mutant.incrementHashtag(equalSeed, 'repeat').map(x => x.tag), ['repeat', 'ahead']), assert.AssertionError,
    'мутант не всплывает над равным счётчиком после повторного использования');
});

it('подсказка — неполный префикс без учёта регистра, целиком совпавший тег не повторяется', () => {
  const items = [{ tag: 'Тегирование', count: 3 }, { tag: 'тег', count: 2 }, { tag: 'Тест', count: 1 }];
  assert.deepEqual(rules.matchHashtags(items, ''), ['Тегирование', 'тег', 'Тест']);
  assert.deepEqual(rules.matchHashtags(items, 'ТЕГ'), ['Тегирование']);
  assert.deepEqual(rules.matchHashtags(items, 'не'), []);
  assert.deepEqual(rules.matchHashtags(items, '', 2), ['Тегирование', 'тег']);
  const mutant = mutated("t.toLowerCase().startsWith(q)", 't.startsWith(q)');
  assert.throws(() => assert.deepEqual(mutant.matchHashtags(items, 'ТЕГ'), ['Тегирование']), assert.AssertionError,
    'мутант теряет подсказку из-за регистра набранного префикса');
});

it('отправка копит теги, повторный тег увеличивает счётчик, удаление не мутирует исходник', () => {
  const input = [{ tag: 'два', count: 1 }];
  const next = rules.recordHashtags(input, 'вот #два и #новый #123');
  assert.equal(next.find(x => x.tag === 'два')?.count, 2);
  assert.ok(next.some(x => x.tag === 'новый'));
  assert.deepEqual(rules.forgetHashtag(next, 'два').map(x => x.tag).includes('два'), false);
  assert.equal(input[0]!.count, 1);
});

it('недавние хэштеги изолируются между аккаунтами, а без входа остаётся старый ключ', () => {
  // Переключение аккаунта не должно подсказывать хэштеги предыдущего человека на общем устройстве.
  const check = (api: typeof rules) => {
    assert.equal(api.recentHashtagsKey(), 'gv.recentHashtags');
    assert.equal(api.recentHashtagsKey(null), 'gv.recentHashtags');
    assert.equal(api.recentHashtagsKey('alice'), 'gv.recentHashtags.alice');
    assert.equal(api.recentHashtagsKey('bob'), 'gv.recentHashtags.bob');
    assert.notEqual(api.recentHashtagsKey('alice'), api.recentHashtagsKey('bob'));
  };
  check(rules);
  check(mutated('return userId ? `${KEY}.${userId}` : KEY;', 'return userId ? `${KEY}.${userId}` : KEY;'));
  assert.throws(() => check(mutated('return userId ? `${KEY}.${userId}` : KEY;', 'return KEY;')), assert.AssertionError,
    'мутант хранит чужие недавние теги в одном ключе');
});
