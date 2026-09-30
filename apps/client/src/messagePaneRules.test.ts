import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acTokenAt,
  applyAc,
  emojiSubstitution,
  enterSends,
  GROUP_WINDOW_MS,
  dayLabel,
  isFirstUnread,
  isGrouped,
  isNewDay,
  type ListMessage,
} from './messagePaneRules.js';

describe('Enter в многострочном поле', () => {
  it('Shift, IME и сенсор оставляют перенос строки, а клавиатурный Enter отправляет', () => {
    // Ловит случайную отправку с телефона/IME и потерю привычного Shift+Enter на компьютере.
    assert.equal(enterSends({ shift: true, composing: false, touchOnly: false }), false);
    assert.equal(enterSends({ shift: false, composing: true, touchOnly: false }), false);
    assert.equal(enterSends({ shift: false, composing: false, touchOnly: true }), false);
    assert.equal(enterSends({ shift: false, composing: false, touchOnly: false }), true);
  });
});

const message = (at: number, authorId = 'other', hasReply = false): ListMessage => ({
  createdAt: new Date(at).toISOString(),
  authorId,
  hasReply,
});

describe('токен автодополнения под кареткой', () => {
  it('эмодзи-код из двух символов открывает подсказки', () => {
    // Ловит недоступность обещанного autocomplete после достижения минимальной длины.
    assert.deepEqual(acTokenAt(':fi', 3, true), { trigger: ':', query: 'fi', start: 0 });
  });

  it('один символ и ручной смайлик не открывают список эмодзи', () => {
    // Ловит всплывание подсказок на каждом коротком «:)» в обычном разговоре.
    assert.equal(acTokenAt(':f', 2, true), null);
    assert.equal(acTokenAt(':)', 2, true), null);
  });

  it('упоминания и каналы отключены вне серверного контекста', () => {
    // Ловит пустые серверные подсказки внутри личной переписки.
    assert.equal(acTokenAt('@ivan', 5, false), null);
    assert.equal(acTokenAt('#general', 8, false), null);
  });

  it('время и адрес почты не считаются токенами', () => {
    // Ловит навязчивый autocomplete при наборе времени и электронной почты.
    assert.equal(acTokenAt('10:30', 5, true), null);
    assert.equal(acTokenAt('a@b', 3, true), null);
  });

  it('отсутствующая каретка всегда даёт null', () => {
    // Ловит замену текста при неизвестной позиции selectionStart.
    assert.equal(acTokenAt(':fire', null, true), null);
  });

  it('токен в середине строки возвращает индекс своего триггера', () => {
    // Ловит удаление соседнего текста при замене токена не с начала строки.
    assert.deepEqual(acTokenAt('say @iv later', 7, true), { trigger: '@', query: 'iv', start: 4 });
  });

  it('пустое упоминание и имя канала принимаются на сервере', () => {
    // Ловит запрет законных подсказок сразу после @ и #.
    assert.deepEqual(acTokenAt('@', 1, true), { trigger: '@', query: '', start: 0 });
    assert.deepEqual(acTokenAt('#general', 8, true), { trigger: '#', query: 'general', start: 0 });
  });
});

describe('применение выбранной подсказки', () => {
  it('токен заменяется с пробелом, а каретка встаёт после него', () => {
    // Ловит приклеивание следующего слова к имени и неверную позицию дальнейшего ввода.
    assert.deepEqual(applyAc('say @ivnow', { trigger: '@', query: 'iv', start: 4 }, '@ivan'), {
      text: 'say @ivan now',
      caret: 10,
    });
  });
});

describe('автозамена шорткода эмодзи', () => {
  it('известный :fire: заменяется, а каретка учитывает UTF-16 длину эмодзи', () => {
    // Ловит каретку внутри суррогатной пары 🔥 после успешной замены.
    assert.deepEqual(emojiSubstitution('say :fire:', 10), { text: 'say 🔥', caret: 6 });
  });

  it('замена в середине строки сохраняет хвост после каретки', () => {
    // Ловит потерю уже набранной части сообщения справа от заменяемого кода.
    assert.deepEqual(emojiSubstitution('say :fire: later', 10), { text: 'say 🔥 later', caret: 6 });
  });

  it('время и URL с портом остаются обычным текстом', () => {
    // Ловит повреждение времени и адресов при вводе закрывающего двоеточия.
    assert.equal(emojiSubstitution('10:30:', 6), null);
    assert.equal(emojiSubstitution('http://host:8080:', 17), null);
  });

  it('неизвестный код не исчезает из сообщения', () => {
    // Ловит молчаливое удаление пользовательского текста, которого нет в таблице эмодзи.
    assert.equal(emojiSubstitution(':zzzznotacode:', 14), null);
  });

  it('без каретки замена не выполняется', () => {
    // Ловит изменение поля при неизвестной позиции курсора.
    assert.equal(emojiSubstitution(':fire:', null), null);
  });
});

