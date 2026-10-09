import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as plural from './plural';
import * as rules from './longTextRules';

it('R132 без файлов ровно 4096 знаков идут одним сообщением, 4097 разбиваются без потери текста', () => {
  // Граница на единицу не должна отвергать допустимый текст или обрезать последний знак.
  for (const size of [4095, 4096, 4097]) {
    const text = 'Ж'.repeat(size), plan = rules.sharePlan(text, '', false);
    assert.ok(plan.ok); assert.equal(plan.caption, ''); assert.deepEqual(plan.comment, []);
    assert.equal(plan.tail.length, size <= 4096 ? 1 : 2);
    assert.equal(plan.tail.join(''), text); assert.ok(plan.tail.every(p => p.length <= 4096));
  }
});

it('R132 с файлами предельная подпись остаётся целой, длинная переносится целиком в хвост', () => {
  // Разрезанная подпись потерялась бы между файлами или отправилась повторно с каждым куском.
  for (const size of [4096, 4097]) {
    const text = 'Я'.repeat(size), plan = rules.sharePlan(text, '', true);
    assert.ok(plan.ok);
    assert.equal(plan.caption, size === 4096 ? text : '');
    assert.equal(plan.tail.length, size === 4096 ? 0 : 2);
    assert.equal(plan.caption + plan.tail.join(''), text);
  }
});

it('R132 пустой и пробельный ввод не создаёт ни подпись, ни пустые сообщения', () => {
  // Системное «Поделиться» с одним файлом не должно добавлять пустое сообщение после вложения.
  for (const files of [false, true]) for (const text of ['', ' \n\t ']) {
    assert.deepEqual(rules.sharePlan(text, ' \n ', files), { ok: true, comment: [], caption: '', tail: [] });
  }
  assert.deepEqual(rules.sharePlan('  текст  ', ' комментарий ', true),
    { ok: true, comment: ['комментарий'], caption: 'текст', tail: [] });
});

it('R132 длинный комментарий режется отдельно от подписи, оба сохраняют свой текст', () => {
  // Комментарий окна не должен стать частью подписи или обойти серверный предел одного сообщения.
  const comment = 'К'.repeat(4097), text = 'Т'.repeat(4096);
  const plan = rules.sharePlan(text, comment, true); assert.ok(plan.ok);
  assert.equal(plan.comment.length, 2); assert.equal(plan.comment.join(''), comment);
  assert.equal(plan.caption, text); assert.deepEqual(plan.tail, []);
  assert.ok(plan.comment.every(p => p.length > 0 && p.length <= 4096));
});

it('R132 восемь пределов принимаются, лишний знак текста или комментария даёт полный отказ', () => {
  // Квота применяется до отправки и к обоим независимым полям, а не только к подписи.
  for (const limit of [7, 4096]) for (const files of [false, true]) {
    for (const [text, comment] of [['А'.repeat(8 * limit), ''], ['', 'К'.repeat(8 * limit)]]) {
      assert.equal(rules.sharePlan(text, comment, files, limit).ok, true);
    }
    for (const [text, comment] of [['А'.repeat(8 * limit + 1), ''], ['', 'К'.repeat(8 * limit + 1)]]) {
      assert.deepEqual(rules.sharePlan(text, comment, files, limit), { ok: false, error: rules.tooLongText(1) });
    }
  }
});

it('R132 склейка комментария, подписи и хвоста сохраняет все знаки и не рвёт emoji', () => {
  // Независимое сравнение плотного текста ловит пропуск/повтор кусочка, не копирует алгоритм разреза.
  for (const files of [false, true]) for (const text of ['Т', '🙂'.repeat(2050), 'А'.repeat(8193)]) {
    const comment = 'К'.repeat(4097), plan = rules.sharePlan(text, comment, files); assert.ok(plan.ok);
    assert.equal(plan.comment.join('') + plan.caption + plan.tail.join(''), comment + text);
    for (const part of [...plan.comment, plan.caption, ...plan.tail].filter(Boolean)) {
      assert.ok(part.length <= 4096);
      assert.ok(!/[\uDC00-\uDFFF]/.test(part[0]!), 'начало не оставлено с хвостом суррогатной пары');
      assert.ok(!/[\uD800-\uDBFF]/.test(part.at(-1)!), 'конец не оставлен с головой суррогатной пары');
    }
  }
});

