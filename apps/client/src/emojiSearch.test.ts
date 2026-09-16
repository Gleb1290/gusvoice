import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  codeForEmojiIn,
  type Emoji,
  emojiByCode,
  mergeAliases,
  rankEmoji,
  stripVs,
  withSkinTone,
} from './emojiSearch.js';

/**
 * Поиск по таблице эмодзи.
 *
 * Главное, что здесь проверяется, — ПОРЯДОК выдачи. Человек, набравший «огонь», ждёт 🔥 первым;
 * если 🧯 (у которого «огонь» в тегах) окажется выше, поиск ощущается сломанным, хотя формально
 * находит. Такое расхождение глазами не ловится: список-то непустой.
 */
const E = (emoji: string, label: string, tags: string[], codes: string[], skins?: string[]): Emoji => ({
  emoji,
  label,
  group: 0,
  tags,
  codes,
  ...(skins ? { skins } : {}),
});

const SET: Emoji[] = [
  E('🔥', 'огонь', ['костер', 'пламя'], ['fire']),
  E('🧯', 'огнетушитель', ['огонь', 'пожар'], ['fire_extinguisher']),
  E('👍', 'большой палец вверх', ['класс', 'хорошо'], ['+1', 'thumbsup'], ['👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿']),
  E('🐈', 'кот', ['кошка', 'котенок'], ['cat']),
  E('🐕', 'собака', ['пес'], ['dog']),
];

describe('порядок выдачи', () => {
  it('точное совпадение названия идёт первым', () => {
    assert.equal(rankEmoji(SET, 'огонь')[0].emoji, '🔥');
  });

  it('совпадение по тегу не обгоняет совпадение по названию', () => {
    const r = rankEmoji(SET, 'огонь').map((e) => e.emoji);
    assert.ok(r.indexOf('🔥') < r.indexOf('🧯'), `порядок: ${r.join(' ')}`);
  });

  it('точный код находит эмодзи', () => {
    assert.equal(rankEmoji(SET, 'fire')[0].emoji, '🔥');
  });

  it('ищет по русскому тегу, а не только по названию', () => {
    assert.ok(rankEmoji(SET, 'кошка').some((e) => e.emoji === '🐈'));
  });

  it('регистр не важен', () => {
    assert.equal(rankEmoji(SET, 'ОГОНЬ')[0].emoji, '🔥');
  });

  it('пустой запрос отдаёт начало набора, а не пустоту', () => {
    assert.equal(rankEmoji(SET, '').length, SET.length);
  });

  it('несуществующее не находит ничего', () => {
    assert.deepEqual(rankEmoji(SET, 'такогонет'), []);
  });

  it('лимит соблюдается', () => {
    assert.equal(rankEmoji(SET, '', 2).length, 2);
  });

  it('точное совпадение в конце таблицы не теряется из-за лимита', () => {
    // Ранний выход по менее точному совпадению оставил бы наверху подсказку хуже нужной.
    const entries = [
      E('🧭', 'наведение', [], ['targeting']),
      E('🎯', 'цель', [], ['target']),
    ];
    assert.deepEqual(rankEmoji(entries, 'target', 1).map((e) => e.emoji), ['🎯']);
  });
});

describe('рукописные алиасы поверх таблицы', () => {
  const aliases = new Map([['🔥', ['огонь', 'пожар']]]);

  it('свой алиас становится первым кодом — он и попадёт в подсказку', () => {
    const merged = mergeAliases(SET, aliases);
    assert.equal(merged.find((e) => e.emoji === '🔥')?.codes[0], 'огонь');
  });

  it('английский код не теряется', () => {
    const merged = mergeAliases(SET, aliases);
    assert.ok(merged.find((e) => e.emoji === '🔥')?.codes.includes('fire'));
  });

  it('код не дублируется, если он уже был в таблице', () => {
    const merged = mergeAliases(SET, new Map([['🔥', ['fire']]]));
    const codes = merged.find((e) => e.emoji === '🔥')!.codes;
    assert.equal(codes.filter((c) => c === 'fire').length, 1);
  });

  it('эмодзи без алиасов не меняется', () => {
    const merged = mergeAliases(SET, aliases);
    assert.deepEqual(merged.find((e) => e.emoji === '🐈')?.codes, ['cat']);
  });

  it('пустая карта алиасов отдаёт тот же массив', () => {
    assert.equal(mergeAliases(SET, new Map()), SET);
  });
});

describe('обратный разбор', () => {
  it('код → эмодзи', () => {
    assert.equal(emojiByCode(SET, 'thumbsup'), '👍');
  });

  it('точный код находится без учёта регистра', () => {
    assert.equal(emojiByCode(SET, 'ThumbsUp'), '👍');
  });

  it('несуществующий код → null', () => {
    assert.equal(emojiByCode(SET, 'такогонет'), null);
  });

  it('эмодзи → первый код', () => {
    assert.equal(codeForEmojiIn(SET, '🔥'), 'fire');
  });

  it('неизвестное эмодзи не обещает несуществующий код', () => {
    assert.equal(codeForEmojiIn(SET, '🛸'), null);
  });

  it('VS16 не мешает найти код', () => {
    // Пикер пишет «✌️», таблица может хранить «✌» — это один и тот же символ.
    const s = [E('✌', 'мир', [], ['victory'])];
    assert.equal(codeForEmojiIn(s, '✌️'), 'victory');
    assert.equal(stripVs('✌️'), stripVs('✌'));
  });
});

describe('тон кожи', () => {
  const thumb = SET.find((e) => e.emoji === '👍')!;
  const fire = SET.find((e) => e.emoji === '🔥')!;

  it('применяется к тем, кто его поддерживает', () => {
    assert.equal(withSkinTone(thumb, 1), '👍🏻');
    assert.equal(withSkinTone(thumb, 5), '👍🏿');
  });

  it('нулевой тон — базовый символ', () => {
    assert.equal(withSkinTone(thumb, 0), '👍');
  });

  it('эмодзи без вариантов возвращается как есть, а не кракозяброй', () => {
    assert.equal(withSkinTone(fire, 3), '🔥');
  });

  it('тон за пределами набора не ломает', () => {
    assert.equal(withSkinTone(thumb, 99), '👍');
    assert.equal(withSkinTone(thumb, -1), '👍');
  });
});
