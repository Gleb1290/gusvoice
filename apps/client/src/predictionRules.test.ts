import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import { event, question, iso, NOW, normal, sourceOf, load, edited, type Edit } from './predictions.harness';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
        const mutant = edited(source, edit);
        assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
          'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}

const source = sourceOf('./predictionRules.ts');
type Rules = typeof import('./predictionRules');
const fixture = (raw: string): Rules => load(raw, { '@gusvoice/shared': shared });
const P = 'R338 rules: ';
function test(title: string, check: (m: Rules) => void, edits: readonly Edit[]) {
  it(`R338 правила событий: ${title}`, () => paired(source, raw => check(fixture(raw)), edits, P));
}
const draft = (): import('./predictionRules').PredictionDraftState => ({ title: 'Матч', lockInSec: 30,
  questions: [{ question: 'Кто?', options: ['Альфа', 'Бета'] }] });

test('своя строка bets важнее устаревшего mine, без строки остаётся mine, без обеих — null', m => {
  const q = question(); q.mine = { optionId: 'b', amount: 9, payout: 17, refunded: false };
  q.bets = [{ userId: 'me', optionId: 'a', amount: 21, payout: 40, refunded: false }];
  assert.deepEqual(normal(m.myBetOf(q, 'me')), { optionId: 'a', amount: 21, payout: 40, refunded: false }, P + 'bets главнее mine');
  for (const id of ['stranger', null, undefined]) assert.equal(m.myBetOf(q, id), q.mine, P + 'mine — запасной снимок');
  q.mine = null;
  assert.equal(m.myBetOf(q, 'stranger'), null, P + 'чужая ставка не становится своей');
}, [['if (row) return { optionId:', 'if (false && row) return { optionId:'], ['return q.mine ?? null;', 'return null;']]);

test('итог отличает выигрыш от возврата, не состоявшегося вопроса и проигрыша', m => {
  const ev = event();
  ev.questions = [
    { ...question('win'), winnerOptionId: 'a', mine: { optionId: 'a', amount: 10, payout: 28, refunded: false } },
    { ...question('refund'), mine: { optionId: 'a', amount: 11, payout: null, refunded: true } },
    { ...question('void'), void: true, mine: { optionId: 'b', amount: 12, payout: 12, refunded: false } },
    { ...question('lose'), winnerOptionId: 'b', mine: { optionId: 'a', amount: 13, payout: 0, refunded: false } },
    question('none'),
  ];
  assert.deepEqual(normal(m.myEventResult(ev, 'me')), { staked: 46, won: 28, refunded: 23, hits: 1, bets: 4 }, P + 'возврат не выигрыш');
  assert.deepEqual(normal(m.myEventResult(event(), null)), { staked: 0, won: 0, refunded: 0, hits: 0, bets: 0 }, P + 'без ставки нулевой итог');
}, [['if (b.refunded) refunded += b.amount;', 'if (b.refunded) won += b.amount;'],
  [' && q.winnerOptionId === b.optionId', ''], ['else if (b.payout != null && b.payout > 0) refunded += b.payout;', 'else if (b.payout != null && b.payout > 0) won += b.payout;']]);

test('время учитывает оба знака skew, ноль и просрочку; ручное и закрытое — null', m => {
  for (const skew of [5_000, -5_000, 0]) assert.equal(m.predictionLeftMs(event(), NOW, skew), 60_000 - skew, P + 'серверное время');
  assert.equal(m.predictionLeftMs(event(), NOW + 70_000, 0), 0, P + 'просрочка не отрицательна');
  for (const ev of [event('x', { lockAt: null }), event('x', { lockAt: 'bad' }),
    ...(['locked', 'settled', 'cancelled'] as const).map(state => event('x', { state }))]) {
    assert.equal(m.predictionLeftMs(ev, NOW, 0), null, P + 'нет действующего автоматического таймера');
  }
}, [['nowMs + skewMs', 'nowMs - skewMs'], ["ev.state !== 'open' || !ev.lockAt", '!ev.lockAt'],
  ['return Math.max(0, at - (nowMs + skewMs));', 'return at - (nowMs + skewMs);']]);

test('живое включает locked, точка горит только для open, часы и доля сохраняют границы', m => {
  assert.equal(m.predictionLive(event('x', { state: 'locked' })), true, P + 'locked ещё живое');
  assert.equal(m.predictionLive(event('x', { state: 'settled' })), false, P + 'settled не живое');
  assert.equal(m.predictionsOpen([event('x', { state: 'locked' })]), false, P + 'locked не приём');
  assert.equal(m.predictionsOpen([event()]), true, P + 'open приём');
  assert.equal(m.predictionsOpen(undefined), false, P + 'нет ленты нет точки');
  assert.deepEqual([m.predictionClock(-1), m.predictionClock(1), m.predictionClock(3_750_000), m.predictionClock(183_600_000)],
    ['0:00', '0:01', '1:02:30', '2 дн 3 ч'], P + 'видимые часы');
  assert.deepEqual([m.optionShare(1, 3), m.optionShare(0, 0), m.optionShare(-1, 3)], [33, 0, 0], P + 'доли пула');
}, [["return ev.state === 'open' || ev.state === 'locked';", "return ev.state === 'open';"],
  ["e.state === 'open'", "e.state === 'locked'"], ['Math.ceil(ms / 1000)', 'Math.floor(ms / 1000)']]);

