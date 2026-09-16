import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gooseCurrentKey,
  GOOSE_CLAIM_TEXT,
  gooseBonusFor,
  gooseOfferAllowed,
  gooseTokenTtlMs,
  gooseCooldownKey,
  gooseEnabled,
  gooseTokenKey,
} from './gooseRules.js';

describe('включённость гуся', () => {
  it('включён только когда есть И надбавка, И интервал', () => {
    assert.equal(gooseEnabled({ gooseBonus: 5, gooseMinutes: 20 }), true);
  });

  /**
   * 🔴 Нулевая надбавка — это «гуся нет», а не «гусь есть и даёт ноль». Выглядывающий маскот, за
   * которым ничего не следует, человек прочитает как поломку, а не как настройку.
   */
  it('нулевая надбавка выключает гуся целиком', () => {
    assert.equal(gooseEnabled({ gooseBonus: 0, gooseMinutes: 20 }), false);
  });

  it('нулевой интервал тоже выключает — иначе гусь висел бы непрерывно', () => {
    assert.equal(gooseEnabled({ gooseBonus: 5, gooseMinutes: 0 }), false);
  });

  it('отрицательные значения не включают гуся', () => {
    assert.equal(gooseEnabled({ gooseBonus: -5, gooseMinutes: 20 }), false);
    assert.equal(gooseEnabled({ gooseBonus: 5, gooseMinutes: -1 }), false);
  });
});

describe('ключи предложения', () => {
  /**
   * 🔴 Главная проверка модуля. Идентификатор предложения обязан быть В ИМЕНИ ключа: удаление по
   * точному имени атомарно само по себе, и второе нажатие получает ноль удалённых ключей. Лежи он
   * значением — пришлось бы читать, сравнивать и удалять тремя шагами, а между ними пролезает
   * повторное нажатие и бонус выдаётся дважды.
   */
  it('жетон различается по идентификатору предложения', () => {
    const a = gooseTokenKey('srv', 'user', 'offer-1');
    const b = gooseTokenKey('srv', 'user', 'offer-2');
    assert.notEqual(a, b);
    assert.ok(a.includes('offer-1'), 'идентификатор обязан быть в ИМЕНИ ключа, а не только в значении');
  });

  it('жетоны разных людей и разных серверов не пересекаются', () => {
    assert.notEqual(gooseTokenKey('srv', 'a', 'o'), gooseTokenKey('srv', 'b', 'o'));
    assert.notEqual(gooseTokenKey('s1', 'a', 'o'), gooseTokenKey('s2', 'a', 'o'));
  });

  /**
   * ⚠️ Интервал считается по ПАРЕ сервер-человек и не содержит канала: иначе переход из канала в
   * канал обнулял бы ожидание, и бонус фармился бы перескакиванием.
   */
  it('интервал не зависит от канала, но зависит от сервера и человека', () => {
    assert.notEqual(gooseCooldownKey('s1', 'a'), gooseCooldownKey('s2', 'a'));
    assert.notEqual(gooseCooldownKey('s', 'a'), gooseCooldownKey('s', 'b'));
    // Ключ интервала и ключ жетона не должны совпасть ни при каких значениях.
    assert.notEqual(gooseCooldownKey('s', 'a'), gooseTokenKey('s', 'a', ''));
  });

  /**
   * 🔴 С 07.09 откат идёт от ПОИМКИ, а значит сменить непойманного гуся некому — он ждёт. Срок
   * жетона перестал быть частью правил и остался уборкой за собой: он обязан пережить любую
   * осмысленную паузу человека и НЕ зависеть от настроек сервера.
   */
  it('срок жетона не зависит от интервала — это уборка, а не расписание', () => {
    assert.equal(gooseTokenTtlMs(), gooseTokenTtlMs());
    assert.ok(gooseTokenTtlMs() > 240 * 60_000, 'обязан пережить даже максимальный интервал в 240 минут');
  });

  /** ⚠️ Указатель «сейчас висит вот это» — отдельный ключ, иначе его не отличить от жетона. */
  it('ключ текущего предложения свой у каждой пары и не совпадает с прочими', () => {
    assert.notEqual(gooseCurrentKey('s', 'a'), gooseCurrentKey('s', 'b'));
    assert.notEqual(gooseCurrentKey('s1', 'a'), gooseCurrentKey('s2', 'a'));
    assert.notEqual(gooseCurrentKey('s', 'a'), gooseCooldownKey('s', 'a'));
    assert.notEqual(gooseCurrentKey('s', 'a'), gooseTokenKey('s', 'a', ''));
  });
});

describe('выходить ли гусю (07.09)', () => {
  /**
   * 🔴 Главное правило захода. Голосу одиночество режет ставку до четверти, а гусь платил одному
   * столько же, сколько в компании, — и разбавлял главный рычаг экономики с шестикратного до
   * 2.25-кратного. Надбавка за компанию, которой нет, — это просто не надбавка.
   */
  it('один в канале — гуся нет', () => {
    assert.equal(gooseOfferAllowed({ peers: 0 }), false);
  });

  it('появился хоть один сосед — гусь выходит', () => {
    assert.equal(gooseOfferAllowed({ peers: 1 }), true);
    assert.equal(gooseOfferAllowed({ peers: 7 }), true);
  });

  /** ⚠️ Отрицательное число соседей — это сбой счёта, а не компания: платить по нему нельзя. */
  it('битое число соседей трактуется как одиночество', () => {
    assert.equal(gooseOfferAllowed({ peers: -1 }), false);
  });
});

describe('сколько стоит поимка (07.09)', () => {
  const s = { gooseBonus: 15, gooseMinutes: 10, gooseDeafenedBonus: 5 };

  it('обычная поимка — полная надбавка', () => {
    assert.equal(gooseBonusFor(s, { deafened: false }), 15);
  });

  /**
   * 🔴 Деафен НЕ отменяет гуся, а удешевляет его: человек в канале присутствует, и доказательство
   * присутствия с него берём — но он вне разговора, и полная надбавка за это была бы платой за
   * пустое кресло. Та же логика, что у `deafenedPercent` для ставки голоса.
   */
  it('в деафене — уменьшенная', () => {
    assert.equal(gooseBonusFor(s, { deafened: true }), 5);
  });

  /**
   * ⚠️ Настройка, выставленная БОЛЬШЕ основной надбавки, не должна превращать деафен в выгодную
   * позу: удешевление обязано оставаться удешевлением при любом значении ползунка.
   */
  it('деафенная надбавка не может превысить обычную', () => {
    assert.equal(gooseBonusFor({ ...s, gooseDeafenedBonus: 999 }, { deafened: true }), 15);
  });

  it('отрицательная настройка не отнимает монеты', () => {
    assert.equal(gooseBonusFor({ ...s, gooseDeafenedBonus: -20 }, { deafened: true }), 0);
  });

  /** Ноль — законное значение: «в деафене гусь не платит вовсе», но и не наказывает. */
  it('ноль означает «в деафене не платим»', () => {
    assert.equal(gooseBonusFor({ ...s, gooseDeafenedBonus: 0 }, { deafened: true }), 0);
  });
});

describe('тексты отказа', () => {
  /**
   * ⚠️ «Не успел» и «уже забрал» для человека — одно событие: гуся больше нет. Разные тексты
   * заставляли бы гадать, что он сделал не так.
   */
  it('оба отказа звучат одинаково', () => {
    assert.equal(GOOSE_CLAIM_TEXT.expired, GOOSE_CLAIM_TEXT.unavailable);
  });
});
