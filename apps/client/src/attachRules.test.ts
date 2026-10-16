import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { videoSoftLimit } from './attachRules';
import { ATTACH_MAX, ATTACH_MAX_BYTES, VIDEO_SOFT_LIMIT, attachMode, attachRoom, fitAttachments, droppedAttachText, toggleSelected, selectedNumber, overLimit, formatDuration, pickRecorderType, RECORDER_TYPES, selectionTitle, recentFilesOf, fitWithin, compressedName, permNotice, thumbPx, skippedText, recordingFull, photoCompressible, baseMime, captureName, fileBadge, fileSizeText, serverScheduledAttachments } from './attachRules';

it('нативная галерея важнее устройства, камера листа нужна только телефону вне оболочки ПК', () => {
  // Один coarse не доказывает наличие камеры, а оболочка ПК не должна показывать мобильный лист.
  for (const coarse of [false, true]) for (const camera of [false, true]) for (const desktopShell of [false, true]) {
    assert.equal(attachMode({ nativeGallery: true, coarse, camera, desktopShell }), 'native');
    assert.equal(attachMode({ nativeGallery: false, coarse, camera, desktopShell }), coarse && camera && !desktopShell ? 'sheet' : 'input');
  }
});

it('вложения берутся в порядке выбора только до свободного места, а хвост объясняется', () => {
  // Молчаливый slice терял выбранные фото: проверяем и частичное заполнение, и точное/нулевое свободное место.
  const incoming = Array.from({ length: 12 }, (_, i) => ({ id: i }));
  const partial = fitAttachments(8, incoming.slice(0, 5));
  assert.deepEqual(partial.taken.map((x) => x.id), [0, 1]);
  assert.equal(partial.dropped, 3);
  const emptyField = fitAttachments(0, incoming);
  assert.deepEqual(emptyField.taken, incoming.slice(0, ATTACH_MAX));
  assert.equal(emptyField.dropped, 2);
  assert.deepEqual(fitAttachments(ATTACH_MAX, incoming.slice(0, 2)), { taken: [], dropped: 2 });
  assert.deepEqual(fitAttachments(ATTACH_MAX, incoming), { taken: [], dropped: 12 });
  const negativePending = fitAttachments(-3, incoming);
  assert.deepEqual(negativePending.taken, incoming.slice(0, ATTACH_MAX));
  assert.strictEqual(negativePending.taken[0], incoming[0], 'файлы берутся исходными объектами в исходном порядке');
  assert.equal(fitAttachments(3, incoming.slice(0, 3)).dropped, 0);
  assert.deepEqual(fitAttachments(0, incoming, 3), { taken: incoming.slice(0, 3), dropped: 9 });
  assert.match(droppedAttachText(), /10/);
  assert.match(droppedAttachText(), /лишние не добавлены/);
  const original = readFileSync(new URL('./attachRules.ts', import.meta.url), 'utf8');
  const changed = original.replace('dropped: incoming.length - taken.length', 'dropped: 0');
  assert.notEqual(changed, original, 'реальный модуль считает отброшенный хвост');
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: mod, exports: mod.exports, require: (id: string) => {
      if (id === '@gusvoice/shared') return { FEATURE_CONV10: 'conv10' };
      assert.equal(id, './convSyncRules'); return { serverScheduledAttachments: () => false };
    } });
  const mutant = mod.exports as typeof import('./attachRules');
  assert.throws(() => assert.deepEqual(mutant.fitAttachments(8, incoming.slice(0, 5)), { taken: incoming.slice(0, 2), dropped: 3 }), assert.AssertionError,
    'мутант, который скрывает число потерянных файлов, обязан провалить тот же контракт');
});

it('снятие выбора перенумеровывает следующие файлы даже при заполненном листе', () => {
  // Переполненный лист обязан позволять снять файл, а не запирать выбор навсегда.
  const original = ['a', 'b', 'c'];
  assert.deepEqual(toggleSelected(original, 'b', 3), { order: ['a', 'c'], full: false });
  assert.deepEqual(toggleSelected(original, 'd', 3), { order: original, full: true });
  assert.deepEqual(toggleSelected(['a'], 'b', 2), { order: ['a', 'b'], full: false });
  assert.deepEqual(toggleSelected([], 'a', 0), { order: [], full: true });
  assert.equal(selectedNumber(['a', 'c'], 'c'), 2); assert.equal(selectedNumber(original, 'missing'), 0);
  assert.deepEqual(original, ['a', 'b', 'c']);
  assert.deepEqual([-1, 0, 9, 10, 11].map(n => attachRoom(n)), [10, 10, 1, 0, 0]);
});

