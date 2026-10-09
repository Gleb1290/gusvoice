import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rules from './dmFolders';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./dmFolders.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
  return module.exports as typeof rules;
}

const folder: rules.DmFolder = { id:'f',title:'Папка',emoticon:null,flags:rules.DM_FOLDER_PERSONAL,include:[],exclude:[] };
const chat: rules.DmFolderChat = { id:'c',muted:false,unread:true };

it('R129 собственные закрепы отличаются от общего режима: null у системы и старой папки, пустой набор у новой', () => {
  // Иначе отсутствие собственных закрепов случайно включает общий набор либо переносит его в системную папку.
  for (const input of [{}, { pinned: ['a'] }, { system: 'dms' as const, pinnedOwn: true as const, pinned: ['a'] }]) {
    assert.equal(rules.dmFolderOwnPins(input), null);
  }
  assert.deepEqual(rules.dmFolderOwnPins({ pinnedOwn: true }), []);
  assert.deepEqual(rules.dmFolderOwnPins({ pinnedOwn: true, pinned: [] }), []);
  const pinned = ['a', 'b'];
  assert.equal(rules.dmFolderOwnPins({ pinnedOwn: true, pinned }), pinned);
  assert.equal(rules.DM_FOLDER_PINNED_MAX, 100);
});

it('R129 новый закреп в папке ставится сверху, повтор не дублирует и входной набор не меняется', () => {
  // Новый локальный закреп не должен скрываться под прежними или удваиваться при повторном событии.
  const check = (api: typeof rules) => {
    const input = ['a', 'b'];
    const added = api.dmFolderPinToggled(input, 'c', true);
    assert.deepEqual([...added], ['c', 'a', 'b']);
    assert.deepEqual([...api.dmFolderPinToggled(added, 'c', true)], ['c', 'a', 'b']);
    assert.deepEqual([...api.dmFolderPinToggled(['a', 'b', 'a'], 'a', true)], ['a', 'b']);
    assert.deepEqual([...api.dmFolderPinToggled([], 'a', true)], ['a']);
    assert.deepEqual(input, ['a', 'b']);
  };
  check(rules);
  assert.throws(() => check(mutant('return pinned ? [id, ...rest] : rest;', 'return pinned ? [...rest, id] : rest;')), assert.AssertionError);
});

it('R129 открепление убирает все повторы id, отсутствующий id не затрагивает соседей', () => {
  // Повтор события открепления не должен выбрасывать чужой первый/последний закреп из набора.
  const input = ['a', 'b', 'a', 'c'];
  assert.deepEqual(rules.dmFolderPinToggled(input, 'a', false), ['b', 'c']);
  assert.deepEqual(rules.dmFolderPinToggled(input, 'missing', false), input);
  assert.deepEqual(rules.dmFolderPinToggled([], 'missing', false), []);
  assert.deepEqual(input, ['a', 'b', 'a', 'c']);
});

it('R129 полный список собственных закрепов задаёт ровно запрошенный порядок', () => {
  // Перестановка не должна молча сохранять старые позиции из-за потерянного указателя named[k++].
  const check = (api: typeof rules) => {
    const input = ['a', 'b', 'c', 'd']; const ids = ['d', 'b', 'a', 'c'];
    assert.deepEqual([...api.dmFolderPinSlots(input, ids)], ids);
    assert.deepEqual(input, ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids, ['d', 'b', 'a', 'c']);
  };
  check(rules);
  assert.throws(() => check(mutant('named[k++]', 'id')), assert.AssertionError);
});

it('R129 частичный порядок меняет только слоты названных, пропущенные остаются на прежних местах', () => {
  // Старый клиент переставляет часть общих закрепов и не должен сдвигать собственные, которых он не знает.
  const set = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rules.dmFolderPinSlots(set, ['e', 'b']), ['a', 'e', 'c', 'd', 'b']);
  assert.deepEqual(rules.dmFolderPinSlots(set, ['e', 'a', 'c']), ['e', 'b', 'a', 'd', 'c']);
  assert.deepEqual(rules.dmFolderPinSlots(set, ['c']), set);
  assert.deepEqual(rules.dmFolderPinSlots(set, []), set);
});

it('R129 чужие id и повторы в частичном порядке игнорируются и не добавляют беседы', () => {
  // Повторы/устаревший общий набор не должны менять длину или подменять существующие локальные закрепы.
  const set = ['a', 'b', 'c', 'd'];
  assert.deepEqual(rules.dmFolderPinSlots(set, ['foreign', 'd', 'b', 'd', 'gone', 'b']), ['a', 'd', 'c', 'b']);
  assert.deepEqual(rules.dmFolderPinSlots(set, ['foreign', 'foreign']), set);
  assert.deepEqual(rules.dmFolderPinSlots([], ['foreign']), []);
  assert.deepEqual(set, ['a', 'b', 'c', 'd']);
});

