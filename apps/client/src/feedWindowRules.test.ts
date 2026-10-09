import assert from 'node:assert/strict';
import { firstOfDay } from './feedWindowRules';
import { describe, it } from 'node:test';
it('переход к дате выбирает первое сообщение дня, за концом — последнее, пустая лента — null', () => {
  // Ловит потерю перехода по дню без сообщений и включённости полуночи.
  const at = new Date(2026, 9, 7);
  const list = [{ id: 'before', createdAt: new Date(2026, 9, 6, 23, 59).toISOString() },
    { id: 'midnight', createdAt: at.toISOString() }, { id: 'later', createdAt: new Date(2026, 9, 8).toISOString() }];
  assert.equal(firstOfDay(list, at), 'midnight');
  assert.equal(firstOfDay(list, new Date(2026, 9, 9)), 'later');
  assert.equal(firstOfDay(list, new Date(2026, 9, 5)), 'before');
  assert.equal(firstOfDay([], at), null);
});
import { readFileSync } from 'node:fs';
import { unreadCountAfter } from './feedWindowRules';

it('счётчик под чертой берёт лишь чужие ключи строго после прочитанного, без метки — ноль', () => {
  // Свои сообщения и незнакомый ключ не должны превращаться в новые непрочитанные.
  const list = [{ sortKey: 5, author: { id: 'peer' } }, { sortKey: 6, author: { id: 'peer' } }, { sortKey: 7, author: { id: 'me' } }, { author: { id: 'peer' } }];
  assert.equal(unreadCountAfter(list, 'me', 5), 1);
  assert.equal(unreadCountAfter(list, 'me', 6), 0);
  assert.equal(unreadCountAfter(list, 'me', null), 0);
  assert.equal(unreadCountAfter(list, 'me', undefined), 0);
  assert.equal(unreadCountAfter([], 'me', 0), 0);
});
import { afterKeyCursor, anchorIndex, anchorShift, firstUnreadIndex, jumpReturn, openAction, popJump, pushJump, trimPlan } from './feedWindowRules';