it('сжимаемое фото проходит сверх 25 МБ, оригинал видео и GIF проверяются с обеих сторон предела', () => {
  // Нельзя отвергать большой HEIC до сжатия или отправлять огромный GIF как будто он JPEG.
  for (const size of [0, ATTACH_MAX_BYTES, ATTACH_MAX_BYTES + 1]) {
    for (const mime of ['image/jpeg', 'image/heic', 'image/png']) assert.equal(overLimit({kind:'image', mime, size}, true), false);
    for (const item of [{kind:'video' as const,mime:'video/mp4'}, {kind:'image' as const,mime:'image/gif'}]) assert.equal(overLimit({...item,size}, true), size > ATTACH_MAX_BYTES);
    assert.equal(overLimit({kind:'image',mime:'image/jpeg',size}, false), size > ATTACH_MAX_BYTES);
  }
});

it('длительность отбрасывает неполную секунду и не теряет часы на границе', () => {
  // Формат минуты вместо часа и отрицательный таймер делают запись непонятной.
  for (const [ms, text] of [[-1,'0:00'],[NaN,'0:00'],[Infinity,'0:00'],[0,'0:00'],[999,'0:00'],[1000,'0:01'],[59999,'0:59'],[60000,'1:00'],[3599999,'59:59'],[3600000,'1:00:00'],[3723000,'1:02:03']] as const) assert.equal(formatDuration(ms),text);
});

it('запись выбирает первый MP4 перед WebM, тип файла не содержит кодеки', () => {
  // Сервер отвергнет тип с codecs, хотя браузер умеет писать такой контейнер.
  assert.deepEqual(pickRecorderType(() => true), {mime:RECORDER_TYPES[0],type:'video/mp4',ext:'mp4'});
  for (const mime of RECORDER_TYPES) assert.deepEqual(pickRecorderType(x => x===mime), {mime,type:mime.startsWith('video/mp4')?'video/mp4':'video/webm',ext:mime.startsWith('video/mp4')?'mp4':'webm'});
  assert.equal(pickRecorderType(() => false), null);
  assert.equal(pickRecorderType(() => {throw new Error('unsupported');}), null);
  assert.equal(pickRecorderType(mime => { if (mime === RECORDER_TYPES[0]) throw new Error('probe failed'); return mime === RECORDER_TYPES[1]; })?.mime, RECORDER_TYPES[1], 'ошибка одного probe не отменяет остальные поддерживаемые типы');
});

it('заголовки выбора различают 1 2 5 11 21 фотографию, видео и смесь', () => {
  // Последняя цифра без проверки 11 даёт неверное русское склонение.
  for (const [n, expected] of [[1,'Выбрана 1 фотография'],[2,'Выбрано 2 фотографии'],[5,'Выбрано 5 фотографий'],[11,'Выбрано 11 фотографий'],[21,'Выбрана 21 фотография']] as const) {
    assert.equal(selectionTitle(n,0),expected); assert.equal(selectionTitle(0,n),`Выбрано ${n} видео`);
  }
  assert.equal(selectionTitle(1,1),'Выбрано 2 медиафайла');
  assert.equal(selectionTitle(1,4),'Выбрано 5 медиафайлов');
  assert.equal(selectionTitle(10,11),'Выбран 21 медиафайл');
});

it('недавние файлы идут новыми сверху, повторный id и одинаковые имя с размером остаются один раз', () => {
  // Дубль с другой подписанной ссылкой не должен занимать весь список последних файлов.
  const a = (id:string, name=id, size=1) => ({id,url:`/${id}`,name,size,contentType:'image/png'});
  const lists={x:[{createdAt:'2026-10-01',attachments:[a('same'),a('name','shared',2)]}],y:[{createdAt:'2026-10-02',attachments:[{...a('same'),url:'/new'},a('other','shared',2),a('unique')]}]};
  assert.deepEqual(recentFilesOf(lists).map(x=>x.att.id),['same','other','unique']);
  assert.deepEqual(recentFilesOf(lists,2).map(x=>x.att.id),['same','other']);
  assert.equal(lists.x[0]!.attachments[0]!.url,'/same');
});

it('недавние файлы исключают голосовые и кеш без ссылки, одинаковая ссылка без id не повторяется', () => {
  // Голосовое нельзя переслать как обычный файл, а у кеша нет доступных байтов.
  const file={url:'/a',name:'a',size:1,contentType:'image/png'};
  assert.deepEqual(recentFilesOf({a:undefined,b:[{createdAt:'bad',attachments:[file,{...file,name:'alias'},{...file,url:'/voice',waveform:[1]},{...file,url:''},{...file,url:'/empty',name:'empty',waveform:[]}]}]}).map(x=>x.att.name),['a','empty']);
  assert.deepEqual(recentFilesOf({}),[]);
});

