import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { broadcastSqlPattern, canMentionEveryone, canMentionRole, hasBroadcastMention, mentionedRoleIds, mentionSqlPattern, mentionsMe, mentionsMyRole, roleMentionPatternSrc } from './mentions.js';
import * as permissions from './permissions.js';

const { Permission } = permissions;
const roles = [{ id: 'short', name: 'Ночная' }, { id: 'long', name: 'Ночная смена' }, { id: 'mods', name: 'Модераторы' }];

it('R266 кириллица и регистр роли принимаются по полному названию', () => {
  assert.deepEqual(mentionedRoleIds('Привет, @мОдЕрАтОрЫ!', roles), ['mods']);
});

it('R266 длинная роль поглощает короткую даже когда короткая первой во входном списке', () => {
  assert.deepEqual(mentionedRoleIds('@Ночная смена', roles), ['long']);
  assert.deepEqual(roles.map(r => r.id), ['short', 'long', 'mods'], 'входной список не переставлен');
});

it('R266 отдельная короткая роль не теряется рядом с длинной', () => {
  assert.deepEqual(mentionedRoleIds('@Ночная смена и @Ночная', roles), ['long', 'short']);
});

it('R266 повтор одного обращения и повтор роли в списке не дублируют id', () => {
  const mods = roles[2];
  assert.deepEqual(mentionedRoleIds('@Модераторы @МОДЕРАТОРЫ', [mods, mods]), ['mods']);
});

it('R266 буква, цифра и подчёркивание справа не дают позвать роль по префиксу', () => {
  for (const suffix of ['ы', 'A', '9', '_']) {
    assert.deepEqual(mentionedRoleIds(`@Ночная${suffix}`, roles), [], suffix);
  }
  for (const suffix of ['', '!', '.', ' ', ')']) {
    assert.deepEqual(mentionedRoleIds(`@Ночная${suffix}`, roles), ['short'], suffix);
  }
});

it('R266 почта не пингует роль, но настоящее обращение после пробела принимается', () => {
  for (const prefix of ['x', 'юзер', 'foo+', "o'brien", '_', '@']) {
    assert.deepEqual(mentionedRoleIds(`${prefix}@Модераторы`, roles), [], prefix);
  }
  assert.deepEqual(mentionedRoleIds('x @Модераторы', roles), ['mods']);
});

it('R266 обращение внутри жирного текста, кавычек и скобок остаётся обращением', () => {
  for (const text of ['**@Модераторы**', '«@Модераторы»', '(@Модераторы)', '\n@Модераторы']) {
    assert.deepEqual(mentionedRoleIds(text, roles), ['mods'], text);
  }
});

it('R266 метасимволы названия ищутся буквально, а не исполняются как регулярка', () => {
  const special = [{ id: 'special', name: 'C++ (ops) [v2].?' }];
  assert.deepEqual(mentionedRoleIds('@C++ (ops) [v2].?!', special), ['special']);
  assert.deepEqual(mentionedRoleIds('@C (ops) v2X', special), []);
});

it('R266 пустые роли и пустой текст не создают обращение к голой собаке', () => {
  assert.deepEqual(mentionedRoleIds('@ @   ', [{ id: 'empty', name: '' }, { id: 'space', name: '   ' }]), []);
  assert.deepEqual(mentionedRoleIds('', roles), []);
  assert.deepEqual(mentionedRoleIds('@Модераторы', []), []);
  assert.deepEqual(mentionedRoleIds('@Модераторы', [{ id: 'trimmed', name: ' Модераторы ' }]), ['trimmed']);
});

it('R266 флаг роли разрешает упоминание даже без прав автора', () => {
  assert.equal(canMentionRole({ mentionable: true }, 0n), true);
  assert.equal(canMentionRole({ mentionable: false }, 0n), false);
});

it('R279 право массовых упоминаний разрешает закрытую роль без её флага', () => {
  assert.equal(canMentionRole({ mentionable: false }, Permission.MENTION_EVERYONE), true);
  assert.equal(canMentionRole({ mentionable: true }, Permission.MENTION_EVERYONE), true);
});

it('R266 администратор разрешает закрытую роль через общую семантику прав', () => {
  assert.equal(canMentionRole({ mentionable: false }, Permission.ADMINISTRATOR), true);
});