// Каждая граница проверяется и на принятие, и на отклонение: блокирующая «Создать» в обе стороны опасна.
for (const [part, max, field] of [['title', 120, 'title'], ['question', 200, 'q0'], ['option', 80, 'q0.o1']] as const) {
  test(`${part}: пустота и предел +1 отклонены, ровно предел принят после схлопывания пробелов`, m => {
    for (const [text, expected] of [['', field], ['x'.repeat(max), null], ['x'.repeat(max + 1), field], ['  x \n y  ', null]] as const) {
      const d = draft();
      if (part === 'title') d.title = text;
      else if (part === 'question') d.questions[0].question = text;
      else d.questions[0].options[1] = text;
      assert.equal(m.draftProblem(d), expected, P + `${part} граница ${text.length}`);
    }
  }, [[part === 'title' ? 'title.length > PREDICTION_TITLE_MAX' : part === 'question'
    ? 'question.length > PREDICTION_QUESTION_MAX' : 'label.length > PREDICTION_OPTION_MAX',
  part === 'title' ? 'title.length >= PREDICTION_TITLE_MAX' : part === 'question'
    ? 'question.length >= PREDICTION_QUESTION_MAX' : 'label.length >= PREDICTION_OPTION_MAX']]);
}
test('вопросов 1..10, вариантов 2..10; адрес ошибки начинается с нуля', m => {
  for (const [count, expected] of [[0, 'questions'], [1, null], [10, null], [11, 'questions']] as const) {
    const d = draft(); d.questions = Array.from({ length: count }, () => draft().questions[0]);
    assert.equal(m.draftProblem(d), expected, P + 'граница количества вопросов');
  }
  for (const [count, expected] of [[1, 'q1.options'], [2, null], [10, null], [11, 'q1.options']] as const) {
    const d = draft(); d.questions.push({ question: 'Второй', options: Array.from({ length: count }, (_, i) => `o${i}`) });
    assert.equal(m.draftProblem(d), expected, P + 'граница количества вариантов и адрес');
  }
  const d = draft(); d.questions.push({ question: 'Второй', options: ['один', 'два', ''] });
  assert.equal(m.draftProblem(d), 'q1.o2', P + 'индексы поля нулевые');
}, [['d.questions.length > PREDICTION_MAX_QUESTIONS', 'd.questions.length >= PREDICTION_MAX_QUESTIONS'],
  ['q.options.length < PREDICTION_MIN_OPTIONS', 'q.options.length <= PREDICTION_MIN_OPTIONS'],
  ['q.options.length > PREDICTION_MAX_OPTIONS', 'q.options.length >= PREDICTION_MAX_OPTIONS'],
  ['if (label.length === 0 || label.length > PREDICTION_OPTION_MAX) return `q${n}.o${m}`;',
    'if (label.length === 0 || label.length > PREDICTION_OPTION_MAX) return `q${n + 1}.o${m + 1}`;']]);

test('таймер принимает null, 30 секунд и 7 суток; за границами и дроби отклоняет', m => {
  for (const value of [null, 30, 604_800]) assert.equal(m.draftProblem({ ...draft(), lockInSec: value }), null, P + 'таймер принимается');
  for (const value of [29, 604_801, 30.5, NaN, Infinity]) assert.equal(m.draftProblem({ ...draft(), lockInSec: value }), 'lock', P + 'таймер отклоняется');
}, [['d.lockInSec < PREDICTION_LOCK_MIN_SEC', 'd.lockInSec <= PREDICTION_LOCK_MIN_SEC'],
  ['d.lockInSec > PREDICTION_LOCK_MAX_SEC', 'd.lockInSec >= PREDICTION_LOCK_MAX_SEC']]);

test('дубликаты вариантов сравниваются без регистра и лишних пробелов, разные проходят', m => {
  for (const labels of [['Гусь', 'гУсЬ'], [' Красный  гусь ', 'красный\nгусь']]) {
    const d = draft(); d.questions[0].options = labels;
    assert.equal(m.draftProblem(d), 'q0.o1', P + 'повтор без учёта регистра');
  }
  assert.equal(m.draftProblem(draft()), null, P + 'разные варианты принимаются');
}, [["const key = label.toLocaleLowerCase('ru');", 'const key = label;']]);

