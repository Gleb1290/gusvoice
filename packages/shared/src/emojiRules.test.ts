import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkEmojiName,
  checkEmojiUpload,
  customReactionId,
  customReactionKey,
  EMOJI_MAX_BYTES,
  EMOJI_PER_SERVER,
  extractEmojiNames,
  suggestEmojiName,
} from './emojiRules.js';

/**
 * Правила кастомных эмодзи.
 *
 * На каждое «принимается» здесь есть парное «отклоняется»: молчаливо принятый мусор выглядит
 * ровно как штатная работа, и замечают его позже всех — когда эмодзи уже разъехались по чатам.
 */
describe('имя эмодзи', () => {
  it('простое имя проходит', () => {
    assert.deepEqual(checkEmojiName('pepe'), { ok: true, name: 'pepe' });
  });

  it('приводится к нижнему регистру', () => {
    assert.deepEqual(checkEmojiName('PePe'), { ok: true, name: 'pepe' });
  });

  it('двоеточия по краям срезаются — их копируют вместе с именем', () => {
    assert.deepEqual(checkEmojiName(':pepe:'), { ok: true, name: 'pepe' });
  });

  it('пробелы по краям срезаются', () => {
    assert.deepEqual(checkEmojiName('  pepe  '), { ok: true, name: 'pepe' });
  });

  it('цифры и подчёркивание разрешены', () => {
    assert.equal(checkEmojiName('cat_2_go').ok, true);
  });

  it('слишком короткое отклоняется', () => {
    assert.equal(checkEmojiName('a').ok, false);
  });

  it('имена ровно на обеих границах длины принимаются', () => {
    assert.equal(checkEmojiName('ab').ok, true);
    assert.equal(checkEmojiName('a'.repeat(32)).ok, true);
  });

  it('слишком длинное отклоняется', () => {
    assert.equal(checkEmojiName('a'.repeat(33)).ok, false);
  });

  it('пробел внутри отклоняется — иначе `:имя:` не разобрать', () => {
    assert.equal(checkEmojiName('two words').ok, false);
  });

  it('кириллица отклоняется (см. комментарий в правилах)', () => {
    assert.equal(checkEmojiName('огонь').ok, false);
  });

  it('двоеточие внутри отклоняется', () => {
    assert.equal(checkEmojiName('pe:pe').ok, false);
  });

  it('пустое отклоняется', () => {
    assert.equal(checkEmojiName('').ok, false);
    assert.equal(checkEmojiName('   ').ok, false);
  });
});

describe('загрузка файла', () => {
  it('PNG нормального размера принимается', () => {
    assert.deepEqual(checkEmojiUpload('image/png', 50_000, 0), { ok: true });
  });

  it('GIF и WebP тоже', () => {
    assert.equal(checkEmojiUpload('image/gif', 1000, 0).ok, true);
    assert.equal(checkEmojiUpload('image/webp', 1000, 0).ok, true);
  });

  it('SVG отклоняется — это исполняемый документ, а не картинка', () => {
    assert.equal(checkEmojiUpload('image/svg+xml', 1000, 0).ok, false);
  });

  it('слишком большой файл отклоняется', () => {
    assert.equal(checkEmojiUpload('image/png', EMOJI_MAX_BYTES + 1, 0).ok, false);
  });

  it('ровно предельный размер ещё проходит', () => {
    assert.equal(checkEmojiUpload('image/png', EMOJI_MAX_BYTES, 0).ok, true);
  });

  it('пустой файл отклоняется', () => {
    assert.equal(checkEmojiUpload('image/png', 0, 0).ok, false);
  });

  it('переполненный сервер отклоняется', () => {
    assert.equal(checkEmojiUpload('image/png', 1000, EMOJI_PER_SERVER).ok, false);
  });

  it('на один меньше лимита ещё проходит', () => {
    assert.equal(checkEmojiUpload('image/png', 1000, EMOJI_PER_SERVER - 1).ok, true);
  });
});

describe('ключ реакции', () => {
  it('кастомный ключ разбирается обратно в id', () => {
    assert.equal(customReactionId(customReactionKey('abc123')), 'abc123');
  });

  it('юникодное эмодзи кастомным не считается', () => {
    assert.equal(customReactionId('🔥'), null);
    assert.equal(customReactionId('👍'), null);
  });

  it('текст, похожий на имя, кастомным не считается', () => {
    // Ровно ради этого ключ `custom:<id>`, а не `:имя:` — последнее пересекается с обычным текстом.
    assert.equal(customReactionId(':pepe:'), null);
  });
});

describe('поиск имён в тексте', () => {
  it('находит одно', () => {
    assert.deepEqual(extractEmojiNames('привет :pepe: как дела'), ['pepe']);
  });

  it('находит несколько и не дублирует', () => {
    assert.deepEqual(extractEmojiNames(':a1: :b2: :a1:'), ['a1', 'b2']);
  });

  it('время не принимает за эмодзи', () => {
    assert.deepEqual(extractEmojiNames('в 10:30:00 встречаемся'), []);
  });

  it('текст без имён даёт пустой список', () => {
    assert.deepEqual(extractEmojiNames('обычное сообщение'), []);
  });

  it('слишком короткое имя не ловится', () => {
    assert.deepEqual(extractEmojiNames(':a:'), []);
  });

  it('поиск принимает имя ровно в 32 символа и отбрасывает 33 символа', () => {
    assert.deepEqual(extractEmojiNames(`:${'a'.repeat(32)}:`), ['a'.repeat(32)]);
    assert.deepEqual(extractEmojiNames(`:${'a'.repeat(33)}:`), []);
  });
});

describe('имя по имени файла', () => {
  it('срезает расширение и приводит к нижнему регистру', () => {
    assert.equal(suggestEmojiName('Pepe.PNG'), 'pepe');
  });

  it('пробелы и скобки становятся подчёркиваниями, края обрезаются', () => {
    assert.equal(suggestEmojiName('Party Parrot (1).gif'), 'party_parrot_1');
  });

  it('русское имя файла даёт пустую строку — человек впишет своё', () => {
    // Кириллица в именах запрещена (см. NAME_RE), поэтому подсказывать тут нечего.
    assert.equal(suggestEmojiName('гусь.webp'), '');
  });

  it('длинное имя обрезается и не заканчивается подчёркиванием', () => {
    const out = suggestEmojiName(`${'a'.repeat(30)} bbbb.png`);
    assert.equal(out.length <= 32, true);
    assert.equal(out.endsWith('_'), false);
  });

  it('то, что предложили, проходит проверку имени', () => {
    // Подсказка обязана быть валидной, иначе поле откроется сразу с ошибкой.
    const name = suggestEmojiName('Party Parrot (1).gif');
    assert.equal(checkEmojiName(name).ok, true);
  });
});