it('R279 остальные права, включая управление ролями, не заменяют право массовых упоминаний', () => {
  const others = Object.values(Permission).reduce((bits, p) => bits | p, 0n)
    & ~Permission.MENTION_EVERYONE & ~Permission.ADMINISTRATOR;
  assert.equal(canMentionRole({ mentionable: false }, others), false);
  assert.equal(canMentionRole({ mentionable: true }, others), true);
});

it('R266 мои роли пересекаются с сохранёнными id, а не с текстом или порядком', () => {
  assert.equal(mentionsMyRole(['other', 'mine'], ['mine', 'extra']), true);
  assert.equal(mentionsMyRole(['other', 'mine'], ['outsider']), false);
  assert.equal(mentionsMyRole(['mine', 'mine'], ['mine']), true);
  assert.equal(mentionsMyRole(['Mine'], ['mine']), false, 'id регистрозависимы');
});

it('R266 отсутствие ролей у старого сообщения или участника не считается упоминанием', () => {
  for (const empty of [undefined, null, []]) {
    assert.equal(mentionsMyRole(empty, ['mine']), false);
    assert.equal(mentionsMyRole(['mine'], empty), false);
  }
});

it('R266 шаблон подсветки отсутствует без непустых названий', () => {
  assert.equal(roleMentionPatternSrc([]), null);
  assert.equal(roleMentionPatternSrc(['', ' ', '\t']), null);
});

it('R266 шаблон роли сохраняет длиннейшее название, стражи и отсутствие захватывающих групп', () => {
  const src = roleMentionPatternSrc(['Ночная', ' Ночная смена ', 'Ночная смена']);
  assert.ok(src);
  const found = [...'@Ночная смена! x@Ночная @НочнаяX **@Ночная**'.matchAll(new RegExp(src, 'giu'))];
  assert.deepEqual(found.map(m => m[0]), ['@Ночная смена', '@Ночная']);
  assert.ok(found.every(m => m.length === 1), 'номер групп markdown не должен сдвигаться');
});

it('R266 шаблон буквально экранирует метасимволы и принимает кириллицу с любым регистром', () => {
  const src = roleMentionPatternSrc(['C++ (ops) [v2].?', 'Модераторы']);
  assert.ok(src);
  const re = new RegExp(src, 'giu');
  assert.deepEqual([...('@C++ (ops) [v2].? @мОдЕрАтОрЫ').matchAll(re)].map(m => m[0]),
    ['@C++ (ops) [v2].?', '@мОдЕрАтОрЫ']);
  assert.equal(new RegExp(src, 'u').test('@C (ops) v2X'), false);
});

// Исполняется целый модуль, а не вырванный расчёт: единственная внешняя граница — настоящий permissions.
function loadMentions(raw: string): typeof import('./mentions.js') {
  const module = { exports: {} };
  const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    assert.equal(name, './permissions');
    return permissions;
  } }, { timeout: 2000 });
  return module.exports as typeof import('./mentions.js');
}