describe('место открытия окна беседы', () => {
  const win = { stale: false, atTail: true, firstKey: 10, hasMoreBefore: true, hasPlace: true };
  const base = { unread: 0, lastReadKey: 10, place: null, live: true, window: win };
  it('живой хвост без непрочитанного не требует запроса', () => {
    assert.deepEqual(openAction(base), { fetch: 'none' });
    assert.deepEqual(openAction({ ...base, window: { ...win, atTail: false } }), { fetch: 'latest' });
  });
  it('кеш и потерянный шлюз не считаются свежим окном', () => {
    for (const p of [{ ...base, live: false }, { ...base, window: { ...win, stale: true } }, { ...base, window: null }]) {
      assert.deepEqual(openAction(p), { fetch: 'latest' });
    }
  });
  it('непрочитанное важнее места, равный прочитанному край ещё покрывает черту', () => {
    const p = { ...base, unread: 1, place: { messageId: 'place', offset: -9 } };
    assert.deepEqual(openAction(p), { fetch: 'none' });
    assert.deepEqual(openAction({ ...p, window: { ...win, firstKey: 11 } }), { fetch: 'after', key: 10 });
    assert.deepEqual(openAction({ ...p, window: { ...win, atTail: false } }), { fetch: 'after', key: 10 });
  });
  it('начало всей истории покрывает черту даже при пустой порции', () => {
    assert.deepEqual(openAction({ ...base, unread: 1, window: { ...win, firstKey: null, hasMoreBefore: false } }), { fetch: 'none' });
    assert.deepEqual(openAction({ ...base, unread: 1, window: { ...win, firstKey: null } }), { fetch: 'after', key: 10 });
  });
  it('место в свежем окне сохраняется, отсутствующее или устаревшее запрашивается вокруг', () => {
    const p = { ...base, place: { messageId: 'place', offset: -9 } };
    assert.deepEqual(openAction(p), { fetch: 'none' });
    for (const window of [{ ...win, hasPlace: false }, { ...win, stale: true }]) {
      assert.deepEqual(openAction({ ...p, window }), { fetch: 'around', messageId: 'place' });
    }
  });
  it('курсор после ключа не округляется вверх и не бывает отрицательным', () => {
    assert.equal(afterKeyCursor(0), '0_0'); assert.equal(afterKeyCursor(10.9), '10_0');
    assert.equal(afterKeyCursor(-1), '0_0'); assert.equal(afterKeyCursor(Number.MAX_SAFE_INTEGER), `${Number.MAX_SAFE_INTEGER}_0`);
  });
  it('ровно 300 строк не обрезается, 301 режет дальний край с обеих сторон', () => {
    assert.equal(trimPlan(300, 'older'), null);
    assert.deepEqual(trimPlan(301, 'older'), { side: 'bottom', count: 1 });
    assert.deepEqual(trimPlan(301, 'newer'), { side: 'top', count: 1 });
    assert.deepEqual(trimPlan(8, 'newer', 5), { side: 'top', count: 3 });
  });
});
describe('якорь, возврат и черта непрочитанного', () => {
  it('возврат в пределах одного пикселя считается достигнутым с любой стороны', () => {
    // Геометрия дробная на масштабировании; порог включительный, иначе плашка «Назад» дрожит на границе.
    const place = { messageId: 'quote', offset: 24 };
    assert.deepEqual(jumpReturn(24, place, null), { reached: true, side: null }, 'ровно на сохранённом отступе возврат достигнут');
    assert.deepEqual(jumpReturn(23, place, -1), { reached: true, side: -1 }, 'нижняя граница ±1 px включена');
    assert.deepEqual(jumpReturn(25, place, 1), { reached: true, side: 1 }, 'верхняя граница ±1 px включена');
    assert.deepEqual(jumpReturn(23, place, null), { reached: true, side: null }, 'на точной границе неизвестная сторона тоже достигнута');
    assert.deepEqual(jumpReturn(25, place, null), { reached: true, side: null }, 'обе стороны точной границы симметричны');
    assert.deepEqual(jumpReturn(22, place, -1), { reached: false, side: -1 }, 'при -2 px та же сторона не означает достижение');
    assert.deepEqual(jumpReturn(22, place, 1), { reached: true, side: -1 }, 'при -2 px пересечение в обратную сторону достигнуто');
    assert.deepEqual(jumpReturn(26, place, -1), { reached: true, side: 1 }, 'при +2 px пересечение в обратную сторону достигнуто');
    assert.deepEqual(jumpReturn(26, place, 1), { reached: false, side: 1 }, 'та же сторона при +2 px не считается пересечением');
    assert.deepEqual(jumpReturn(25.01, place, 1), { reached: false, side: 1 }, 'за верхней границей ещё не вернулись');
    assert.deepEqual(jumpReturn(22.99, place, -1), { reached: false, side: -1 }, 'за нижней границей ещё не вернулись');
  });
  it('неизвестная исходная сторона не считается пересечением, но запоминается', () => {
    // При первом замере строки в ленте мы не знаем, пересёк ли её человек до монтирования окна.
    assert.deepEqual(jumpReturn(-20, { messageId: 'quote', offset: 0 }, null),
      { reached: false, side: -1 }, 'первый замер только запоминает сторону');
    assert.deepEqual(jumpReturn(20, { messageId: 'quote', offset: 0 }, null),
      { reached: false, side: 1 }, 'неизвестная сторона симметрична сверху и снизу');
  });
  it('место возврата снимается при пересечении в обоих направлениях', () => {
    // Окно можно открыть по цитате выше или ниже текущего экрана; обе траектории обязаны очистить стек.
    const place = { messageId: 'quote', offset: 0 };
    assert.deepEqual(jumpReturn(2, place, -1), { reached: true, side: 1 }, 'снизу вверх через отступ');
    assert.deepEqual(jumpReturn(-2, place, 1), { reached: true, side: -1 }, 'сверху вниз через отступ');
  });
  it('обработчик прокрутки удаляет достигнутые места только внутри окна feedWindow', () => {
    // Без feedWindow нельзя применять геометрию сохранённых мест к обычной ленте/другому режиму списка.
    const source = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
    const dropIndex = source.indexOf('dropReachedJumps();');
    const actualStart = source.lastIndexOf('onScroll={(e) => {', dropIndex);
    assert.ok(actualStart >= 0, 'найден настоящий onScroll списка в MessagePane');
    const onScrollEnd = source.indexOf('\n          }}', actualStart);
    assert.ok(onScrollEnd > actualStart, 'найдена граница настоящего обработчика onScroll');
    const onScroll = source.slice(actualStart, onScrollEnd);
    const fwIf = onScroll.indexOf('if (fw) {');
    assert.ok(fwIf >= 0, 'onScroll проверяет наличие окна перед работой с его местами');
    const braceStart = onScroll.indexOf('{', fwIf);
    let depth = 0, braceEnd = -1;
    for (let i = braceStart; i < onScroll.length; i++) {
      if (onScroll[i] === '{') depth++;
      if (onScroll[i] === '}' && --depth === 0) { braceEnd = i; break; }
    }
    assert.ok(braceEnd > braceStart, 'ветка if (fw) извлечена целиком по парным скобкам');
    assert.match(onScroll.slice(fwIf, braceEnd + 1), /dropReachedJumps\(\);/,
      'dropReachedJumps находится внутри конкретной ветки if (fw)');
  });
  it('пустая лента и полностью скрытые строки не дают якоря, равная кромка пропускается', () => {
    assert.equal(anchorIndex(0, () => { throw new Error('пусто'); }, 0), -1);
    const bottoms = [-10, 0, 10, 20];
    assert.equal(anchorIndex(4, (i) => bottoms[i], 0), 2);
    assert.equal(anchorIndex(4, (i) => bottoms[i], 20), -1);
    assert.equal(anchorIndex(4, (i) => bottoms[i], -11), 0);
  });
  it('двоичный поиск не измеряет всю длинную ленту, сдвиг учитывает отрицательный отступ', () => {
    let calls = 0;
    assert.equal(anchorIndex(300, (i) => { calls++; return i * 10; }, 1234), 124);
    assert.ok(calls <= 9);
    assert.equal(anchorShift({ messageId: 'x', offset: -5 }, 95, 100), 0);
    assert.equal(anchorShift({ messageId: 'x', offset: -5 }, 115, 100), 20);
  });
  it('стек удерживает ровно 20 последних мест и не меняет исходный массив', () => {
    const original = Array.from({ length: 20 }, (_, i) => ({ messageId: String(i), offset: -i }));
    const next = pushJump(original, { messageId: '20', offset: -20 });
    assert.equal(next.length, 20); assert.equal(next[0].messageId, '1'); assert.equal(original[0].messageId, '0');
    assert.deepEqual(popJump(next), { place: next[19], stack: next.slice(0, -1) });
    assert.deepEqual(popJump([]), { place: null, stack: [] });
  });
  it('черта сравнивает ключ строго и пропускает свои сообщения и строки без ключа', () => {
    const list = [{ author: { id: 'peer' } }, { sortKey: 10, author: { id: 'peer' } },
      { sortKey: 11, author: { id: 'me' } }, { sortKey: 12, author: { id: 'peer' } }];
    assert.equal(firstUnreadIndex(list, 'me', 10), 3);
    assert.equal(firstUnreadIndex(list, 'me', 12), -1);
    assert.equal(firstUnreadIndex(list, 'me', null), -1);
    assert.equal(firstUnreadIndex([], 'me', 0), -1);
  });
});
