import assert from 'node:assert/strict';
import { checkUserPackQuota, stickerPackMatches, reorderStickerPacks } from './stickerRules';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

it('личная квота принимает 39 и отказывает на 40, поиск нормализует ё и перестановка ничего не теряет', () => {
  // Предел относится к загрузке, а неправильная перестановка не должна молча удалять набор другого устройства.
  assert.equal(checkUserPackQuota(39).ok,true); assert.equal(checkUserPackQuota(40).ok,false); assert.equal(checkUserPackQuota(41).ok,false);
  const source = readFileSync(new URL('./stickerRules.ts', import.meta.url), 'utf8');
  const needle = 'uploaded >= STICKER_PACKS_PER_USER';
  assert.ok(source.includes(needle));
  const module = { exports: {} as { checkUserPackQuota: typeof checkUserPackQuota } };
  runInNewContext(ts.transpileModule(source.replace(needle, 'uploaded > STICKER_PACKS_PER_USER'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  assert.throws(() => assert.equal(module.exports.checkUserPackQuota(40).ok, false), assert.AssertionError);
  const pack = { title: 'Ёжики', name: 'HappyHedgehogs' };
  for (const q of ['', ' ', 'ЕЖ', 'happy']) assert.equal(stickerPackMatches(pack,q),true);
  assert.equal(stickerPackMatches(pack,'cats'),false);
  assert.deepEqual(reorderStickerPacks(['a','b'],['b','a']),['b','a']); assert.deepEqual(reorderStickerPacks([],[]),[]);
  for (const order of [['a'],['a','a'],['a','x'],['a','b','c']]) assert.equal(reorderStickerPacks(['a','b'],order),null);
});
import { describe, it } from 'node:test';
import {
  checkPackImport,
  parseStickerSetName,
  STICKER_PACKS_PER_SERVER,
  STICKERS_PER_PACK,
  stickerFormatFromPath,
} from './stickerRules.js';

/**
 * Правила импорта наборов.
 *
 * На каждое «принимается» здесь есть парное «отклоняется»: имя набора уходит в путь запроса к
 * api.telegram.org, и молча принятый мусор — это не косметика, а чужие обращения от нашего сервера.
 */
describe('имя набора', () => {
  it('голое имя проходит', () => {
    assert.deepEqual(parseStickerSetName('HotCherry'), { ok: true, name: 'HotCherry' });
  });

  it('полная ссылка разбирается', () => {
    assert.deepEqual(parseStickerSetName('https://t.me/addstickers/HotCherry'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('ссылка без схемы тоже', () => {
    assert.deepEqual(parseStickerSetName('t.me/addstickers/HotCherry'), { ok: true, name: 'HotCherry' });
  });

  it('tg://-ссылка тоже', () => {
    assert.deepEqual(parseStickerSetName('tg://addstickers?set=HotCherry'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('хвост запроса и якорь отбрасываются', () => {
    assert.deepEqual(parseStickerSetName('https://t.me/addstickers/HotCherry?single#x'), {
      ok: true,
      name: 'HotCherry',
    });
  });

  it('пробелы по краям срезаются', () => {
    assert.equal(parseStickerSetName('  HotCherry  ').ok, true);
  });

  it('имя бота в хвосте набора не мешает', () => {
    assert.deepEqual(parseStickerSetName('my_pack_by_SomeBot'), { ok: true, name: 'my_pack_by_SomeBot' });
  });

  it('пустая строка отклоняется', () => {
    assert.equal(parseStickerSetName('   ').ok, false);
  });

  it('обход пути отклоняется — ради этого правило и существует', () => {
    assert.equal(parseStickerSetName('../../bot123/getMe').ok, false);
    assert.equal(parseStickerSetName('HotCherry/../x').ok, false);
  });

  it('имя с точками и слэшами отклоняется', () => {
    assert.equal(parseStickerSetName('hot.cherry').ok, false);
    assert.equal(parseStickerSetName('hot/cherry').ok, false);
  });

  it('имя, начинающееся с цифры или подчёркивания, отклоняется', () => {
    assert.equal(parseStickerSetName('1pack').ok, false);
    assert.equal(parseStickerSetName('_pack').ok, false);
  });

  it('слишком длинное отклоняется', () => {
    assert.equal(parseStickerSetName(`A${'a'.repeat(64)}`).ok, false);
  });

  it('имя ровно в 64 символа ещё принимается', () => {
    assert.equal(parseStickerSetName(`A${'a'.repeat(63)}`).ok, true);
  });

  it('кириллица отклоняется', () => {
    assert.equal(parseStickerSetName('стикеры').ok, false);
  });

  it('чужая ссылка на канал отклоняется с понятной подсказкой', () => {
    const res = parseStickerSetName('https://t.me/some_channel');
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /addstickers/);
  });
});

describe('формат по пути файла', () => {
  it('три формата Telegram распознаются', () => {
    assert.equal(stickerFormatFromPath('stickers/file_0.webp'), 'webp');
    assert.equal(stickerFormatFromPath('stickers/file_1.tgs'), 'tgs');
    assert.equal(stickerFormatFromPath('stickers/file_2.webm'), 'webm');
  });

  it('регистр расширения не важен', () => {
    assert.equal(stickerFormatFromPath('a/B.WEBP'), 'webp');
  });

  it('старые наборы в PNG считаются статикой', () => {
    assert.equal(stickerFormatFromPath('stickers/old.png'), 'webp');
  });

  it('незнакомое расширение даёт null — такой стикер пропускаем', () => {
    assert.equal(stickerFormatFromPath('stickers/file.mp4'), null);
    assert.equal(stickerFormatFromPath('stickers/file'), null);
  });
});

describe('размер набора', () => {
  it('обычный набор проходит', () => {
    assert.deepEqual(checkPackImport(30, 0), { ok: true });
  });

  it('ровно предельный набор ещё проходит', () => {
    assert.equal(checkPackImport(STICKERS_PER_PACK, 0).ok, true);
  });

  it('пустой набор отклоняется', () => {
    assert.equal(checkPackImport(0, 0).ok, false);
  });

  it('слишком большой набор отклоняется', () => {
    assert.equal(checkPackImport(STICKERS_PER_PACK + 1, 0).ok, false);
  });

  it('переполненный сервер отклоняется', () => {
    assert.equal(checkPackImport(10, STICKER_PACKS_PER_SERVER).ok, false);
  });

  it('на один меньше лимита ещё проходит', () => {
    assert.equal(checkPackImport(10, STICKER_PACKS_PER_SERVER - 1).ok, true);
  });
});
import { pushStickerId } from './stickerRules';

it('мутант без удаления повтора не проходит контракт списка и вытесненного хвоста', () => {
  // Ловит серверное удаление нужного стикера из-за ложного переполнения.
  const source = readFileSync(new URL('./stickerRules.ts',import.meta.url),'utf8');
  const from = '...list.filter((x) => x !== id)'; assert.ok(source.includes(from));
  const module = {exports:{}};
  runInNewContext(ts.transpileModule(source.replace(from,'...list'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports});
  const mutant = module.exports as typeof import('./stickerRules');
  assert.throws(()=>assert.equal(mutant.pushStickerId(['a','b'],'a',2).list.join(','),'a,b'),assert.AssertionError);
});

it('избранный повтор поднимается без вытеснения, шестой вытесняет старейшего', () => {
  // Ловит удаление правильной записи сервера при повторном добавлении избранного.
  const xs = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(pushStickerId(xs, 'c', 5), { list: ['c', 'a', 'b', 'd', 'e'], dropped: [] });
  assert.deepEqual(pushStickerId(xs, 'f', 5), { list: ['f', 'a', 'b', 'c', 'd'], dropped: ['e'] });
  assert.deepEqual(pushStickerId([], 'a', 5), { list: ['a'], dropped: [] });
  for (const max of [0, -1]) assert.deepEqual(pushStickerId(['b'], 'a', max), { list: [], dropped: ['a', 'b'] });
  assert.deepEqual(xs, ['a', 'b', 'c', 'd', 'e']);
});
it('недавние держат 20, двадцать первый вытесняет ровно одного', () => {
  // Ловит неправильное использование предела избранных у недавних.
  const xs = Array.from({ length: 20 }, (_, i) => String(i));
  const next = pushStickerId(xs, 'new', 20);
  assert.equal(next.list.length, 20);
  assert.equal(next.list[0], 'new');
  assert.deepEqual(next.dropped, ['19']);
});