it('R266 контрфакт сортировки: настоящий модуль проходит, короткие названия первыми ломают свидетель', () => {
  const raw = readFileSync(new URL('./mentions.ts', import.meta.url), 'utf8');
  const from = '.sort((a, b) => b.name.length - a.name.length)';
  assert.equal(raw.split(from).length, 2, 'точка мутации ровно одна');
  const witness = (api: typeof import('./mentions.js')) =>
    assert.deepEqual(Array.from(api.mentionedRoleIds('@Ночная смена', roles)), ['long'], 'R266:длинная-роль-не-пингует-короткую');
  witness(loadMentions(raw));
  assert.throws(() => witness(loadMentions(raw.replace(from, '.sort((a, b) => a.name.length - b.name.length)'))),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R266:длинная-роль-не-пингует-короткую'));
});

it('R266 контрфакт права: замена ИЛИ на И требует оба разрешения и ломает оба независимых допуска', () => {
  const raw = readFileSync(new URL('./mentions.ts', import.meta.url), 'utf8');
  const from = 'return role.mentionable || canMentionEveryone(authorPerms);';
  assert.equal(raw.split(from).length, 2, 'точка мутации ровно одна');
  const witness = (api: typeof import('./mentions.js')) => {
    assert.equal(api.canMentionRole({ mentionable: true }, 0n), true, 'R266:флага-роли-достаточно-без-права');
    assert.equal(api.canMentionRole({ mentionable: false }, Permission.MENTION_EVERYONE), true, 'R266:права-достаточно-без-флага');
    assert.equal(api.canMentionRole({ mentionable: false }, 0n), false);
  };
  witness(loadMentions(raw));
  assert.throws(() => witness(loadMentions(raw.replace(from, from.replace('||', '&&')))),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('R266:флага-роли-достаточно-без-права')
      && error.actual === false && error.expected === true);
});

// Класс ошибки: новый бит пересекается со старым либо незаметно отбирается у обычных участников.
it('R279 массовое упоминание занимает отдельный бит 29 и включено в права everyone по умолчанию', () => {
  assert.equal(Permission.MENTION_EVERYONE, 1n << 29n);
  const others = Object.entries(Permission).filter(([key]) => key !== 'MENTION_EVERYONE');
  assert.ok(others.every(([, bit]) => (bit & Permission.MENTION_EVERYONE) === 0n));
  defaultBroadcast(permissions);
});
function defaultBroadcast(api: typeof permissions) {
  assert.ok((api.DEFAULT_EVERYONE_PERMISSIONS & (1n << 29n)) !== 0n, 'R279:everyone-сохраняет-право-по-умолчанию');
}

// Класс ошибки: управление ролями даёт лишнее право пинговать весь сервер, либо админ теряет исключение.
it('R279 массовое упоминание разрешено с отдельным правом и администратору, но не с управлением ролями', () => {
  for (const [perms, expected] of [[0n, false], [Permission.MANAGE_ROLES, false],
    [Permission.SEND_MESSAGES, false], [Permission.MENTION_EVERYONE, true],
    [Permission.ADMINISTRATOR, true], [permissions.ALL_PERMISSIONS, true]] as const) {
    assert.equal(canMentionEveryone(perms), expected, String(perms));
  }
});

// Класс ошибки: почта или продолжение имени ложно пингует весь сервер, а пунктуация глушит настоящий пинг.
it('R279 широковещательные обращения и SQL-шаблон принимают целое имя и не принимают почту или суффикс', () => {
  for (const word of ['everyone', 'here']) {
    for (const text of [`@${word}`, `Привет @${word}!`, `**@${word.toUpperCase()}**`, `\n@${word}.`]) {
      assert.equal(hasBroadcastMention(text), true, text);
      assert.equal(new RegExp(broadcastSqlPattern(), 'i').test(text), true, text);
    }
    for (const text of [`a@${word}`, `@${word}-x`, `@${word}.x`, `@${word}_`, `@${word}2`, `обычно`]) {
      assert.equal(hasBroadcastMention(text), false, text);
      assert.equal(new RegExp(broadcastSqlPattern(), 'i').test(text), false, text);
    }
    assert.equal(hasBroadcastMention(`@${word}@friend.example`), false, 'доменное обращение не broadcast');
  }
});

// Класс ошибки: доменное обращение к тёзке гостя не звенит сейчас, но превращается в массовый бейдж после перечитывания.
it('R280 доменный everyone и here не зовут постороннего читателя, а отдельное обращение с точкой или переносом зовёт', () => {
  for (const word of ['everyone', 'here']) {
    for (const [text, expected] of [
      [`@${word}@x.example`, false], [`\n@${word.toUpperCase()}@x.example!`, false],
      [`a@${word}`, false], [`@${word}-x`, false],
      [`@${word}`, true], [`@${word}.`, true], [`\n@${word.toUpperCase()}!`, true],
    ] as const) {
      assert.equal(hasBroadcastMention(text), expected, `разбор JS: ${text}`);
      assert.equal(mentionsMe(text, 'reader'), expected, `читатель не тёзка: ${text}`);
      assert.equal(new RegExp(broadcastSqlPattern(), 'i').test(text), expected, `SQL-шаблон в JS: ${text}`);
    }
  }
});

// Класс ошибки: удаление одной собаки из SQL-хвоста возвращает ложный бейдж, не меняя правильный JS-разбор.
it('R280 возврат доменного broadcast в SQL пойман адресным AssertionError после настоящего полного модуля', () => {
  const raw = readFileSync(new URL('./mentions.ts', import.meta.url), 'utf8');
  const anchor = "const tail = '(?![A-Za-z0-9_@]|[.-]+[A-Za-z0-9_])';";
  assert.equal(raw.split(anchor).length - 1, 1, 'меняется только хвост broadcastSqlPattern');
  const witness = (api: typeof import('./mentions.js')) => {
    for (const word of ['everyone', 'here']) {
      const domain = `@${word}@x.example`;
      assert.equal(api.hasBroadcastMention(domain), false);
      assert.equal(api.mentionsMe(domain, 'reader'), false);
      assert.ok(!new RegExp(api.broadcastSqlPattern(), 'i').test(domain), 'R280:домен-не-становится-SQL-broadcast');
      for (const text of [`@${word}`, `@${word}.`]) {
        assert.equal(new RegExp(api.broadcastSqlPattern(), 'i').test(text), true);
      }
    }
  };
  witness(loadMentions(raw));
  assert.throws(() => witness(loadMentions(raw.replace(anchor, anchor.replace('0-9_@', '0-9_')))),
    error => error instanceof assert.AssertionError && error.message === 'R280:домен-не-становится-SQL-broadcast'
      && error.actual === false && error.expected === true);
});

// Класс ошибки: запрет broadcast выключает ещё и личные упоминания местного человека или гостя.
it('R279 выключенный broadcast молчит на everyone и here, сохраняя личные обращения и прежнее умолчание', () => {
  for (const text of ['@everyone', '@here']) {
    assert.equal(mentionsMe(text, 'reader', null, false), false);
    assert.equal(mentionsMe(text, 'reader'), true);
    assert.equal(new RegExp(mentionSqlPattern('reader', null, false), 'i').test(text), false);
  }
  assert.equal(mentionsMe('@everyone @reader', 'reader', null, false), true);
  assert.equal(mentionsMe('@guest@friend.example', null, { username: 'guest', domain: 'friend.example' }, false), true);
  assert.equal(new RegExp(mentionSqlPattern('reader', null, false), 'i').test('@reader'), true);
  assert.equal(new RegExp(mentionSqlPattern(null, null, false)).test('@everyone'), false);
});

// Класс ошибки: возврат старого MANAGE_ROLES открывает закрытые роли не тем людям.
it('R279 мутант возврата MANAGE_ROLES пойман адресным AssertionError после оригинального правила', () => {
  const raw = readFileSync(new URL('./mentions.ts', import.meta.url), 'utf8');
  const anchor = 'return role.mentionable || canMentionEveryone(authorPerms);';
  assert.equal(raw.split(anchor).length - 1, 1);
  const witness = (api: typeof import('./mentions.js')) => {
    assert.ok(!api.canMentionRole({ mentionable: false }, Permission.MANAGE_ROLES), 'R279:управление-не-разрешает-пинг');
    assert.ok(api.canMentionRole({ mentionable: false }, Permission.MENTION_EVERYONE));
  };
  witness(loadMentions(raw));
  assert.throws(() => witness(loadMentions(raw.replace(anchor, 'return role.mentionable || has(authorPerms, Permission.MANAGE_ROLES);'))),
    error => error instanceof assert.AssertionError && error.message === 'R279:управление-не-разрешает-пинг');
});

// Класс ошибки: тест видит объявление бита, но не потерю права в штатном наборе everyone.
it('R279 мутант удаления бита из умолчания пойман на полном модуле permissions после original-first', () => {
  const raw = readFileSync(new URL('./permissions.ts', import.meta.url), 'utf8');
  const load = (source: string): typeof permissions => {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports,
      require(id: string) { assert.fail(`неожиданный импорт permissions: ${id}`); } });
    return module.exports as typeof permissions;
  };
  const anchor = 'Permission.MENTION_EVERYONE;';
  assert.equal(raw.split(anchor).length - 1, 1);
  defaultBroadcast(load(raw));
  assert.throws(() => defaultBroadcast(load(raw.replace(anchor, '0n;'))),
    error => error instanceof assert.AssertionError && error.message === 'R279:everyone-сохраняет-право-по-умолчанию');
});
