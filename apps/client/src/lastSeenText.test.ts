import assert from 'node:assert/strict';
import { it } from 'node:test';
import { lastSeenLabel, lastSeenNextChangeMs, readAtLabel, serverLastSeen } from './lastSeenText';
const now = new Date(2026, 9, 7, 20, 0, 0);
const status = (at: Date) => ({ online: false, at: at.toISOString(), approx: null });
it('минуты склоняются, двенадцать часов переключают на сегодня, профиль всегда показывает полную дату', () => {
  // Ловит неправильные русские формы и смешение краткой шапки с полным профилем.
  for (const [n, label] of [[1, 'минуту'], [3, 'минуты'], [5, 'минут'], [21, 'минуту'], [59, 'минут']] as const) {
    assert.equal(lastSeenLabel(status(new Date(now.getTime()-n*60000)), now), `был(а) ${n} ${label} назад`);
  }
  assert.equal(lastSeenLabel(status(new Date(now.getTime()-12*3600000+1)), now), 'был(а) 11 часов назад');
  assert.equal(lastSeenLabel(status(new Date(2026, 9, 7, 8)), now), 'был(а) сегодня в 08:00');
  assert.equal(lastSeenLabel(status(new Date(2026, 9, 6, 8)), now), 'был(а) вчера в 08:00');
  assert.equal(lastSeenLabel(status(new Date(2026, 8, 5, 12, 34)), now, true), 'был(а) 05.09.26 в 12:34');
  assert.equal(lastSeenLabel({ online: false, at: 'bad', approx: null }, now), 'был(а) давно');
  assert.equal(lastSeenLabel({ online: true, at: null, approx: null }, now), 'в сети');
});
it('следующая смена привязана к границе минуты, часа и полуночи, неизвестное время не заводит таймер', () => {
  // Ловит обновление строки через полный интервал вместо ближайшей границы.
  assert.equal(lastSeenNextChangeMs(status(new Date(now.getTime()-59000)), now), 1000);
  assert.equal(lastSeenNextChangeMs(status(new Date(now.getTime()-3599000)), now), 1000);
  assert.equal(lastSeenNextChangeMs(status(new Date(now.getTime()-7199000)), now), 1000);
  assert.equal(lastSeenNextChangeMs(status(new Date(2026, 9, 6)), now), 4*3600000);
  assert.equal(lastSeenNextChangeMs({ online: true, at: now.toISOString() }, now), null);
  assert.equal(lastSeenNextChangeMs({ online: false, at: 'bad' }, now), null);
  assert.equal(serverLastSeen(['lastseen1']), true); assert.equal(serverLastSeen(null), false);
});
it('прочтение различает сегодня, вчера, старый месяц и скрытое время, непрочитанное не рисует строку', () => {
  // Ловит раскрытие скрытого времени и неверную календарную подпись в меню сообщения.
  const view = (at: Date) => ({ read: true, at: at.toISOString(), hidden: false });
  assert.equal(readAtLabel(view(new Date(2026, 9, 7, 12, 34)), now), 'Прочитано в 12:34');
  assert.equal(readAtLabel(view(new Date(2026, 9, 6, 12, 34)), now), 'Прочитано вчера в 12:34');
  assert.equal(readAtLabel(view(new Date(2026, 0, 5, 12, 34)), now), 'Прочитано 5 янв. в 12:34');
  assert.equal(readAtLabel({ read: true, at: null, hidden: true }, now), 'Прочитано');
  assert.equal(readAtLabel({ read: false, at: null, hidden: false }, now), null);
});
