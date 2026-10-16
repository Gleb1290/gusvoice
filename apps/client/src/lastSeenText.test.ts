import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { contactStatusText, lastSeenLabel, lastSeenNextChangeMs, readAtLabel, serverLastSeen } from './lastSeenText';
const now = new Date(2026, 9, 7, 20, 0, 0);
const status = (at: Date) => ({ online: false, at: at.toISOString(), approx: null });
function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}
it('R169 контрфакты приоритета присутствия, точности и пустой подписи отвергаются', () => {
  // Компилируем целый модуль: эти три ошибки внешне похожи на допустимый статус, но нарушают fallback.
  const source = readFileSync(new URL('./lastSeenText.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const seen = { userId: 'u', online: true, at: null, approx: null, exact: true, byMe: false };
  const changes = [
    (s: string) => replaceOnce(s, "if (online) return 'в сети';", "if (false) return 'в сети';"),
    (s: string) => replaceOnce(s, "seen.exact ? 'был(а) только что' : 'был(а) недавно'", "seen.exact ? 'был(а) недавно' : 'был(а) только что'"),
    (s: string) => replaceOnce(s, 'if (!seen) return null;', "if (!seen) return '';"),
  ];
  const probes = [
    (m: typeof import('./lastSeenText')) => assert.equal(m.contactStatusText(true, seen, now), 'в сети'),
    (m: typeof import('./lastSeenText')) => assert.equal(m.contactStatusText(false, seen, now), 'был(а) только что'),
    (m: typeof import('./lastSeenText')) => assert.equal(m.contactStatusText(false, undefined, now), null),
  ];
  changes.forEach((change, i) => {
    probes[i]!({ contactStatusText } as typeof import('./lastSeenText'));
    const altered = change(source); assert.notEqual(altered, source);
    const module = { exports: {} as typeof import('./lastSeenText') };
    runInNewContext(ts.transpileModule(altered, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return { FEATURE_LASTSEEN1: 'lastseen1' }; } });
    assert.throws(() => probes[i]!(module.exports), assert.AssertionError);
  });
});
it('R169 присутствие контакта главнее снимка, а отсутствие снимка оставляет подпись ника', () => {
  // Устаревший снимок не должен скрывать живое присутствие; строка вместо null убрала бы @ник.
  const seen = { userId: 'u', online: false, at: null, approx: 'long' as const, exact: false, byMe: false };
  assert.equal(contactStatusText(true, seen, now), 'в сети');
  assert.equal(contactStatusText(true, undefined, now), 'в сети');
  assert.equal(contactStatusText(false, undefined, now), null);
});
it('R169 ушедший контакт различает точный и скрытый онлайн-снимок и обычное время захода', () => {
  // Перестановка exact раскрывает точность скрытого времени и делает свежий снимок неточным.
  const seen = { userId: 'u', online: true, at: null, approx: null, exact: true, byMe: false };
  assert.equal(contactStatusText(false, seen, now), 'был(а) только что');
  assert.equal(contactStatusText(false, { ...seen, exact: false }, now), 'был(а) недавно');
  const offline = { ...seen, online: false, at: new Date(now.getTime() - 120000).toISOString() };
  assert.equal(contactStatusText(false, offline, now), 'был(а) 2 минуты назад');
});
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