it('R129 свой закреп виден вопреки типу и NO_READ/NO_MUTED, незакреплённые по-прежнему фильтруются', () => {
  // Человек вручную закрепил прочитанную заглушенную группу — правила папки не должны прятать её сразу после клика.
  const f: rules.DmFolder = { ...folder, flags: rules.DM_FOLDER_PERSONAL | rules.DM_FOLDER_NO_READ | rules.DM_FOLDER_NO_MUTED,
    pinnedOwn: true, pinned: ['c'] };
  const filtered = { ...chat, group: true, unread: false, muted: true };
  assert.equal(rules.dmFolderContains(f, filtered), true);
  assert.equal(rules.dmFolderContains(f, { ...filtered, id: 'outside' }), false);
  assert.equal(rules.dmFolderContains({ ...f, flags: 0 }, filtered), true);
});

it('R129 явное исключение сильнее собственного закрепа, включения, типа и удержания открытой беседы', () => {
  // Возврат исключённой беседы через набор закрепов нарушает решение «Убрать из папки».
  const check = (api: typeof rules) => {
    const f: rules.DmFolder = { ...folder, include: ['c'], exclude: ['c'], pinnedOwn: true, pinned: ['c'] };
    assert.equal(api.dmFolderContains(f, chat), false);
    assert.equal(api.dmFolderContains(f, chat, true), false);
    assert.equal(api.dmFolderContains({ ...f, exclude: [] }, chat), true, 'без исключения свой закреп снова действует');
  };
  check(rules);
  assert.throws(() => check(mutant('if (f.exclude.includes(c.id)) return false;', '')), assert.AssertionError);
  // Удаление выше уже проверено; отдельно меняем порядок двух настоящих проверок целого модуля.
  const source = readFileSync(new URL('./dmFolders.ts', import.meta.url), 'utf8');
  const own = 'if (dmFolderOwnPins(f)?.includes(c.id)) return true;';
  assert.ok(source.includes(own));
  const module = { exports: {} };
  const moved = source.replace('if (f.exclude.includes(c.id)) return false;', '')
    .replace(own, `${own}\n  if (f.exclude.includes(c.id)) return false;`);
  assert.notEqual(moved, source);
  runInNewContext(ts.transpileModule(moved, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  assert.throws(() => check(module.exports as typeof rules), assert.AssertionError);
});

it('R129 старый pinned без pinnedOwn не обходит правила, собственный пустой набор не наследует чужие id', () => {
  // pinorder2 — только порядок общих закрепов, не явное включение прочитанной беседы в папку.
  const read = { ...chat, unread: false };
  const f: rules.DmFolder = { ...folder, flags: rules.DM_FOLDER_PERSONAL | rules.DM_FOLDER_NO_READ, pinned: ['c'] };
  assert.equal(rules.dmFolderContains(f, read), false);
  assert.equal(rules.dmFolderContains({ ...f, pinnedOwn: true }, read), true);
  assert.equal(rules.dmFolderContains({ ...f, pinnedOwn: true, pinned: [] }, read), false);
  assert.equal(rules.dmFolderContains({ ...f, pinnedOwn: true, pinned: undefined }, read), false);
});

it('R129 удаление беседы из папки снимает её собственный закреп, но не меняет старый общий порядок', () => {
  // Скрытая беседа иначе останется в наборе и вернётся после следующего снимка/перестановки папки.
  const own: rules.DmFolder = { ...folder, include: ['c'], pinnedOwn: true, pinned: ['a', 'c', 'b'] };
  const removed = rules.dmFolderToggled(own, chat, false);
  assert.deepEqual(removed.pinned, ['a', 'b']);
  assert.deepEqual(removed.include, []);
  assert.deepEqual(removed.exclude, ['c']);
  assert.equal(rules.dmFolderContains(removed, chat), false);
  assert.deepEqual(own.pinned, ['a', 'c', 'b']);
  const manual = rules.dmFolderToggled({ ...own, flags: 0 }, chat, false);
  assert.deepEqual(manual.pinned, ['a', 'b']);
  assert.deepEqual(manual.exclude, [], 'после снятия явного закрепа без типа исключать уже нечего');
  assert.deepEqual(rules.dmFolderToggled({ ...own, pinnedOwn: undefined }, chat, false).pinned, ['a', 'c', 'b']);
  assert.deepEqual(rules.dmFolderToggled({ ...own, exclude: ['c'] }, chat, true).pinned, ['a', 'c', 'b']);
});

it('R126 новые закрепы сверху в общем порядке, названные дальше в порядке папки', () => {
  const input = ['new-a', 'old-a', 'new-b', 'old-b']; const order = ['old-b', 'gone', 'old-a'];
  assert.deepEqual(rules.dmFolderPinnedOrder(input, order), ['new-a', 'new-b', 'old-b', 'old-a']);
  assert.deepEqual(input, ['new-a', 'old-a', 'new-b', 'old-b']); assert.deepEqual(order, ['old-b', 'gone', 'old-a']);
  assert.throws(() => assert.deepEqual([...mutant('return [...fresh, ...placed];', 'return [...placed, ...fresh];').dmFolderPinnedOrder(input, order)],
    ['new-a', 'new-b', 'old-b', 'old-a']), assert.AssertionError);
});
it('R126 пустой порядок закрепов сохраняет исходный, возвращая отдельный массив', () => {
  const input = ['a', 'b'];
  for (const order of [undefined, []]) {
    const result = rules.dmFolderPinnedOrder(input, order);
    assert.deepEqual(result, input); assert.notEqual(result, input);
  }
  assert.deepEqual(rules.dmFolderPinnedOrder([], ['a']), []);
});
it('R126 лишние id не добавляются, повтор порядка берёт первое вхождение', () => {
  assert.deepEqual(rules.dmFolderPinnedOrder(['a', 'b', 'c'], ['b', 'a', 'b', 'missing']), ['c', 'b', 'a']);
  assert.deepEqual(rules.dmFolderPinnedOrder(['a', 'b'], ['missing']), ['a', 'b']);
});
it('системные личные включают группы, пользовательские личные — нет, исключение сильнее системы', () => {
  // Ловит исчезновение групп из системной папки и обход явного исключения.
  const group = { ...chat, group: true, muted: true, unread: false };
  const system = { ...folder, system: 'dms' as const };
  assert.equal(rules.dmFolderContains(system, group), true);
  assert.equal(rules.dmFolderContains(folder, group), false);
  assert.equal(rules.dmFolderContains({ ...system, exclude: ['c'] }, group), false);
  assert.throws(() => assert.equal(mutant('if (f.system) return true;', '').dmFolderContains(system, group), true), assert.AssertionError);
});
it('исключение главнее включения и типа, непрочитанное открытой беседы удерживается до ухода', () => {
  // Прочитанная текущая строка не должна исчезать под пальцем, но исключение всегда уважается.
  assert.equal(rules.dmFolderContains(folder,chat),true);
  assert.equal(rules.dmFolderContains({ ...folder,include:['c'],exclude:['c'] },chat),false);
  assert.equal(rules.dmFolderContains({ ...folder,flags:rules.DM_FOLDER_PERSONAL|rules.DM_FOLDER_NO_MUTED },{...chat,muted:true}),false);
  const unread = { ...folder,flags:rules.DM_FOLDER_PERSONAL|rules.DM_FOLDER_NO_READ };
  assert.equal(rules.dmFolderContains(unread,{...chat,unread:false}),false); assert.equal(rules.dmFolderContains(unread,{...chat,unread:false},true),true);
  assert.equal(rules.dmFolderContains(folder,{...chat,group:true}),false);
  assert.throws(() => assert.equal(mutant('if (f.exclude.includes(c.id)) return false;', '').dmFolderContains({ ...folder,include:['c'],exclude:['c'] },chat),false), assert.AssertionError);
  assert.throws(() => assert.equal(mutant('(f.flags & type) !== 0 &&', '(f.flags & type) !== 0 ||').dmFolderContains({ ...folder,flags:rules.DM_FOLDER_PERSONAL|rules.DM_FOLDER_NO_MUTED },{...chat,muted:true}),false), assert.AssertionError);
});
it('ручное добавление и удаление учитывают тип и не оставляют пустую папку без правила', () => {
  // Последняя явная беседа — единственное содержимое такой папки, убрать её нельзя.
  const manual = { ...folder,flags:0,include:['c'] };
  assert.equal(rules.dmFolderCanRemove(manual,chat),false); assert.equal(rules.dmFolderCanRemove(folder,chat),true);
  assert.deepEqual(rules.dmFolderToggled(folder,chat,false).exclude,['c']);
  assert.deepEqual(rules.dmFolderToggled({ ...folder,exclude:['c'] },chat,true).exclude,[]);
  assert.deepEqual(rules.dmFolderToggled({ ...folder,flags:0 },chat,true).include,['c']);
});
it('пределы имени и списков проходят ровно на границе, порядок — только полная перестановка', () => {
  // Папка не должна терять сотую беседу или принять повторяющийся порядок.
  const input = { title:'x'.repeat(12),flags:rules.DM_FOLDER_PERSONAL,include:Array.from({length:100},(_,i)=>String(i)),exclude:[] };
  assert.equal(rules.dmFolderInputError(input),null); assert.equal(rules.dmFolderInputError({...input,title:'x'.repeat(13)}),'title_long');
  assert.throws(() => assert.equal(mutant('input.include.length > DM_FOLDER_CHATS_MAX', 'input.include.length >= DM_FOLDER_CHATS_MAX').dmFolderInputError(input),null), assert.AssertionError);
  assert.equal(rules.dmFolderInputError({...input,include:[...input.include,'101']}),'too_many_chats');
  assert.equal(rules.dmFolderInputError({...input,title:' '}),'title_empty'); assert.equal(rules.DM_FOLDERS_MAX,10);
  assert.deepEqual(rules.reorderDmFolders(['a','b'],['b','a']),['b','a']);
  for (const ids of [['a'],['a','a'],['a','x']]) assert.equal(rules.reorderDmFolders(['a','b'],ids),null);
});
