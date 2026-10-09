import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  canGoNext, canGoPrev, clockLabel, composeAt, monthGrid, monthOf, monthTitle, parseTimeField,
  quickOptions, quotedText, schedStatus, sendLabel, settledTimeField, shiftMonth, stepTimeField, typedTimeField,
  initialPick, pickAt, schedShift, schedShiftText, schedHeadSub, schedDayLabel, schedOnlineLabel, schedSection,
  schedBubbleTime, schedFootLabel,
  SCHED_MAX_AHEAD_DAYS, SCHED_PAST_TEXT, SCHED_WEEKDAYS,
} from './schedRules.js';

const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => new Date(y, m, d, h, min, s, ms);
const same = (actual: unknown, expected: unknown, why: string) => assert.ok(Object.is(actual, expected), `${why}: ожидалось ${String(expected)}, получено ${String(actual)}`);

it('возврат к пересборке местных полей краснит оба осенних DST-контракта', () => {
  // Две найденные ошибки не должны снова спрятаться за корректными обычными датами.
  const raw = readFileSync(new URL('./schedRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const load = (source: string) => {
    const box = { exports: {}, Date };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, box);
    return box.exports as typeof import('./schedRules');
  };
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const contract = (r: typeof import('./schedRules')) => {
      assert.equal(r.quickOptions(new Date('2026-11-01T01:10:00-04:00'))[0].at.toISOString(), '2026-11-01T06:10:00.000Z');
      assert.equal(r.schedStatus(new Date('2026-11-01T01:20:00-04:00'), new Date('2026-11-01T01:10:40-05:00')), 'past');
      const now = new Date('2026-11-01T04:30:00.000Z');
      const start = r.initialPick(now, new Date('2026-11-01T06:30:45.000Z'));
      assert.equal(r.pickAt(start.day, start.h, start.m, now, start)?.toISOString(), '2026-11-01T06:30:00.000Z');
    };
    contract(load(raw));
    for (const [from, to] of [
      ['return new Date(roundTo(d.getTime(), step, true));', 'return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());'],
      ['roundTo(now.getTime(), 1, false)', 'new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime()'],
      ['if (start?.at && sameDay(day, start.day) && h === start.h && m === start.m) return new Date(start.at.getTime());',
        'if (start?.at && sameDay(day, start.day) && h === start.h && m === start.m) return composeAt(day, h, m, minuteStart(now));'],
    ]) {
      assert.ok(raw.includes(from), 'найден якорь отката DST');
      assert.throws(() => contract(load(raw.replace(from, to))), assert.AssertionError);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

describe('правила планирования отправки', () => {
  // Общие константы задают вид календаря и должны совпадать с серверным годовым лимитом.
  it('неделя начинается с понедельника, а предел равен 365 дням', () => {
    same(SCHED_WEEKDAYS.join(','), 'пн,вт,ср,чт,пт,сб,вс', 'календарная шапка совпадает с порядком сетки');
    same(SCHED_MAX_AHEAD_DAYS, 365, 'клиентский предел зеркалит серверный годовой лимит');
    same(SCHED_PAST_TEXT, 'Это время уже прошло', 'сообщение о прошлом выборе стабильно');
  });

  // Момент ровно на шаге и доля секунды после него — разные пользовательские случаи округления.
  it('быстрый выбор округляет к пяти минутам по следующему часу и ровно на границе минуты', () => {
    const exact = quickOptions(local(2026, 9, 5, 21, 10, 0, 0))[0];
    const after = quickOptions(local(2026, 9, 5, 21, 10, 0, 1))[0];
    same(exact.at.getHours(), 22, 'через час от точной минуты');
    same(exact.at.getMinutes(), 10, 'ровный шаг не перескакивает');
    same(after.at.getMinutes(), 15, 'миллисекунда после шага округляется вверх');
    same(exact.time, '22:10', 'время сегодня не получает лишний день недели');
  });

  // Переполнение часа и суток особенно легко ошибочно обработать арифметикой минут.
  it('быстрый час округляет секунды и переносит окончание часа через полночь', () => {
    const options = quickOptions(local(2026, 9, 5, 23, 30, 20));
    same(options[0].at.getDate(), 6, 'округление через полночь меняет календарный день');
    same(options[0].at.getHours(), 0, 'после полуночи час равен нулю');
    same(options[0].at.getMinutes(), 35, 'секунды после ровного шага требуют следующего шага');
    same(options[0].time, 'вт, 0:35', 'подпись за полночью включает местный день недели');
  });

  // Быстрые варианты должны оставаться календарными локальными часами при переходе года.
  it('варианты на завтра используют местные 9 и 19 часов даже на границе года', () => {
    const [soon, morning, evening] = quickOptions(local(2026, 11, 31, 23, 50));
    same(morning.at.getFullYear(), 2027, 'завтрашний календарный день переходит в новый год');
    same(morning.at.getMonth(), 0, 'завтра приходится на январь');
    same(morning.at.getHours(), 9, 'утренний вариант ровно в девять');
    same(evening.at.getHours(), 19, 'вечерний вариант ровно в девятнадцать');
    same(soon.id, 'soon', 'первым остаётся вариант через час');
    same(morning.time, 'пт, 9:00', 'день недели подписи учитывает новый год');
  });

  // Нормализация месяца обязана работать по обе стороны года, включая високосный февраль.
  it('сдвиг месяца и заголовок проходят декабрь—январь и високосный февраль', () => {
    const jan = shiftMonth({ y: 2026, m: 11 }, 1);
    same(`${jan.y}-${jan.m}`, '2027-0', 'переход через год нормализует месяц');
    const feb = shiftMonth({ y: 2024, m: 0 }, 1);
    same(monthTitle(feb), 'Февраль 2024', 'високосный год не меняет имя месяца');
    same(JSON.stringify(monthOf(local(2024, 1, 29))), '{"y":2024,"m":1}', '29 февраля относится к правильному месяцу');
    const dec = shiftMonth({ y: 2027, m: 0 }, -1);
    same(`${dec.y}-${dec.m}`, '2026-11', 'обратный сдвиг из января возвращает декабрь прошлого года');
  });

  // Пять недель — обычный минимум, шестая нужна только для календарей, не влезающих в этот минимум.
  it('месячная сетка имеет пять недель обычно и шесть только когда месяц не помещается', () => {
    same(monthGrid({ y: 2026, m: 9 }, local(2026, 9, 5), local(2026, 9, 5)).length, 35, 'октябрь 2026 помещается в пять недель');
    same(monthGrid({ y: 2026, m: 7 }, local(2026, 7, 1), local(2026, 7, 1)).length, 42, '31-дневный август с субботы требует шесть недель');
    const february2021 = monthGrid({ y: 2021, m: 1 }, local(2021, 1, 1), local(2021, 1, 1));
    same(february2021.length, 35, 'невисокосный февраль с понедельника помещается в пять недель');
    same(february2021.filter(cell => !cell.out).length, 28, 'невисокосный февраль содержит ровно 28 дней');
  });

  // Високосный день не должен теряться или сливаться с соседним мартовским числом.
  it('високосный февраль показывает 29 февраля ровно один раз, отдельно от первого марта', () => {
    const cells = monthGrid({ y: 2024, m: 1 }, local(2024, 1, 29), local(2024, 1, 1));
    const leapDay = cells.filter(cell => cell.date.getFullYear() === 2024 && cell.date.getMonth() === 1 && cell.date.getDate() === 29);
    const marchFirst = cells.filter(cell => cell.date.getFullYear() === 2024 && cell.date.getMonth() === 2 && cell.date.getDate() === 1);
    same(leapDay.length, 1, '29 февраля уникален в сетке');
    same(leapDay[0].out, false, '29 февраля принадлежит выбранному месяцу');
    same(leapDay[0].on, true, '29 февраля может быть выбранным днём');
    same(marchFirst.length, 1, 'первое марта остаётся отдельной соседней ячейкой');
  });

  // Порядок и оформление серых соседних дней влияют на выбор и доступность календаря.
  it('ячейки сетки идут с понедельника и серые соседние дни не помечаются текущими или выбранными', () => {
    const grid = monthGrid({ y: 2026, m: 9 }, local(2026, 9, 1), local(2026, 9, 5));
    same(grid[0].date.getDay(), 1, 'первая ячейка календарной недели — понедельник');
    same(grid[0].out, true, 'перед первым октября отображается серый соседний день');
    same(grid[0].today || grid[0].on, false, 'соседняя ячейка не подсвечивается как сегодня или выбор');
    same(grid.find(cell => cell.n === 5 && !cell.out)?.aria, '5 октября, сегодня', 'сегодня доступно в подписи для читалки');
  });

  // Вчера нельзя выбрать, но сегодняшняя дата остаётся доступной весь день.
  it('прошедший день и сегодняшний день получают ожидаемый статус доступности', () => {
    const grid = monthGrid({ y: 2026, m: 9 }, local(2026, 9, 5), local(2026, 9, 5, 12));
    same(grid.find(cell => cell.n === 4 && !cell.out)?.disabled, true, 'вчерашний день недоступен');
    same(grid.find(cell => cell.n === 5 && !cell.out)?.disabled, false, 'сегодняшний день доступен для выбора');
  });

  // Лимит должен включать последний разрешённый календарный день и исключать день за ним.
  it('граница календаря включает сегодня плюс 364 дня, но исключает следующий день', () => {
    const now = local(2026, 0, 1, 18, 30);
    const limit = local(2026, 11, 31);
    const next = local(2027, 0, 1);
    same(SCHED_MAX_AHEAD_DAYS - 1, 364, 'последний календарный день выбирается с запасом к любому времени суток');
    same(canGoNext({ y: 2026, m: 10 }, now), true, 'из ноября можно перейти в месяц последнего разрешённого дня');
    same(canGoNext({ y: 2026, m: 11 }, now), false, 'из месяца последнего разрешённого дня следующий месяц недоступен');
    const grid = monthGrid({ y: 2026, m: 11 }, limit, now);
    same(grid.find(cell => cell.date.getTime() === limit.getTime())?.disabled, false, 'ровно день +364 ещё выбирается');
    same(monthGrid({ y: 2027, m: 0 }, next, now).find(cell => cell.date.getTime() === next.getTime())?.disabled, true, 'день +365 уже недоступен');
  });

  // Навигация не должна увести календарь за нижнюю или верхнюю допустимую границу.
  it('навигация назад останавливается на текущем месяце, вперёд — на границе разрешённого месяца', () => {
    const now = local(2026, 9, 5);
    same(canGoPrev({ y: 2026, m: 8 }, now), false, 'предыдущий месяц не доступен для навигации назад');
    same(canGoPrev({ y: 2026, m: 9 }, now), false, 'текущий месяц — край назад');
    same(canGoPrev({ y: 2026, m: 10 }, now), true, 'из будущего месяца можно вернуться назад');
    same(canGoNext({ y: 2026, m: 9 }, now), true, 'из текущего месяца можно перейти вперёд');
  });

  // Новое окно должно предлагать понятное будущее значение, а не уже прошедший момент.
  it('начальный выбор использует завтра в 9 утра, если сохранённое время пустое', () => {
    const picked = initialPick(local(2026, 9, 5, 21, 8));
    same(picked.day.getDate(), 6, 'по умолчанию выбирается завтра');
    same(`${picked.h}:${picked.m}`, '9:0', 'по умолчанию выбирается 9:00');
  });

  // Перенос существующей отложенной даты допустим до границы текущей минуты и до последнего дня года.
  it('начальный выбор сохраняет корректное время в текущей минуте и на последнем дне', () => {
    const now = local(2026, 0, 1, 10, 15, 40);
    const sameMinute = initialPick(now, local(2026, 0, 1, 10, 15));
    same(`${sameMinute.day.getDate()}-${sameMinute.h}:${sameMinute.m}`, '1-10:15', 'время начала текущей минуты не считается прошедшим');
    const lastAllowed = initialPick(now, local(2026, 11, 31, 23, 59));
    same(`${lastAllowed.day.getMonth()}-${lastAllowed.day.getDate()}`, '11-31', 'день +364 принимается как крайний');
  });

  // Старое, повреждённое или слишком дальнее значение не должно блокировать повторное планирование.
  it('начальный выбор отвергает прошлое, недействительную дату и дату за годовым пределом', () => {
    const now = local(2026, 0, 1, 10, 15, 40);
    const fallback = initialPick(now);
    for (const bad of [local(2026, 0, 1, 10, 14), new Date(Number.NaN), local(2027, 0, 1)]) {
      const result = initialPick(now, bad);
      same(result.day.getTime(), fallback.day.getTime(), 'непригодная дата возвращает завтра');
      same(result.h, fallback.h, 'непригодная дата возвращает утренний час');
    }
  });

  // Составление времени должно использовать местные поля календаря, а не UTC или секунды исходной даты.
  it('составление даты использует местные календарные поля и сбрасывает секунды', () => {
    const at = composeAt(local(2026, 2, 8), 9, 7);
    same(`${at.getFullYear()}-${at.getMonth()}-${at.getDate()} ${at.getHours()}:${at.getMinutes()}:${at.getSeconds()}`, '2026-2-8 9:7:0', 'дата собрана по местному календарю');
  });

  // Ровно одна миллисекунда по разные стороны границы выявляет ошибки строгого сравнения.
  it('границу начала минуты проверяет с точностью до миллисекунды', () => {
    const now = local(2026, 9, 5, 21, 8, 40, 1);
    same(schedStatus(local(2026, 9, 5, 21, 7, 59, 999), now), 'past', 'за миллисекунду до начала минуты выбор уже прошёл');
    same(schedStatus(local(2026, 9, 5, 21, 8, 0, 0), now), 'ok', 'ровно начало минуты остаётся допустимым');
    same(schedStatus(local(2026, 9, 5, 21, 8, 0, 1), now), 'ok', 'миллисекунда после начала минуты также допустима');
  });

  // Сервер допускает текущую минуту, чтобы медленный клик не превратился в отказ.
  it('время в эту минуту ещё разрешено, а время до начала текущей минуты уже прошло', () => {
    const now = local(2026, 9, 5, 21, 8, 40);
    same(schedStatus(local(2026, 9, 5, 21, 8), now), 'ok', 'начало текущей минуты ещё принимается');
    same(schedStatus(local(2026, 9, 5, 21, 7, 59), now), 'past', 'предыдущая минута уже прошла');
  });

  // Очищенное поле — это незавершённый ввод, а не обвинение в выборе прошедшего времени.
  it('пустая и недействительная дата дают invalid, а точная граница минуты — ok', () => {
    const now = local(2026, 9, 5, 21, 8, 0);
    same(schedStatus(null, now), 'invalid', 'пустое поле не обвиняет пользователя в прошлом времени');
    same(schedStatus(new Date(Number.NaN), now), 'invalid', 'NaN-дата не проходит как отправляемая');
    same(schedStatus(local(2026, 9, 5, 21, 8), now), 'ok', 'ровно начало минуты разрешено');
  });

  // Подпись должна объяснить пользователю точное локальное действие и год при дальнем выборе.
  it('подпись отправки различает сегодня, завтра, другой день и другой год', () => {
    const now = local(2026, 9, 5, 12);
    same(sendLabel(local(2026, 9, 5, 21, 30), now), 'Отправить сегодня в 21:30', 'сегодня получает короткую подпись');
    same(sendLabel(local(2026, 9, 6, 9), now), 'Отправить завтра в 9:00', 'завтра получает относительную подпись');
    same(sendLabel(local(2026, 9, 8, 19, 30), now), 'Отправить в чт, 8 октября, в 19:30', 'день того же года указывается явно');
    same(sendLabel(local(2027, 0, 8, 9), now), 'Отправить в пт, 8 января 2027, в 9:00', 'другой год включается в подпись');
    same(sendLabel(null, now), 'Отправить', 'без выбранного времени текст остаётся нейтральным');
    same(sendLabel(new Date(Number.NaN), now), 'Отправить', 'недействительная дата также не показывает NaN');
  });

  // Формат часов одинаково читается для ночи и целого часа.
  it('часы показываются без ведущего нуля, минуты всегда из двух цифр', () => {
    same(clockLabel(local(2026, 0, 1, 0, 5)), '0:05', 'ночные часы не дополняются нулём');
    same(clockLabel(local(2026, 0, 1, 9, 0)), '9:00', 'ровный час сохраняет две цифры минут');
  });

  // Верхние границы включительны, но одна цифра за пределом или нецифровой ввод недопустимы.
  it('разбор поля принимает ноль и верхнюю границу, но отклоняет ввод вне диапазона', () => {
    same(parseTimeField('0', 23), 0, 'ноль часов — корректный ввод');
    same(parseTimeField('23', 23), 23, 'верхняя граница часов включительна');
    same(parseTimeField('59', 59), 59, 'верхняя граница минут включительна');
    same(parseTimeField('24', 23), null, '24 часа превышает границу часов');
    for (const input of ['', '60', '123', '1a', '-1', ' 1']) {
      same(parseTimeField(input, 59), null, `недопустимый ввод ${JSON.stringify(input)} не считается временем`);
    }
  });

  // Поле при наборе должно переживать вставку текста и ограничивать слишком большие значения.
  it('набор оставляет только две цифры и прижимает число к пределу поля', () => {
    same(typedTimeField('a7', 59), '7', 'буквы не попадают в отправляемое время');
    same(typedTimeField('123', 59), '12', 'поле не принимает больше двух цифр');
    same(typedTimeField('75', 59), '59', 'минуты выше границы прижимаются к 59');
    same(typedTimeField('', 59), '', 'пустое поле остаётся пустым до потери фокуса');
  });

  // После ухода фокуса поля нормализуются и не остаются пустыми.
  it('потеря фокуса дополняет нулями и пустое поле превращает в 00', () => {
    same(settledTimeField('7', 23), '07', 'одна цифра часов становится двухзначной');
    same(settledTimeField('', 59), '00', 'очищенное поле после ухода курсора становится нулём');
    same(settledTimeField('99', 23), '23', 'предел применяется до форматирования');
  });

  // Стрелки меняют только выбранное поле и зацикливаются на его локальной границе.
  it('стрелки переходят по кругу с границы, не переносясь в соседнее поле', () => {
    same(stepTimeField('23', 1, 23), '00', 'вверх от последнего часа возвращает 00');
    same(stepTimeField('00', -1, 23), '23', 'вниз от нуля возвращает последний час');
    same(stepTimeField('59', 1, 59), '00', 'минуты зациклены отдельно от часа');
    same(stepTimeField('', -1, 59), '59', 'пустое поле при шаге считается нулём');
  });

  // Цитата не должна раздувать карточку из-за форматирования исходного сообщения.
  it('цитата сжимает пробелы и переносы, а пустой текст остаётся пустым', () => {
    same(quotedText('  привет\n   мир  '), '«привет мир»', 'переносы и пробелы схлопываются перед цитированием');
    same(quotedText(' \n  '), '', 'пустое после очистки сообщение не получает пустые кавычки');
  });

  // Обрезка на точной границе отличается от превышения всего на один символ.
  it('длинная цитата обрезается до заданного лимита с многоточием', () => {
    same(quotedText('abcdefghij', 6), '«abcde…»', 'пять символов и многоточие укладываются в лимит шесть');
    same(quotedText('коротко', 10), '«коротко»', 'короткая цитата не обрезается');
    same(quotedText('abcdef', 6), '«abcdef»', 'текст ровно на пределе не обрезается');
    same(quotedText('abcdefg', 6), '«abcde…»', 'один символ сверх предела запускает обрезку');
  });

  // UTC, зоны с четверть/получасовыми смещениями и сезонные зоны проверяют локальность без привязки к машине разработчика.
  it('быстрые часы и календарные дни сохраняют местную семантику в разных поясах', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Europe/Moscow', 'Australia/Lord_Howe', 'America/New_York']) {
        process.env.TZ = zone;
        const now = local(2026, 5, 10, 12, 34, 20);
        const [soon, morning] = quickOptions(now);
        same(`${morning.at.getDate()} ${morning.at.getHours()}`, '11 9', `${zone}: завтра утром остаётся местными 9:00`);
        same(soon.at.getTime() - now.getTime() >= 60 * 60 * 1000, true, `${zone}: быстрый вариант не раньше чем через 60 минут`);
        same(soon.at.getTime() - now.getTime() < 65 * 60 * 1000, true, `${zone}: округление добавляет меньше пяти минут сверх часа`);
      }
      process.env.TZ = 'America/New_York';
      const beforeSpring = local(2026, 2, 7, 12);
      const tomorrow = quickOptions(beforeSpring)[1].at;
      same(`${tomorrow.getDate()} ${tomorrow.getHours()}`, '8 9', 'завтра утром остаётся 9:00 через переход на летнее время');
      same(tomorrow.getTime() - beforeSpring.getTime(), 20 * 60 * 60 * 1000, 'весенняя DST-ночь сокращает интервал до завтрашних 9 утра');
      const acrossDst = monthGrid({ y: 2026, m: 2 }, local(2026, 2, 8), beforeSpring);
      same(acrossDst.find(cell => cell.date.getDate() === 8 && !cell.out)?.date.getHours(), 0, 'календарная ячейка после смены часов остаётся местной полуночью');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // Повторяющийся час случается дважды; вычисления должны хранить реальный instant, а не пересобирать только циферблат.
  it('осенний повторяющийся час округляется в каждом проходе и не принимает прошлое за будущее', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const firstPass = new Date('2026-11-01T05:10:00.000Z');
      const secondPass = new Date('2026-11-01T06:10:00.000Z');
      same(quickOptions(firstPass)[0].at.toISOString(), '2026-11-01T06:10:00.000Z', 'из первого прохода через час приходит второй проход тех же 1:10');
      same(quickOptions(firstPass)[0].time, '1:10', 'первый проход показывает повторяющееся местное время');
      same(quickOptions(secondPass)[0].at.toISOString(), '2026-11-01T07:10:00.000Z', 'из второго прохода через час приходит 2:10 второго прохода');
      same(quickOptions(secondPass)[0].time, '2:10', 'подпись различает второй проход по фактическому местному времени');
      same(schedStatus(new Date('2026-11-01T05:50:00.000Z'), new Date('2026-11-01T06:20:00.000Z')), 'past', 'раннее повторение 1:50 уже прошло в абсолютном времени');
      const day = new Date(2026, 10, 1);
      same(composeAt(day, 1, 20, Date.parse('2026-11-01T06:10:00.000Z')).toISOString(), '2026-11-01T06:20:00.000Z', 'notBefore выбирает будущий проход циферблата 1:20');
      const now = new Date('2026-11-01T06:10:00.000Z');
      same(pickAt(day, 1, 20, now)?.toISOString(), '2026-11-01T06:20:00.000Z', 'изменённое поле 1:20 выбирает второй будущий проход');
      const initial = new Date('2026-11-01T06:20:37.000Z');
      const start = initialPick(now, initial);
      same(start.at?.toISOString(), '2026-11-01T06:20:00.000Z', 'перенос времени сохраняет минуту второго прохода');
      same(pickAt(start.day, start.h, start.m, now, start)?.toISOString(), '2026-11-01T06:20:00.000Z', 'нетронутые поля отправляют исходный повторный проход');
      const secondFoldNow = new Date('2026-11-01T04:30:00.000Z');
      const secondFoldInitial = new Date('2026-11-01T06:30:45.000Z');
      const secondFoldStart = initialPick(secondFoldNow, secondFoldInitial);
      same(pickAt(secondFoldStart.day, secondFoldStart.h, secondFoldStart.m, secondFoldNow, secondFoldStart)?.toISOString(),
        '2026-11-01T06:30:00.000Z', 'перенос из второго прохода без изменения полей остаётся в 06:30Z, не пересобирается в 05:30Z');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // Весной некоторых настенных минут не существует; интерфейс обязан назвать и отправить фактическую минуту.
  it('весенний пропуск часа сообщает подмену набранного времени фактическим', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const day = new Date(2026, 2, 8);
      const at = composeAt(day, 2, 30);
      same(at.toISOString(), '2026-03-08T07:30:00.000Z', 'несуществующие 2:30 нормализуются в 3:30 EDT');
      assert.deepEqual(schedShift(day, 2, 30, at), { from: '2:30', to: '3:30' }, 'правило отличает набранный час от реально отправляемого');
      same(schedShiftText({ from: '2:30', to: '3:30' }), 'Часы переводятся: 2:30 нет, будет 3:30', 'текст объясняет пропущенный час');
      same(schedShift(day, 3, 30, at), null, 'реально существующее время не показывает предупреждение');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // У Лорд-Хау перевод на полчаса, у Катманду смещение +5:45; обе зоны ломают допущение о целых часах.
  it('получасовой DST Лорд-Хау и пояс Катманду сохраняют округление реального времени', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'Australia/Lord_Howe';
      const springDay = new Date(2026, 9, 4);
      const missing = composeAt(springDay, 2, 15);
      assert.deepEqual(schedShift(springDay, 2, 15, missing), { from: '2:15', to: '2:45' }, 'получасовой скачок сдвигает несуществующие 2:15 к 2:45');
      const first = new Date('2026-04-04T14:40:00.000Z');
      same(quickOptions(first)[0].at.toISOString(), '2026-04-04T15:40:00.000Z', 'осенний 30-минутный повтор не схлопывает часовой переход');
      process.env.TZ = 'Asia/Kathmandu';
      const now = new Date('2026-06-10T06:49:20.000Z');
      const soon = quickOptions(now)[0].at;
      same(soon.toISOString(), '2026-06-10T07:50:00.000Z', '+5:45 пояс округляет локальное 12:49:20 до 13:35 после часа');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // Счёт, секции и подписи должны совпадать между заголовком, пузырём и меню для всех временных режимов.
  it('правила вида склоняют счёт и согласуют дневные, онлайн, пузырь и подвал', () => {
    same(schedHeadSub('Аня', 1), 'Аня · 1 сообщение', 'единица требует единственного числа');
    same(schedHeadSub('Аня', 2), 'Аня · 2 сообщения', 'два требуют формы сообщения');
    same(schedHeadSub('Аня', 5), 'Аня · 5 сообщений', 'пять требует родительного множественного');
    same(schedHeadSub('Аня', 11), 'Аня · 11 сообщений', 'исключение 11–14 не склоняется как единицы');
    same(schedHeadSub('Аня', 21), 'Аня · 21 сообщение', '21 возвращается к форме единицы');
    const now = new Date(2026, 9, 5, 12);
    const tomorrow = new Date(2026, 9, 6, 9);
    const today = { sendAt: now.toISOString(), whenOnline: false };
    const nextDay = { sendAt: tomorrow.toISOString(), whenOnline: false };
    same(schedDayLabel(now, now), 'Сегодня, 5 октября', 'сегодняшняя пилюля содержит дату');
    same(schedDayLabel(tomorrow, now), 'Завтра, 6 октября', 'завтрашняя пилюля содержит дату');
    same(schedSection(nextDay, 'Борис', now).label, 'Завтра, 6 октября', 'дневная запись попадает в читаемую календарную секцию');
    same(schedSection({ sendAt: null, whenOnline: true }, 'Борис', now).key, 'online', 'режим появления собеседника имеет отдельный раздел');
    assert.deepEqual(schedSection({ sendAt: null, whenOnline: false }, 'Борис', now), { key: 'online', label: 'Когда Борис будет в сети' }, 'без sendAt запись безопасно относится к онлайн-разделу, а не к выдуманной дате');
    same(schedOnlineLabel('Борис'), 'Когда Борис будет в сети', 'онлайн-пилюля называет собеседника');
    same(schedBubbleTime(nextDay), '9:00', 'пузырь показывает время отправки без лишнего текста');
    same(schedBubbleTime({ sendAt: null, whenOnline: true }), '', 'отправка при появлении онлайн не притворяется временем');
    same(schedFootLabel(nextDay, 'Борис', now), 'Будет отправлено завтра в 9:00', 'подвал меню совпадает по времени с выбором');
    same(schedFootLabel({ sendAt: null, whenOnline: true }, 'Борис', now), 'Будет отправлено, когда Борис будет в сети', 'подвал онлайн-режима ясен');
    same(schedFootLabel({ sendAt: 'invalid', whenOnline: false }, 'Борис', now), '', 'повреждённое время не отображается как дата');
  });

  // Недоступные даты в интерфейсе объясняют себя, а не теряют запись из вида.
  it('дневная подпись умеет другой день и следующий год', () => {
    const now = new Date(2026, 9, 5, 12);
    same(schedDayLabel(new Date(2026, 9, 8), now), '8 октября', 'день этого года не повторяет год');
    same(schedDayLabel(new Date(2027, 0, 8), now), '8 января 2027', 'день другого года указывает год');
  });

  // Время истекло в списке до обработки сервером, а failed — окончательный отказ с двумя разными действиями.
  it('подвал показывает «отправляется» после времени и объясняет оба вида отказа', () => {
    const now = new Date(2026, 9, 5, 12);
    assert.ok(schedFootLabel({ sendAt: new Date(2026, 9, 5, 11, 59).toISOString(), whenOnline: false }, 'Аня', now).startsWith('Отправляется'), 'просроченная запись ждёт обработки, а не обещает будущее');
    same(schedFootLabel({ sendAt: null, whenOnline: false, failed: { reason: 'peer-gone' } }, 'Аня', now), 'Не отправлено: собеседник удалил аккаунт', 'удалённый собеседник даёт точную причину');
    same(schedFootLabel({ sendAt: null, whenOnline: false, failed: { reason: 'error' } }, 'Аня', now), 'Не отправлено — отправьте сейчас или перенесите', 'обычный отказ предлагает восстановление');
    const boundaryNow = new Date(2026, 9, 5, 12, 0, 30);
    same(schedFootLabel({ sendAt: new Date(2026, 9, 5, 12, 0, 0).toISOString(), whenOnline: false }, 'Аня', boundaryNow),
      'Будет отправлено сегодня в 12:00', 'ровно начало текущей минуты ещё не считается отправляющимся');
    same(schedFootLabel({ sendAt: new Date(2026, 9, 5, 11, 59, 59, 999).toISOString(), whenOnline: false }, 'Аня', boundaryNow),
      'Отправляется…', 'одна миллисекунда до границы уже считается начавшейся отправкой');
  });

});