test('тело чистит текст, не мутирует черновик; человеку номера с единицы', m => {
  const d = draft(); d.title = '  Финал\n матча  '; d.questions[0] = { question: '  Кто\t победит? ', options: [' Первый ', ' Второй\n вариант '] };
  const before = normal(d);
  assert.deepEqual(normal(m.draftBody(d)), { title: 'Финал матча', lockInSec: 30, questions: [{ question: 'Кто победит?', options: ['Первый', 'Второй вариант'] }] }, P + 'чистое тело');
  assert.deepEqual(d, before, P + 'черновик не изменён');
  assert.equal(m.draftFieldText('q0.o1', d), 'Вопрос 1, вариант 2: такой уже есть или слишком длинный', P + 'человеческие индексы');
  assert.equal(m.draftFieldText('q0.o8', d), 'Вопрос 1, вариант 9: пустой', P + 'пустое поле');
  assert.equal(m.draftFieldText(null), null, P + 'нет ошибки');
  assert.equal(m.draftFieldText('future'), 'Проверь событие: название, вопросы и варианты', P + 'неизвестное поле');
}, [['title: clean(d.title),', 'title: d.title,'], ['const n = Number(m[1]) + 1;', 'const n = Number(m[1]);']]);

const reasons = {
  creator: 'Создатель отменил событие — ставки вернулись', moderator: 'Событие отменил управляющий сервером — ставки вернулись',
  expired: 'Итог не подвели за неделю — ставки вернулись', 'games-off': 'На сервере выключили игры — ставки вернулись',
  'creator-deleted': 'Создатель удалил аккаунт — ставки вернулись',
};
test('все причины отмены и неизвестная причина остаются понятными', m => {
  for (const [code, text] of Object.entries(reasons)) assert.equal(m.cancelReasonText(code), text, P + `отмена ${code}`);
  for (const code of ['future', null, undefined]) assert.equal(m.cancelReasonText(code), 'Событие отменено — ставки вернулись', P + 'неизвестная причина');
}, [["return 'Событие отменено — ставки вернулись';", "return '';"], ["case 'expired':", "case 'removed-expired':"]]);

const errors: Record<string, string> = {
  not_in_voice: 'Ставить можно, только сидя в голосе этого сервера', 'games-off': 'Игры на этом сервере выключены',
  forbidden: 'Нужно право управлять экономикой сервера', creator: 'Создатель события не ставит — итог подводит он',
  not_creator: 'Итог подводит только создатель события', bot: 'Боты не играют',
  'opted-out': 'Ты не участвуешь в экономике — включи её в настройках сервера', 'games-opted-out': 'Игры у тебя выключены — включи их в кошельке',
  not_found: 'Этого события уже нет', already_bet: 'На этот вопрос ты уже поставил — ставка окончательная', duplicate: 'На этот вопрос ты уже поставил — ставка окончательная',
  not_open: 'Приём ставок уже закрыт', 'round-closed': 'Приём ставок уже закрыт', not_locked: 'Сначала закрой приём ставок',
  finished: 'Событие уже закончилось', too_many: 'На сервере уже идут три события — дождись итога одного из них', poor: 'Не хватает монет',
  'loss-limit': 'На сегодня предел проигрыша исчерпан — завтра снова', 'over-bet-max': 'Ставка больше, чем можно на этом сервере',
  'bad-amount': 'Ставка — целое число монет, от одной', 'bad-pick': 'Такого варианта нет', bad_draft: 'Проверь событие: название, вопросы и варианты',
  bad_winners: 'Укажи исход каждого вопроса', busy: 'Уже отправляется — секунду',
};
for (const [code, text] of Object.entries(errors)) {
  // creator/games-off есть и в cancelReasonText. Якорь включает именно текст отказа,
  // а у общих веток — соседний alias: никогда не меняем одноимённую причину отмены.
  const alias = code === 'already_bet' ? "    case 'duplicate':\n" : code === 'not_open' ? "    case 'round-closed':\n" : '';
  const anchor = `case '${code}':\n${alias}      return '${text}';`;
  test(`отказ ${code} не теряется в общем сообщении`, m => {
    assert.equal(m.predictionErrorText(code), text, P + `отказ ${code}`);
  }, [[anchor, (counterfact(() => anchor.replace(`case '${code}':`, `case 'removed-${code}':`)) ?? '')]]);
}
test('неизвестный отказ использует fallback, старый сервер не ломает UI', m => {
  assert.equal(m.predictionErrorText('future', 'Повтори'), 'Повтори', P + 'fallback');
  assert.equal(m.predictionErrorText(undefined), 'Не получилось — попробуй ещё раз', P + 'умолчание');
}, [['return fallback;', "return '';"]]);