describe('разделитель новых сообщений', () => {
  it('первое чужое сообщение после отметки рисует разделитель', () => {
    // Ловит полное исчезновение границы непрочитанного после возвращения в канал.
    assert.equal(isFirstUnread(message(2_000), undefined, 'me', 1_000), true);
  });

  it('второе новое сообщение подряд не рисует второй разделитель', () => {
    // Ловит повтор «Новые сообщения» над каждым сообщением после отметки.
    assert.equal(isFirstUnread(message(3_000), message(2_000), 'me', 1_000), false);
  });

  it('собственное сообщение не считается новым для автора', () => {
    // Ловит разделитель над сообщением, которое пользователь только что написал сам.
    assert.equal(isFirstUnread(message(2_000, 'me'), undefined, 'me', 1_000), false);
  });

  it('без отметки последнего визита разделитель не появляется', () => {
    // Ловит ложную границу непрочитанного в только что открытом или новом канале.
    assert.equal(isFirstUnread(message(2_000), undefined, 'me', null), false);
  });

  it('ровно отметка ещё прочитана, а миллисекунда после неё уже новая', () => {
    // Ловит ошибку строгой границы времени последнего визита.
    assert.equal(isFirstUnread(message(1_000), undefined, 'me', 1_000), false);
    assert.equal(isFirstUnread(message(1_001), undefined, 'me', 1_000), true);
  });
});

describe('группировка соседних сообщений', () => {
  it('без предыдущего сообщения группа не начинается', () => {
    // Ловит исчезновение шапки автора у первого сообщения списка.
    assert.equal(isGrouped(message(1_000), undefined), false);
  });

  it('сообщения одного автора через минуту объединяются', () => {
    // Ловит чрезмерное дробление обычной последовательной переписки.
    assert.equal(isGrouped(message(61_000), message(1_000)), true);
  });

  it('ровно пять минут ещё группа, а следующая миллисекунда уже новый блок', () => {
    // Ловит ошибку на границе окна группировки.
    assert.equal(isGrouped(message(1_000 + GROUP_WINDOW_MS), message(1_000)), true);
    assert.equal(isGrouped(message(1_001 + GROUP_WINDOW_MS), message(1_000)), false);
  });

  it('сообщение другого автора всегда начинает свой блок', () => {
    // Ловит визуальное приписывание чужого текста предыдущему человеку.
    assert.equal(isGrouped(message(2_000, 'second'), message(1_000, 'first')), false);
  });

  it('ответ с цитатой всегда начинает новый блок', () => {
    // Ловит чтение цитаты как продолжения предыдущей мысли без собственной шапки.
    assert.equal(isGrouped(message(2_000, 'same', true), message(1_000, 'same')), false);
  });
});

describe('границы календарных дней', () => {
  it('первое сообщение всегда открывает дневной блок', () => {
    // Ловит ленту без даты над самым верхним сообщением.
    assert.equal(isNewDay(message(Date.UTC(2026, 8, 20, 12)), undefined), true);
  });

  it('сообщения одного местного дня не создают второй разделитель', () => {
    // Ловит сравнение полных timestamp вместо календарной даты читателя.
    const noon = new Date(2026, 8, 20, 12).getTime();
    const evening = new Date(2026, 8, 20, 23).getTime();
    assert.equal(isNewDay(message(evening), message(noon)), false);
  });

  it('соседние сообщения по разные стороны местной полуночи разделяются', () => {
    // Ловит расчёт дня по UTC, когда у читающего уже наступили новые сутки.
    const before = new Date(2026, 8, 20, 23, 59, 59).getTime();
    const after = new Date(2026, 8, 21, 0, 0, 0).getTime();
    assert.equal(isNewDay(message(after), message(before)), true);
  });

  it('подписи сегодня и вчера считаются от переданного времени', () => {
    // Ловит зависимость теста и интерфейса от часов машины вместо выбранного «сейчас».
    const now = new Date(2026, 8, 22, 12);
    assert.equal(dayLabel(new Date(2026, 8, 22, 1).toISOString(), now), 'Сегодня');
    assert.equal(dayLabel(new Date(2026, 8, 21, 23).toISOString(), now), 'Вчера');
  });
});
