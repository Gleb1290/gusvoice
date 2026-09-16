import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMOJI_SHORTCODES } from './emojiAliases.js';
import { primaryCode } from './emojiShortcodes.js';

/**
 * Рукописные алиасы.
 *
 * Прежний тест сверял паритет «сетка пикера ↔ словарь кодов» вручную (#65). После перехода на
 * юникодную таблицу (#68) паритет стал АВТОМАТИЧЕСКИМ: каждое эмодзи в таблице несёт шорткод,
 * расходиться нечему. Осталось проверять то, что по-прежнему пишется руками, — сами алиасы.
 *
 * ⚠️ Файл НЕ импортирует пикер и индекс: они тянут React и динамический импорт таблицы, из-за
 * чего тест падал бы на «window is not defined» ещё до первой проверки.
 */
const strip = (e: string) => e.replace(/️/g, '');

describe('целостность рукописных алиасов', () => {
  it('коды не дублируются между разными эмодзи', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const e of EMOJI_SHORTCODES) {
      for (const c of e.codes) {
        const prev = seen.get(c);
        // Дубль означает лотерею при автозамене `:код:` — выигрывает первый по списку.
        if (prev && prev !== e.emoji) dups.push(`${c}: ${prev} vs ${e.emoji}`);
        else seen.set(c, e.emoji);
      }
    }
    assert.deepEqual(dups, [], dups.join('; '));
  });

  it('коды не конфликтуют между разными эмодзи без учёта регистра', () => {
    // Поиск приводит ввод к lower-case, поэтому `Fire` и `fire` были бы одним неоднозначным кодом.
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const e of EMOJI_SHORTCODES) {
      for (const code of e.codes) {
        const key = code.toLowerCase();
        const prev = seen.get(key);
        if (prev && prev !== e.emoji) dups.push(`${code}: ${prev} vs ${e.emoji}`);
        else seen.set(key, e.emoji);
      }
    }
    assert.deepEqual(dups, [], dups.join('; '));
  });

  it('одно эмодзи не встречается дважды', () => {
    const all = EMOJI_SHORTCODES.map((e) => strip(e.emoji));
    const dups = [...new Set(all.filter((e, i) => all.indexOf(e) !== i))];
    assert.deepEqual(dups, [], `повторы: ${dups.join(' ')}`);
  });

  it('у каждой записи есть хотя бы один код', () => {
    const empty = EMOJI_SHORTCODES.filter((e) => e.codes.length === 0).map((e) => e.emoji);
    assert.deepEqual(empty, []);
  });

  it('в кодах нет пробелов и двоеточий', () => {
    // `:код:` разбирается по двоеточиям и обрывается на пробеле — такой код не набрался бы никогда.
    const bad = EMOJI_SHORTCODES.flatMap((e) => e.codes).filter((c) => /[\s:]/.test(c));
    assert.deepEqual(bad, []);
  });

  it('русские алиасы на месте — ради них весь слой и существует', () => {
    const hasCyrillic = EMOJI_SHORTCODES.filter((e) => e.codes.some((c) => /[а-яё]/i.test(c)));
    assert.ok(hasCyrillic.length > 50, `русских алиасов всего ${hasCyrillic.length}`);
  });
});

/**
 * 🔴 Формы должны СОВПАДАТЬ ПОБАЙТОВО с таблицей.
 *
 * Реакции ключуются строкой эмодзи. Если пикер отдаёт `👍️` (с VS16), а в базе уже лежат реакции
 * с `👍` (без него), одно и то же эмодзи расколется на две одинаковые с виду плашки. Именно это
 * и происходило на первой сборке: из 51 ходового эмодзи форма разошлась у 13, включая 👍 и ✅.
 *
 * Тест сравнивает БЕЗ нормализации — нормализация скрыла бы ровно ту разницу, которую он ловит.
 */
describe('формы эмодзи совпадают с таблицей', () => {
  it('каждый рукописный алиас записан в той же форме, что и в таблице', async () => {
    const { EMOJI_DATA } = await import('./emojiData.js');
    const table = new Map(EMOJI_DATA.map((e) => [strip(e[0]), e[0]]));
    const mismatched: string[] = [];
    for (const a of EMOJI_SHORTCODES) {
      const inTable = table.get(strip(a.emoji));
      if (inTable && inTable !== a.emoji) {
        mismatched.push(`${a.codes[0]}: набор ${JSON.stringify(a.emoji)} ≠ таблица ${JSON.stringify(inTable)}`);
      }
    }
    assert.deepEqual(mismatched, [], mismatched.join('; '));
  });

  it('VS16 остался там, где он обязателен', async () => {
    // ❤ ✌ ⚠ по умолчанию текстовые: без селектора станут чёрно-белыми глифами.
    const { EMOJI_DATA } = await import('./emojiData.js');
    const table = new Map(EMOJI_DATA.map((e) => [strip(e[0]), e[0]]));
    for (const e of ['❤', '✌', '⚠']) {
      assert.notEqual(table.get(e), e, `у ${e} пропал обязательный VS16`);
    }
  });

  it('VS16 убран там, где он избыточен', async () => {
    const { EMOJI_DATA } = await import('./emojiData.js');
    const table = new Map(EMOJI_DATA.map((e) => [strip(e[0]), e[0]]));
    for (const e of ['👍', '✅', '⭐', '🔥']) {
      assert.equal(table.get(e), e, `у ${e} остался лишний VS16 — реакции расколются`);
    }
  });
});

describe('primaryCode', () => {
  const entry = { emoji: '🔥', codes: ['огонь', 'fire', 'пожар'] };

  it('отдаёт код, начинающийся с запроса', () => {
    assert.equal(primaryCode(entry, 'fi'), 'fire');
  });

  it('при отсутствии совпадения с начала берёт вхождение', () => {
    assert.equal(primaryCode(entry, 'жар'), 'пожар');
  });

  it('без совпадений отдаёт первый код', () => {
    assert.equal(primaryCode(entry, 'zzz'), 'огонь');
  });

  it('регистр не важен', () => {
    assert.equal(primaryCode({ emoji: '🔥', codes: ['Fire'] }, 'fi'), 'Fire');
  });
});