it('одна ссылка с разными id не дублируется, а независимый файл не теряется', () => {
  // Регрессия найденного 06.10 бага: id раньше вытеснял url из набора ключей дедупликации.
  const a={id:'a',url:'/same',name:'a',size:1,contentType:'image/png'};
  const b={...a,id:'b',name:'b',size:2};
  const c={...a,id:'c',url:'/other',name:'c',size:3};
  assert.deepEqual(recentFilesOf({x:[{createdAt:'2026-10-06',attachments:[a,b,c]}]}).map(x=>x.att.id),['a','c']);
});

it('нулевой и отрицательный предел недавних файлов не добавляют первый элемент', () => {
  // Прежняя проверка после push нарушала даже нулевой предел; положительный сосед должен остаться рабочим.
  const lists={x:[{createdAt:'2026-10-06',attachments:[{id:'a',url:'/a',name:'a',size:1,contentType:'image/png'}]}]};
  assert.deepEqual(recentFilesOf(lists,0),[]);assert.deepEqual(recentFilesOf(lists,-1),[]);
  assert.equal(recentFilesOf(lists,1).length,1);
});

it('вписывание не увеличивает маленькое фото и сохраняет пропорции обеих ориентаций', () => {
  // Независимое ограничение ширины и высоты растягивает изображение.
  assert.deepEqual(fitWithin(100,50,2560),{w:100,h:50});
  assert.deepEqual(fitWithin(5120,2560,2560),{w:2560,h:1280});
  assert.deepEqual(fitWithin(2560,5120,2560),{w:1280,h:2560});
  assert.deepEqual(fitWithin(2560,2560,2560),{w:2560,h:2560});
  assert.deepEqual(fitWithin(0,0,2560),{w:1,h:1});
});

it('сжатое имя меняет только последнее расширение и не становится пустым', () => {
  // Имя JPEG с расширением HEIC мешает системе открыть скачанный файл.
  for (const [name,expected] of [['IMG_1.HEIC','IMG_1.jpg'],['a.b.png','a.b.jpg'],['plain','plain.jpg'],['','photo.jpg'],['.png','photo.jpg']]) assert.equal(compressedName(name!),expected);
  assert.equal(baseMime(' IMAGE/PNG; codecs=x '),'image/png');
  assert.equal(photoCompressible('IMAGE/AVIF;foo=bar'),true);
  for (const mime of ['image/gif','image/svg+xml','video/mp4']) assert.equal(photoCompressible(mime),false);
});

it('разрешения отличают повторный запрос от перехода в настройки при запрете', () => {
  // blocked нельзя лечить повтором запроса, который Android уже не покажет.
  assert.equal(permNotice('granted'),null);
  for (const perm of ['partial','ask','blocked'] as const) {
    const notice=permNotice(perm); assert.ok(notice,'отказ имеет объяснение');
    assert.equal(notice.action,perm==='blocked'?'settings':'ask'); assert.ok(notice.text && notice.button,'плашка не пустая');
  }
});

it('миниатюры ограничены 160–480, неизвестная плотность считается единицей', () => {
  // Некорректная плотность не должна отправлять в мост гигантский или нулевой размер.
  for (const [css,dpr,expected] of [[79,2,160],[80,2,160],[81,2,162],[239,2,478],[240,2,480],[241,2,480],[200,NaN,200],[200,0,200],[200,Infinity,200],[0,1,160]]) assert.equal(thumbPx(css!,dpr!),expected);
});

it('пропуски объясняют слишком большой и нечитаемый файл раздельно', () => {
  // Общая ошибка размера скрыла бы повреждённый файл от пользователя.
  assert.equal(skippedText([]),null);
  assert.equal(skippedText([{name:'big',reason:'too-big'},{name:'bad',reason:'unreadable'}]),'Больше 25 МБ — не отправить: big. Не удалось прочитать: bad');
  assert.equal(skippedText([{name:'a',reason:'unreadable'},{name:'b',reason:'unreadable'}]),'Не удалось прочитать: a, b');
});

it('запись останавливается ровно на мягком пределе с запасом для хвоста контейнера', () => {
  // Остановка только после лимита делает готовый контейнер слишком большим для сервера.
  assert.equal(recordingFull(VIDEO_SOFT_LIMIT-1),false); assert.equal(recordingFull(VIDEO_SOFT_LIMIT),true); assert.equal(recordingFull(VIDEO_SOFT_LIMIT+1),true);
  assert.equal(captureName('photo',new Date(2026,9,6,1,2,3),'jpg'),'photo-2026-10-06-01-02-03.jpg');
});

