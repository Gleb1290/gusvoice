import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_TEXT,
  POLL_MAX_QUESTION,
  checkPollDraft,
  normalizePollDraft,
} from './pollDraft.js';

const ok = (r: ReturnType<typeof checkPollDraft>) => {
  assert.equal(r.ok, true, r.ok ? '' : `ожидался ok, получено «${r.error}»`);
  return r as Extract<typeof r, { ok: true }>;
};
const err = (r: ReturnType<typeof checkPollDraft>) => {
  assert.equal(r.ok, false, 'ожидался отказ');
  return (r as Extract<typeof r, { ok: false }>).error;
};

describe('нормализация черновика', () => {
  it('срезает крайние пробелы', () => {
    const d = normalizePollDraft('  Пиццу?  ', [' Да ', 'Нет ']);
    assert.equal(d.question, 'Пиццу?');
    assert.deepEqual(d.options, ['Да', 'Нет']);
  });

  it('пустые и пробельные варианты выкидываются', () => {
    // Форма всегда показывает минимум два поля — незаполненное четвёртое это не ошибка.
    assert.deepEqual(normalizePollDraft('q', ['Да', '', '   ', 'Нет']).options, ['Да', 'Нет']);
  });

  it('порядок вариантов сохраняется', () => {
    assert.deepEqual(normalizePollDraft('q', ['в', 'а', 'б']).options, ['в', 'а', 'б']);
  });
});

describe('что принимаем', () => {
  it('минимальный годный опрос', () => {
    const r = ok(checkPollDraft('Пиццу?', ['Да', 'Нет']));
    assert.equal(r.question, 'Пиццу?');
    assert.deepEqual(r.options, ['Да', 'Нет']);
  });

  it('нормализованные значения возвращаются наружу — их и надо писать в базу', () => {
    const r = ok(checkPollDraft(' Пиццу? ', ['  Да', 'Нет  ', '  ']));
    assert.equal(r.question, 'Пиццу?');
    assert.deepEqual(r.options, ['Да', 'Нет']);
  });

  it('ровно максимум вариантов', () => {
    const many = Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => `вариант ${i}`);
    ok(checkPollDraft('q', many));
  });

  it('пустые поля формы не съедают лимит сохранённых вариантов', () => {
    // Ловит проверку числа input-полей до нормализации: форма всегда держит лишние пустые строки.
    const choices = Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => `вариант ${i}`);
    const r = ok(checkPollDraft('q', ['', ...choices, '   ']));
    assert.deepEqual(r.options, choices);
  });

  it('длины ровно по границе', () => {
    ok(checkPollDraft('в'.repeat(POLL_MAX_QUESTION), ['а'.repeat(POLL_MAX_OPTION_TEXT), 'б']));
  });

  it('предельный вариант с крайними пробелами принимается и сохраняется подрезанным', () => {
    // Ловит расчёт лимита до trim, который отвергал бы текст, реально помещающийся в базу.
    const option = 'а'.repeat(POLL_MAX_OPTION_TEXT);
    const r = ok(checkPollDraft('q', [`  ${option}  `, 'б']));
    assert.deepEqual(r.options, [option, 'б']);
  });

  it('варианты, различающиеся только пробелами по краям, — это ПОВТОР, а не два варианта', () => {
    assert.equal(err(checkPollDraft('q', [' Да', 'Да '])), 'варианты повторяются');
  });
});

describe('что отклоняем', () => {
  it('пустой вопрос и вопрос из пробелов', () => {
    assert.equal(err(checkPollDraft('', ['Да', 'Нет'])), 'нужен вопрос');
    assert.equal(err(checkPollDraft('   ', ['Да', 'Нет'])), 'нужен вопрос');
  });

  it('один вариант — не опрос', () => {
    assert.equal(err(checkPollDraft('q', ['Да'])), 'нужно минимум два варианта');
    assert.equal(err(checkPollDraft('q', ['Да', '   '])), 'нужно минимум два варианта');
  });

  it('повтор ловится без учёта регистра', () => {
    assert.equal(err(checkPollDraft('q', ['Да', 'да'])), 'варианты повторяются');
  });

  it('перебор по длине', () => {
    assert.equal(err(checkPollDraft('в'.repeat(POLL_MAX_QUESTION + 1), ['а', 'б'])), 'слишком длинный вопрос');
    assert.equal(
      err(checkPollDraft('q', ['а'.repeat(POLL_MAX_OPTION_TEXT + 1), 'б'])),
      'слишком длинный вариант',
    );
  });

  it('перебор по количеству', () => {
    const many = Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `вариант ${i}`);
    assert.equal(err(checkPollDraft('q', many)), 'слишком много вариантов');
  });

  it('длина считается ПОСЛЕ подрезки — пробелы по краям не должны отнимать лимит', () => {
    ok(checkPollDraft(`  ${'в'.repeat(POLL_MAX_QUESTION)}  `, ['а', 'б']));
  });
});