it('R132 мутанты обрезки подписи, hasFiles, предела восьми и неразрезанного комментария краснеют', () => {
  // Все четыре проверки исполняют целый настоящий модуль с одной изменённой веткой.
  const caption = (api: typeof rules) => {
    const plan = api.sharePlan('А'.repeat(4097), '', true); assert.ok(plan.ok);
    assert.equal(plan.caption, ''); assert.equal(plan.tail.join(''), 'А'.repeat(4097));
  };
  const noFiles = (api: typeof rules) => {
    const plan = api.sharePlan('текст', '', false); assert.ok(plan.ok);
    assert.equal(plan.caption, ''); assert.equal(plan.tail.join(''), 'текст');
  };
  const cap = (api: typeof rules) => assert.equal(api.sharePlan('А'.repeat(32769), '', false).ok, false);
  const comment = (api: typeof rules) => {
    const plan = api.sharePlan('', 'К'.repeat(4097), false); assert.ok(plan.ok);
    assert.ok(plan.comment.every(p => p.length <= 4096));
  };
  for (const [from, to, check] of [
    ["if (hasFiles && t.length > 0 && t.length <= limit) return { ok: true, comment: c, caption: t, tail: [] };",
      "if (hasFiles) return { ok: true, comment: c, caption: t.slice(0, limit), tail: [] };", caption],
    ['if (hasFiles && t.length > 0 && t.length <= limit)', 'if (t.length > 0 && t.length <= limit)', noFiles],
    ['const cap = limit * 8;', 'const cap = Infinity;', cap],
    ['const c = pieces(comment);', "const c = comment.trim() ? [comment.trim()] : [];", comment],
  ] as const) { check(rules); assert.throws(() => check(mutant(from, to)), assert.AssertionError); }
});

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./longTextRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'контрфакт меняет существующую ветку');
  const module = { exports: {} };
  const code = ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (id: string) => {
    assert.equal(id, './plural'); return plural;
  } });
  return module.exports as typeof rules;
}

it('файл предлагается только длинному тексту вне правки, а вставка достигает восьми лимитов с учётом выделения', () => {
  // Ловит слишком раннюю замену сообщения файлом и неверный подсчёт при обратном выделении.
  const check = (api: typeof rules) => {
    assert.equal(api.textFileOffer(4096, false), false);
    assert.equal(api.textFileOffer(4097, false), true);
    assert.equal(api.textFileOffer(4097, true), false);
    assert.equal(api.pastedTextBecomesFile(0, 0, 0, 32767), false);
    assert.equal(api.pastedTextBecomesFile(0, 0, 0, 32768), true);
    assert.equal(api.pastedTextBecomesFile(32768, 0, 0, 0), false);
    assert.equal(api.pastedTextBecomesFile(100, 80, 20, 32727), false);
    assert.equal(api.pastedTextBecomesFile(100, 80, 20, 32728), true);
    assert.equal(api.pastedTextBecomesFile(100, 20, 80, 32728), true);
    assert.equal(api.textAfterPaste('abcdef', 4, 1, 'X'), 'aXef');
    assert.equal(api.textAfterPaste('abcdef', 1, 4, ''), 'aef');
    assert.equal(api.textAfterPaste('ab', 1, 1, 'X'), 'aXb');
    assert.equal(api.pastedTextBecomesFile(0, 0, 0, 4097), false);
  };
  check(rules);
  for (const [from, to] of [['>= limit * 8', '> limit * 8'], ['Math.abs(selEnd - selStart)', '(selEnd - selStart)'], ['pasted >= limit * 8', 'pasted >= limit'], ['!editing && length > limit', 'length > limit']]) {
    assert.throws(() => check(mutant(from, to)), assert.AssertionError);
  }
});

it('пустой текст не создаёт сообщений, предел и склейка плотного текста сохраняют все знаки', () => {
  // Потеря края либо лишний пустой кусок незаметно меняют отправленный текст.
  assert.deepEqual(rules.splitLongText(' \n '), []);
  assert.deepEqual(rules.splitLongText('  текст  '), ['текст']);
  for (const n of [4095, 4096, 4097, 8192, 32768]) {
    const text = 'Ж'.repeat(n); const parts = rules.splitLongText(text);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every(p => p.length > 0 && p.length <= 4096), 'все куски в пределах серверного лимита');
  }
});