it('явный мягкий предел записи заменяет прежние 24 МиБ и срабатывает ровно на границе', () => {
  // ЛС допускают длинное видео, каналы сохраняют старый предел; нельзя игнорировать второй аргумент.
  const mib = 1024 * 1024;
  assert.equal(VIDEO_SOFT_LIMIT, 24 * mib);
  for (const limit of [mib, 1023 * mib]) {
    assert.equal(recordingFull(limit - 1, limit), false);
    assert.equal(recordingFull(limit, limit), true);
    assert.equal(recordingFull(limit + 1, limit), true);
  }
  assert.equal(recordingFull(VIDEO_SOFT_LIMIT, 1023 * mib), false, 'старый порог не режет запись для ЛС');
  assert.equal(recordingFull(VIDEO_SOFT_LIMIT - 1), false);
  assert.equal(recordingFull(VIDEO_SOFT_LIMIT), true);
  assert.equal(recordingFull(VIDEO_SOFT_LIMIT, undefined), true);
});

it('мягкий предел оставляет ровно 1 МиБ контейнеру и никогда не опускается ниже 1 МиБ', () => {
  const mib = 1024 * 1024;
  assert.equal(videoSoftLimit(), 24 * mib, 'без параметра остаётся прежний запас для канала');
  assert.equal(videoSoftLimit(25 * mib), 24 * mib);
  assert.equal(videoSoftLimit(1024 * mib), 1023 * mib, '1 ГиБ сервера не равен порогу записи');
  for (const max of [0, mib - 1, mib, 2 * mib - 1, 2 * mib]) {
    assert.equal(videoSoftLimit(max), mib, `нижний предел для ${max} байт`);
  }
  assert.equal(videoSoftLimit(2 * mib + 1), mib + 1, 'выше нижней границы вычитается ровно 1 МиБ');
});

it('контракт мягкого предела убивает игнорирование второго аргумента и потерю запаса контейнера', () => {
  const source = readFileSync(new URL('./attachRules.ts', import.meta.url), 'utf8');
  const mib = 1024 * 1024;
  const loadRules = (text: string) => {
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module: mod, exports: mod.exports, require: (id: string) => {
      if (id === '@gusvoice/shared') return { FEATURE_CONV10: 'conv10', FEATURE_BIGFILE1: 'bigfile1' };
      assert.equal(id, './convSyncRules');
      return { serverScheduledAttachments };
    } });
    return mod.exports as typeof import('./attachRules');
  };
  for (const [before, after, check] of [
    ['return bytes >= softLimit;', 'return bytes >= VIDEO_SOFT_LIMIT;', (rules: typeof import('./attachRules')) => assert.equal(rules.recordingFull(24 * mib, 1023 * mib), false)],
    ['max - 1024 * 1024', 'max', (rules: typeof import('./attachRules')) => assert.equal(rules.videoSoftLimit(1024 * mib), 1023 * mib)],
  ] as const) {
    assert.equal(source.split(before).length - 1, 1, 'мутация имеет единственную точку приложения');
    check(loadRules(source));
    assert.throws(() => check(loadRules(source.replace(before, after))), assert.AssertionError);
  }
});

it('подпись файла различает расширение и границы единиц размера', () => {
  // Имя без расширения и нулевой размер тоже встречаются у системного выбора.
  assert.deepEqual(fileBadge('REPORT.PDF'),{ext:'pdf',tone:'red'});
  assert.deepEqual(fileBadge('archive.zip'),{ext:'zip',tone:'honey'});
  assert.deepEqual(fileBadge('readme'),{ext:'файл',tone:'muted'});
  assert.deepEqual([0,1023,1024,1048576].map(fileSizeText),['0 Б','1023 Б','1,0 КБ','1,0 МБ']);
});

it('отложенные с вложениями доступны только по признаку сервера conv10', () => {
  // Наличие conv9 разрешает текстовое расписание, но не загрузку файлов к нему.
  assert.equal(serverScheduledAttachments(['conv10']), true, 'явный conv10 разрешает расписание с вложениями');
  assert.equal(serverScheduledAttachments(['conv10', 'conv9']), true, 'дополнительные возможности не отменяют conv10');
  assert.equal(serverScheduledAttachments(['conv9']), false, 'один conv9 не обещает поддержку вложений');
  assert.equal(serverScheduledAttachments([]), false, 'пустая capability-порция остаётся старым сервером');
  assert.equal(serverScheduledAttachments(undefined), false, 'отсутствующий список features безопасно запрещает вложения');
});
