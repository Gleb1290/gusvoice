import assert from 'node:assert/strict';
import { it } from 'node:test';
import { pushRecentSticker, parseRecentStickers, moveStickerPack, stickerPackButton, serverDmStickers } from './dmStickerRules';
import type { Sticker } from '@gusvoice/shared';
import { bareEmoji, isFavedSticker, stickersForEmoji, serverStickerLists } from './dmStickerRules';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as stickerRules from './dmStickerRules';

it('подсказки отсекают мутанты нормализации, порядка источников и совпадения только по id', () => {
  // Ловит регрессии, которые обычный пример с единственным избранным не отличит.
  const source = readFileSync(new URL('./dmStickerRules.ts', import.meta.url), 'utf8');
  const a: Sticker = { id: 'a', url: '/a', format: 'webp', emoji: '👍🏻' };
  const b: Sticker = { ...a, id: 'b', url: '/b', emoji: '👍' };
  const check = (api: typeof stickerRules) => {
    assert.equal(api.isFavedSticker([a], { id: 'copy', url: '/a' }), true);
    assert.equal(api.stickersForEmoji('👍🏿', { faved: [a], recent: [b] }).map(s => s.id).join(','), 'a,b');
  }; check(stickerRules);
  for (const [from, to] of [['return e.replace', 'return e; //'], ['x.id === s.id || x.url === s.url', 'x.id === s.id'],
    ['for (const s of sources.faved ?? []) take(s);', 'for (const s of sources.recent ?? []) take(s);\n  for (const s of sources.faved ?? []) take(s);']] as const) {
    assert.ok(source.includes(from)); const module = { exports: {} };
    runInNewContext(ts.transpileModule(source.replace(from,to), { compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022} }).outputText,
      {module,exports:module.exports,require:()=>shared});
    assert.throws(()=>check(module.exports as typeof stickerRules),assert.AssertionError);
  }
});

it('избранное узнаёт каталожную копию по url и исходный стикер по id', () => {
  // Ловит дублирование звезды для одного изображения с разными id.
  const s: Sticker = { id: 'a', url: '/a', format: 'webp', emoji: '👍🏻' };
  assert.equal(isFavedSticker([s], { id: 'copy', url: '/a' }), true);
  assert.equal(isFavedSticker([s], { id: 'a', url: '/new' }), true);
  assert.equal(isFavedSticker([s], { id: 'b', url: '/b' }), false);
  assert.equal(isFavedSticker([], s), false);
  assert.equal(serverStickerLists(['stickers3']), true);
  for (const features of [undefined, null, [], ['stickers2']]) assert.equal(serverStickerLists(features), false);
});
it('подсказка нормализует селектор и тон кожи, отдаёт избранное раньше недавнего и набора', () => {
  // Ловит отсутствие совпадения с клавиатурным эмодзи и повтор картинки из разных источников.
  const a: Sticker = { id: 'a', url: '/a', format: 'webp', emoji: '👍🏻' };
  const b: Sticker = { ...a, id: 'b', url: '/b', emoji: '👍️' };
  const c: Sticker = { ...a, id: 'c', url: '/c', emoji: '🔥👍' };
  const bad: Sticker = { ...a, id: 'bad', url: '/bad', emoji: '🔥' };
  const sources = { faved: [a], recent: [{ ...a, id: 'copy' }, b], packs: [{ stickers: [b, c, bad] }] };
  assert.deepEqual(stickersForEmoji(' 👍🏿 ', sources), [a, b, c]);
  assert.deepEqual(stickersForEmoji('👍', sources, 2), [a, b]);
  assert.deepEqual(stickersForEmoji('👍', sources, 0), []);
  assert.deepEqual(stickersForEmoji('', sources), []);
  assert.deepEqual(stickersForEmoji('👍', {}), []);
  assert.equal(bareEmoji('❤️'), '❤');
  assert.equal(bareEmoji('👍︎🏽'), '👍');
});

it('недавние дедуплицируются по url, а не id, максимум и пустой кеш соблюдаются', () => {
  // Каталожная копия одного набора имеет другой id, но не должна дублировать картинку в недавних.
  const a: Sticker = { id: 'a', url: '/a', format: 'webp', emoji: '' }; const copy = { ...a, id: 'copy' }; const b = { ...a, id: 'b', url: '/b' };
  assert.deepEqual(pushRecentSticker([a,b], copy, 2), [copy,b]); assert.deepEqual(pushRecentSticker([a,b], copy, 1), [copy]); assert.deepEqual(pushRecentSticker([a],copy,0), []);
  for (const raw of [null, '', 'broken', '{}', 'null']) assert.deepEqual(parseRecentStickers(raw), []);
  assert.deepEqual(parseRecentStickers(JSON.stringify([a, null, { ...a, format: 'svg' }])), [a]);
});
it('порядок стикеров не выходит за края и не меняет исходный массив', () => {
  // Сдвиг первого вверх и неизвестного набора не должен потерять соседний набор.
  const ids = ['a','b','c']; assert.deepEqual(moveStickerPack(ids, 'b', -1), ['b','a','c']); assert.deepEqual(moveStickerPack(ids, 'b', 1), ['a','c','b']);
  for (const [id,dir] of [['a',-1],['c',1],['absent',1]] as const) assert.deepEqual(moveStickerPack(ids,id,dir),ids);
  assert.deepEqual(ids,['a','b','c']);
});
it('кнопка склоняет числа и поддержка включается только своим признаком', () => {
  // Для 11 нельзя использовать окончание 1, а старому серверу нельзя показывать отправку стикера.
  for (const [n,word] of [[1,'стикер'],[2,'стикера'],[5,'стикеров'],[11,'стикеров'],[21,'стикер']] as const) {
    assert.equal(stickerPackButton(n,false), `Добавить ${n} ${word}`); assert.equal(stickerPackButton(n,true), `Убрать ${n} ${word}`);
  }
  assert.equal(serverDmStickers(['stickers2']),true); for (const f of [null,undefined,[],['conv13']]) assert.equal(serverDmStickers(f),false);
});