it('пустая строка во второй половине лучше предложения, ранний абзац не создаёт крошечный кусок', () => {
  // Поиск по всему тексту давал слишком много коротких сообщений и расходовал лимит отправки.
  const ranked = 'a'.repeat(2300) + '\n\n' + 'b'.repeat(1000) + '. ' + 'c'.repeat(1600);
  assert.equal(rules.splitLongText(ranked)[0], 'a'.repeat(2300));
  const text = 'a\n\n' + 'b'.repeat(5000);
  const check = (api: typeof rules) => assert.ok(api.splitLongText(text)[0].length >= 2000, 'ранний абзац вне окна не выбран');
  check(rules);
  assert.throws(() => check(mutant('Math.max(1, Math.floor(limit / 2))', '1')), assert.AssertionError);
});

it('разрез внутри слова не разрывает пару UTF-16 даже при нечётном пределе', () => {
  // Разорванные суррогаты превращают emoji в два знака замены на разных сообщениях.
  const text = '🙂'.repeat(10);
  const check = (api: typeof rules) => {
    const parts = api.splitLongText(text, 7);
    assert.equal(parts.join(''), text);
    for (const p of parts) {
      assert.ok(p.length <= 7, 'защита пары не превышает предел');
      assert.ok(!/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p), 'часть не имеет одинокой половины пары');
    }
  };
  check(rules);
  assert.throws(() => check(mutant('const lowSurrogate = code >= 0xdc00 && code <= 0xdfff;', 'const lowSurrogate = false;')), assert.AssertionError);
});

it('короткий спойлер у границы переносится целиком, соседний текст не пропадает', () => {
  // Разрыв парных || может открыть скрытый текст вместо сохранения спойлера.
  const secret = '||секрет секрет секрет||';
  const text = 'x'.repeat(4080) + ' ' + secret + ' ' + 'y'.repeat(30);
  const parts = rules.splitLongText(text);
  assert.ok(parts.some(p => p.includes(secret)), 'спойлер целиком в одном сообщении');
  assert.ok(parts.every(p => p.length <= 4096), 'перенос разметки не обходит лимит');
  assert.equal(parts.join(' ').replace(/\s/g, ''), text.replace(/\s/g, ''), 'теряются только документированные пробелы на стыке');
});

it('подпись 4096 ещё отправляется, 4097 отказывает; текст 32768 режется, 32769 отказывает', () => {
  // Подпись нельзя разложить на несколько сообщений и оторвать от файла; общий потолок тоже проверяется с двух сторон.
  assert.equal(rules.sendTextPlan('x'.repeat(4096), true).kind, 'one');
  const check = (api: typeof rules) => assert.equal(api.sendTextPlan('x'.repeat(4097), true).kind, 'too-long');
  check(rules);
  assert.deepEqual(rules.sendTextPlan('x'.repeat(4097), true), { kind: 'too-long', over: 1, caption: true });
  assert.equal(rules.sendTextPlan('x'.repeat(4097), false).kind, 'split');
  assert.equal(rules.sendTextPlan('x'.repeat(32768), false).kind, 'split');
  assert.deepEqual(rules.sendTextPlan('x'.repeat(32769), false), { kind: 'too-long', over: 1, caption: false });
  assert.throws(() => check(mutant('if (hasFiles) return', 'if (false) return')), assert.AssertionError);
});

it('счётчик жёсткого поля появляется ровно за 100 знаков и показывает ноль и перебор', () => {
  // Смещение порога или обычный дефис скрывали предупреждение о невозможной отправке.
  assert.equal(rules.composerCounter(3995, true), null);
  assert.deepEqual(rules.composerCounter(3996, true), { text: '100', over: false });
  assert.deepEqual(rules.composerCounter(4096, true), { text: '0', over: false });
  assert.deepEqual(rules.composerCounter(4108, true), { text: '−12', over: true });
  for (const n of [3996, 4096, 4108]) assert.equal(rules.composerCounter(n, false), null);
});

it('старую ошибку длины переводит в понятный текст, посторонние ошибки не маскирует', () => {
  // Универсальная подмена всех ошибок потеряла бы реальную причину сетевого отказа.
  assert.equal(rules.humanLengthError(' String must contain at most 4096 character(s) '), 'Слишком длинное сообщение: не больше 4096 знаков');
  for (const raw of ['', 'network failed', 'String must contain at least 4096 character(s)', 'String must contain at most 4096 character(s) extra']) assert.equal(rules.humanLengthError(raw), null);
  assert.match(rules.tooLongText(1, true), /подпись.*1 символ/);
  assert.match(rules.tooLongText(12), /сообщение.*12 символов/);
});
