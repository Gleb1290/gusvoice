import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameFromFileName, SOUNDBOARD_NAME_MAX } from './soundboardPick.js';

describe('nameFromFileName', () => {
  it('срезает расширение', () => {
    assert.equal(nameFromFileName('vzhuh.mp3'), 'vzhuh');
  });

  it('режет по ПОСЛЕДНЕЙ точке, а не по первой', () => {
    assert.equal(nameFromFileName('vzhuh.2.mp3'), 'vzhuh.2');
  });

  it('файл без расширения остаётся собой', () => {
    assert.equal(nameFromFileName('vzhuh'), 'vzhuh');
  });

  it('скрытый файл не теряет имя целиком', () => {
    // Точка ПЕРВЫМ символом — не расширение: «.gitignore» это имя, а не пустое имя с расширением.
    assert.equal(nameFromFileName('.vzhuh'), '.vzhuh');
  });

  it('подчёркивания и дефисы становятся пробелами', () => {
    assert.equal(nameFromFileName('gus_krik-2.wav'), 'gus krik 2');
  });

  it('лишние пробелы схлопываются, края обрезаются', () => {
    assert.equal(nameFromFileName('  два   слова .ogg'), 'два слова');
  });

  it('длина режется по потолку поля', () => {
    const long = `${'а'.repeat(60)}.mp3`;
    assert.equal(nameFromFileName(long).length, SOUNDBOARD_NAME_MAX);
  });

  it('пустой результат остаётся ПУСТЫМ, а не выдуманным', () => {
    // Выдуманное имя человек может не заметить и залить кнопку с чужой подписью.
    assert.equal(nameFromFileName('___.mp3'), '');
    assert.equal(nameFromFileName(''), '');
  });
});
