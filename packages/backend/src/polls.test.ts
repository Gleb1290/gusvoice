import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkVote, pollClosed, resultsVisible, tally } from './pollRules.js';

/**
 * Опросы (#17).
 *
 * Голосование ходит в базу, поэтому здесь проверяется то, что от неё не зависит: срок закрытия и
 * правила подсчёта. Сам подсчёт вынесен в `tally` именно ради этого — иначе единственный способ
 * проверить «один человек = один голос при мультивыборе» это поднять Postgres.
 */
describe('срок опроса', () => {
  it('бессрочный не закрывается никогда', () => {
    assert.equal(pollClosed(null), false);
  });
  it('будущее время — открыт', () => {
    assert.equal(pollClosed(new Date(Date.now() + 60_000)), false);
  });
  it('прошедшее время — закрыт', () => {
    assert.equal(pollClosed(new Date(Date.now() - 1000)), true);
  });
  it('ровно сейчас — уже закрыт', () => {
    assert.equal(pollClosed(new Date(Date.now() - 1)), true);
  });
});

describe('подсчёт', () => {
  // tally принимает опрос целиком — здесь важны только варианты, остальное фиксируем.
  const poll = {
    question: 'Заказываем пиццу?',
    options: [
      { id: '1', text: 'Да' },
      { id: '2', text: 'Нет' },
    ],
    multi: false,
    anonymous: true,
    closesAt: null,
  };

  it('считает голоса по вариантам', () => {
    const r = tally(poll, [
      { userId: 'a', optionId: '1' },
      { userId: 'b', optionId: '1' },
      { userId: 'c', optionId: '2' },
    ], 'a');
    assert.deepEqual(r.options.map((o) => o.votes), [2, 1]);
  });

  it('«проголосовало» считает ЛЮДЕЙ, а не голоса', () => {
    // При мультивыборе один человек даёт несколько голосов: сумма голосов 3, людей 2.
    // Иначе «проголосовало 3» при двух участниках выглядит как ошибка.
    const r = tally(poll, [
      { userId: 'a', optionId: '1' },
      { userId: 'a', optionId: '2' },
      { userId: 'b', optionId: '1' },
    ], 'a');
    assert.equal(r.voters, 2);
    assert.equal(r.options.reduce((s, o) => s + o.votes, 0), 3);
  });

  it('свой выбор виден только свой', () => {
    const votes = [
      { userId: 'a', optionId: '1' },
      { userId: 'b', optionId: '2' },
    ];
    assert.deepEqual(tally(poll, votes, 'a').myVotes, ['1']);
    assert.deepEqual(tally(poll, votes, 'b').myVotes, ['2']);
    assert.deepEqual(tally(poll, votes, 'кто-то-ещё').myVotes, []);
  });

  it('пустой опрос — нули, а не пусто', () => {
    const r = tally(poll, [], 'a');
    assert.deepEqual(r.options.map((o) => o.votes), [0, 0]);
    assert.equal(r.voters, 0);
  });

  it('закрытый опрос раскрывает итог не голосовавшему и сериализует срок', () => {
    const closesAt = new Date(Date.now() - 1000);
    const r = tally(
      { ...poll, closesAt },
      [{ userId: 'a', optionId: '1' }],
      'не-голосовал',
    );
    assert.equal(r.closed, true);
    assert.equal(r.revealed, true);
    assert.deepEqual(r.options.map((o) => o.votes), [1, 0]);
    assert.equal(r.closesAt, closesAt.toISOString());
  });
});

describe('видимость результатов', () => {
  it('до своего голоса скрыты', () => {
    assert.equal(resultsVisible(false, false), false);
  });
  it('после своего голоса открыты', () => {
    assert.equal(resultsVisible(true, false), true);
  });
  it('после закрытия открыты даже не голосовавшему', () => {
    // Итог завершённого опроса скрывать не от кого.
    assert.equal(resultsVisible(false, true), true);
  });

  it('скрытые счётчики уходят НУЛЯМИ, а не настоящими числами', () => {
    // Спрятать в клиенте мало: отданные числа — уже не тайна.
    const poll = {
      question: 'q',
      options: [
        { id: '1', text: 'Да' },
        { id: '2', text: 'Нет' },
      ],
      multi: false,
      anonymous: true,
      closesAt: null,
    };
    const votes = [
      { userId: 'a', optionId: '1' },
      { userId: 'b', optionId: '1' },
    ];
    const чужой = tally(poll, votes, 'ещё-не-голосовал');
    assert.equal(чужой.revealed, false);
    assert.deepEqual(чужой.options.map((o) => o.votes), [0, 0]);
    // Но общее число проголосовавших видно всем — оно не раскрывает распределение.
    assert.equal(чужой.voters, 2);

    const свой = tally(poll, votes, 'a');
    assert.equal(свой.revealed, true);
    assert.deepEqual(свой.options.map((o) => o.votes), [2, 0]);
  });
});

describe('приём голоса', () => {
  const poll = { options: [{ id: '1' }, { id: '2' }, { id: '3' }], multi: false, closesAt: null };
  const multi = { ...poll, multi: true };

  it('первый голос принимается', () => {
    assert.equal(checkVote(poll, false, ['1']).ok, true);
  });

  it('переголосовать нельзя', () => {
    const r = checkVote(poll, true, ['2']);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /переголосовать нельзя/);
  });

  it('в одиночном опросе нельзя выбрать два варианта', () => {
    assert.equal(checkVote(poll, false, ['1', '2']).ok, false);
  });

  it('в множественном — можно', () => {
    assert.equal(checkVote(multi, false, ['1', '3']).ok, true);
  });

  it('пустой выбор отклоняется', () => {
    assert.equal(checkVote(multi, false, []).ok, false);
  });

  it('повтор одного варианта отклоняется', () => {
    // Иначе один человек накрутил бы себе счётчик, отправив ['1','1'].
    assert.equal(checkVote(multi, false, ['1', '1']).ok, false);
  });

  it('несуществующий вариант отклоняется', () => {
    assert.equal(checkVote(poll, false, ['99']).ok, false);
  });

  it('в закрытый опрос голос не принимается', () => {
    assert.equal(checkVote({ ...poll, closesAt: new Date(Date.now() - 1000) }, false, ['1']).ok, false);
  });
});
