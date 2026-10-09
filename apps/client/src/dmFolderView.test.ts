import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DM_FOLDER_PERSONAL, dmFolderContains, type DmFolder } from '@gusvoice/shared';
import { folderBadge, neighbourFolder, folderSwipeDir } from './dmFolderView';
import * as rules from './dmFolderView';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

it('R129 свой набор идёт сверху в своём порядке, общий закреп вне набора возвращается на место по времени', () => {
  // Общий закреп не должен притворяться закрепом папки и вытеснять её собственный набор.
  const row = (id: string, day: number, pinnedAt: string | null = null) => ({ id, pinnedAt,
    createdAt: '2026-01-01T00:00:00Z', lastMessageAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` });
  const rows = [row('global-new', 8, '2026-10-09T00:00:00Z'), row('both', 3, '2026-10-08T00:00:00Z'),
    row('global-old', 1, '2026-10-07T00:00:00Z'), row('loose', 9), row('own', 2)];
  const before = JSON.stringify(rows);
  const check = (api: typeof rules) => {
    const next = api.folderOwnPinRows(rows, ['own', 'both', 'missing']);
    assert.deepEqual(Array.from(next, d => d.id), ['own', 'both', 'loose', 'global-new', 'global-old']);
    assert.equal(next[0].pinnedAt, rules.FOLDER_PIN_AT);
    assert.equal(next[1], rows[1], 'общий и свой закреп сохраняет настоящий pinnedAt');
    assert.equal(next[3].pinnedAt, null); assert.equal(next[4].pinnedAt, null);
    assert.equal(JSON.stringify(rows), before, 'признаки входного общего списка не изменены');
  };
  check(rules);
  assert.throws(() => check(changed('pinnedAt: FOLDER_PIN_AT', 'pinnedAt: null')), assert.AssertionError);
  assert.throws(() => check(changed('pinnedAt: null }', 'pinnedAt: d.pinnedAt }')), assert.AssertionError);
});

it('R129 пустой свой набор без общих закрепов сохраняет массив, снятие общего использует createdAt при пустом lastMessageAt', () => {
  // Без изменения порядка не нужна копия, а беседа без последнего сообщения не должна падать или уйти наверх.
  const free = [{ id: 'new', pinnedAt: null, createdAt: '2026-10-09', lastMessageAt: null }];
  assert.equal(rules.folderOwnPinRows(free, []), free);
  assert.equal(rules.folderOwnPinRows(free, ['missing']), free);
  const empty: typeof free = []; assert.equal(rules.folderOwnPinRows(empty, []), empty);
  const global = { id: 'old', pinnedAt: '2026-10-09', createdAt: '2026-10-01', lastMessageAt: null };
  const next = rules.folderOwnPinRows([global, ...free], []);
  assert.deepEqual(next.map(d => d.id), ['new', 'old']); assert.equal(next[1].pinnedAt, null);
});

it('R129 план перевода пропускает системные и свои наборы, соблюдает непрочитанное и исключение, сохраняет видимый порядок', () => {
  // Перевод пустой/прочитанной папки не должен переносить чужие общие закрепы или уничтожать уже свой набор.
  const base: DmFolder = { id: 'folder', title: 'Папка', emoticon: null,
    flags: shared.DM_FOLDER_PERSONAL | shared.DM_FOLDER_NO_READ, include: ['explicit'], exclude: ['excluded'], pinned: ['b', 'a'] };
  const folders: DmFolder[] = [{ ...base, id: 'system', system: 'dms' }, { ...base, id: 'own', pinnedOwn: true }, base];
  const ids = ['a', 'b', 'fresh', 'read', 'excluded', 'explicit', 'unknown', 'unpinned'];
  const dms = ids.map((id, i) => ({ id, pinnedAt: id === 'unpinned' ? null : `2026-10-${String(20 - i).padStart(2, '0')}` }));
  const chat = (id: string) => id === 'unknown' ? undefined : ({ id, unread: ['read', 'explicit'].includes(id) ? 0 : 1, muted: false, marked: false });
  const before = JSON.stringify({ folders, dms });
  const check = (api: typeof rules) => assert.equal(JSON.stringify(api.folderPinOwnPlan(folders, dms, chat)),
    JSON.stringify([{ id: 'folder', ids: ['fresh', 'explicit', 'b', 'a'] }]));
  check(rules);
  assert.throws(() => check(changed('if (f.system || f.pinnedOwn) continue;', 'if (f.system) continue;')), assert.AssertionError);
  assert.throws(() => check(changed('return !!c && dmFolderContains(f, folderChat(c));', 'return !!c;')), assert.AssertionError);
  assert.equal(JSON.stringify({ folders, dms }), before);
});

it('R129 пустой общий список переводит обычную папку в пустой набор, неизвестные беседы не добавляются', () => {
  // Пустая папка тоже требует отметки перехода: иначе миграция запускается заново после каждой синхронизации.
  const folder: DmFolder = { id: 'empty', title: 'Пусто', emoticon: null, flags: shared.DM_FOLDER_PERSONAL, include: [], exclude: [] };
  assert.deepEqual(rules.folderPinOwnPlan([folder], [], () => undefined), [{ id: 'empty', ids: [] }]);
  assert.deepEqual(rules.folderPinOwnPlan([folder], [{ id: 'missing', pinnedAt: '2026-10-09' }], () => undefined), [{ id: 'empty', ids: [] }]);
  assert.deepEqual(rules.folderPinOwnPlan([], [], () => undefined), []);
});

it('R129 текст предела использует серверное число, отсутствие числа даёт 100, ноль не заменяется умолчанием', () => {
  // Клиент должен объяснить действующий предел, не выдать устаревшее или ложное число при ответе сервера.
  assert.equal(rules.dmFolderPinLimitText(undefined), 'Достигнут лимит: в папке можно закрепить не больше 100 бесед');
  assert.equal(rules.dmFolderPinLimitText(7), 'Достигнут лимит: в папке можно закрепить не больше 7 бесед');
  assert.equal(rules.dmFolderPinLimitText(0), 'Достигнут лимит: в папке можно закрепить не больше 0 бесед');
});

it('R126 закрепы папки: неназванные сверху, названные в своём порядке, незакреплённые ниже', () => {
  // Закреп нового чата не должен тонуть под сохранённым порядком, а посторонний id не создаёт строку.
  const rows = ['fresh', 'a', 'b', 'free', 'later'].map((id, i) => ({ id, pinnedAt: i < 3 ? '2026-10-09T00:00:00Z' : null }));
  const before = JSON.stringify(rows);
  const next = rules.folderPinnedRows(rows, ['b', 'missing', 'a']);
  assert.deepEqual(next.map(r => r.id), ['fresh', 'b', 'a', 'free', 'later']);
  assert.equal(next[0], rows[0]); assert.equal(next[1], rows[2]);
  assert.equal(JSON.stringify(rows), before, 'перестановка не меняет входные строки');
});

it('R126 пустой порядок и менее двух закрепов сохраняют список папки без копирования', () => {
  // Пустая настройка не должна неожиданно переупорядочивать список общего пути.
  const rows = [{ id: 'free', pinnedAt: null }, { id: 'a', pinnedAt: '2026-10-09T00:00:00Z' }];
  for (const order of [undefined, [], ['a', 'foreign']]) assert.equal(rules.folderPinnedRows(rows, order), rows);
  const empty: typeof rows = [];
  assert.equal(rules.folderPinnedRows(empty, ['foreign']), empty);
});

it('R126 обёртка закрепов папки не включает незакреплённые в свой порядок', () => {
  // Названный свободный чат не должен стать закреплённым только из-за сохранённого id.
  const rows = [{ id: 'a', pinnedAt: '2026-10-09T00:00:00Z' }, { id: 'b', pinnedAt: '2026-10-08T00:00:00Z' }, { id: 'free', pinnedAt: null }];
  const check = (api: typeof rules) => assert.deepEqual(Array.from(api.folderPinnedRows(rows, ['free', 'b', 'a']), r => r.id), ['b', 'a', 'free']);
  check(rules);
  assert.throws(() => check(changed('const pinned = rows.filter((d) => !!d.pinnedAt);', 'const pinned = rows;')), assert.AssertionError);
});

function changed(from:string,to:string):typeof rules {
  const source=readFileSync(new URL('./dmFolderView.ts',import.meta.url),'utf8');assert.ok(source.includes(from));const module={exports:{}};
  runInNewContext(ts.transpileModule(source.replace(from,to),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:()=>shared});
  return module.exports as typeof rules;
}

it('Ctrl-цифры прижимаются к последней папке, восемь выбирает последнюю, девять зарезервирована архиву', () => {
  // Ловит обращение к отсутствующей вкладке и потерю горячей клавиши последней папки.
  const list = Array.from({length:3},(_,i)=>({id:String(i),title:'',flags:0,include:[],exclude:[],emoticon:null}));
  assert.equal(rules.folderByHotkey(list,1),list[0]); assert.equal(rules.folderByHotkey(list,5),list[2]);
  assert.equal(rules.folderByHotkey(list,8),list[2]);
  for(const n of [0,9,NaN,1.5]) assert.equal(rules.folderByHotkey(list,n),null);
  assert.equal(rules.folderByHotkey([],1),null);
  const long=Array.from({length:10},(_,i)=>({...list[0]!,id:String(i)}));
  assert.equal(rules.folderByHotkey(long,8),long[9]);
  const check=(api:typeof rules)=>{assert.equal(api.folderByHotkey(list,5),list[2]);assert.equal(api.folderByHotkey(long,8),long[9]);};
  check(rules);
  assert.throws(()=>check(changed('Math.min(n - 1, folders.length - 1)','n - 1')),assert.AssertionError);
  assert.throws(()=>check(changed('if (n === FOLDER_HOTKEY_LAST) return folders[folders.length - 1];','')),assert.AssertionError);
  const page=(api:typeof rules)=>{assert.equal(api.pageSettle(-100,0,300,{prev:true,next:true}),0);assert.equal(api.pageSettle(-101,0,300,{prev:true,next:true}),1);};
  page(rules);
  assert.throws(()=>page(changed('Math.abs(dx) > w * PAGE_COMMIT_FRACTION','Math.abs(dx) >= w * PAGE_COMMIT_FRACTION')),assert.AssertionError);
  assert.throws(()=>page(changed('const dir = dx < 0 ? 1 : -1;','const dir = dx < 0 ? -1 : 1;')),assert.AssertionError);
  for(const prefix of ['Digit','Numpad']) for(let n=1;n<=9;n++) assert.equal(rules.digitOfKey(prefix+n),n);
  for(const key of ['Digit0','Numpad0','KeyA','Digit10']) assert.equal(rules.digitOfKey(key),null);
});
it('перестановка уважает закреплённый префикс, пределы и неизменность исходного списка', () => {
  // Ловит перетаскивание системной папки и сдвиг за край списка.
  const ids=['system','a','b','c']; assert.equal(rules.foldersPinned([{id:'system',title:'',flags:0,emoticon:null,include:[],exclude:[],system:'dms'}]),1);
  assert.equal(rules.foldersPinned([]),0);
  assert.equal(rules.dropIndex([10,20,30,40],-100,1),1); assert.equal(rules.dropIndex([10,20,30,40],100,1),3);
  assert.deepEqual(rules.movedIds(ids,1,3,1),['system','b','c','a']); assert.deepEqual(ids,['system','a','b','c']);
  for(const [from,to] of [[1,1],[0,2],[2,0],[4,1],[1,4]]) assert.equal(rules.movedIds(ids,from,to,1),null);
  assert.equal(rules.dragShift(2,1,3),-1); assert.equal(rules.dragShift(2,3,1),1);
  assert.equal(rules.dragShift(0,1,3),0); assert.equal(rules.dragShift(1,1,3),0);
});
it('листание требует больше трети или согласованного броска, у края сопротивление только без соседа', () => {
  // Ловит переход ровно на пороге, противоположный бросок и уход к несуществующей странице.
  const has={prev:true,next:true};
  assert.equal(rules.pageSettle(-100,0,300,has),0); assert.equal(rules.pageSettle(-100.01,0,300,has),1);
  assert.equal(rules.pageSettle(-10,-3500,300,has),0); assert.equal(rules.pageSettle(-10,-3501,300,has),1);
  assert.equal(rules.pageSettle(-10,4000,300,has),0); assert.equal(rules.pageSettle(110,0,300,has),-1);
  assert.equal(rules.pageSettle(-110,0,300,{prev:true,next:false}),0);
  assert.equal(rules.pageOffset(-100,has),-100); assert.equal(rules.pageOffset(-100,{prev:true,next:false}),-25);
});

it('бейдж тихий лишь без громких, навигация папок не зацикливается, свайп уважает границы', () => {
  // Тихие чаты не должны маскировать громкое сообщение, а вертикальная прокрутка не листает папки.
  const f: DmFolder = { id:'a',title:'a',flags:DM_FOLDER_PERSONAL,emoticon:null,include:[],exclude:[] }; const b = {...f,id:'b'};
  const quiet = { id:'q',muted:true,marked:false,unread:3 };
  assert.deepEqual(folderBadge(f,[quiet]),{n:3,muted:true}); assert.deepEqual(folderBadge(f,[quiet,{...quiet,id:'l',muted:false,unread:2}]),{n:2,muted:false});
  assert.equal(neighbourFolder([f,b],'a',-1),null); assert.equal(neighbourFolder([f,b],'b',1),null); assert.equal(neighbourFolder([f,b],'a',1),b);
  assert.equal(folderSwipeDir(-63,0),0); assert.equal(folderSwipeDir(-64,0),1); assert.equal(folderSwipeDir(64,0),-1); assert.equal(folderSwipeDir(-64,33),0);
});

it('обёртка папки передаёт признак группы: «Личные сообщения» включает группы, личная папка — нет', () => {
  // Если обёртка теряет group, системная папка и пользовательский фильтр расходятся с фактическими типами бесед.
  const system: DmFolder = { id: 'all', title: '', flags: 0, emoticon: null, include: [], exclude: [], system: 'dms' };
  const personal: DmFolder = { id: 'personal', title: '', flags: DM_FOLDER_PERSONAL, emoticon: null, include: [], exclude: [] };
  const groupState = { id: 'g', group: true, unread: 0, marked: false, muted: false };
  const directState = { id: 'd', group: false, unread: 0, marked: false, muted: false };
  const check = (api: typeof rules) => {
    const group = api.folderChat(groupState); const oneToOne = api.folderChat(directState);
    assert.equal(group.group, true);
    assert.equal(dmFolderContains(system, group), true);
    assert.equal(dmFolderContains(personal, group), false);
    assert.equal(dmFolderContains(personal, oneToOne), true);
  };
  check(rules);
  check(changed('group: c.group,', 'group: c.group,'));
  assert.throws(() => check(changed('group: c.group,', 'group: false,')), assert.AssertionError,
    'мутант теряет группу при передаче в системное/личное правило папки');
});
