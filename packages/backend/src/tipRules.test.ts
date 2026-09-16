import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TIP_COOLDOWN_MS,
  tipBlock,
  tipCooldownKey,
  tipSplit,
  type TipInput,
  type TipSettings,
} from './tipRules.js';

const settings = (patch: Partial<TipSettings> = {}): TipSettings => ({
  tipAmount: 5,
  tipTaxPercent: 20,
  tipDailyOut: 20,
  tipDailyIn: 20,
  // ⚠️ Ноль = потолок пары выключен. Он живёт не в `tipBlock`, а в транзакции перевода (журнал —
  // единственный, кто знает, сколько именно этот человек донёс именно тому за сутки).
  tipDailyPair: 0,
  ...patch,
});

const allowed = (patch: Partial<TipInput> = {}): TipInput => ({
  fromUserId: 'alice',
  toUserId: 'bob',
  economyEnabled: true,
  together: true,
  senderOptedOut: false,
  targetOptedOut: false,
  onCooldown: false,
  balance: 5,
  givenToday: 0,
  receivedToday: 0,
  ...patch,
});

describe('кулдаун типа', () => {
  it('живёт десять секунд и различает обоих людей вместе с направлением пары', () => {
    // Ловит общий кулдаун, который запрещает поблагодарить двух друзей, и обратную дыру для спама одной цели.
    assert.equal(TIP_COOLDOWN_MS, 10_000);
    const first = tipCooldownKey('alice', 'bob');
    assert.notEqual(first, tipCooldownKey('alice', 'carol'));
    assert.notEqual(first, tipCooldownKey('carol', 'bob'));
    assert.notEqual(first, tipCooldownKey('bob', 'alice'));
  });
});

describe('порядок причин отказа типа', () => {
  it('разрешённый тип человеку рядом проходит', () => {
    assert.equal(tipBlock(allowed(), settings()), null);
  });

  it('самому себе нельзя даже при всех последующих причинах', () => {
    // Ловит утечку чужих ограничений через текст ошибки для действия, которое заведомо невозможно.
    assert.equal(tipBlock(allowed({ toUserId: 'alice', economyEnabled: false, together: false, targetOptedOut: true, onCooldown: true, balance: 0, givenToday: 20, receivedToday: 20 }), settings()), 'self');
  });

  it('выключенная экономика важнее отсутствия общей комнаты', () => {
    assert.equal(tipBlock(allowed({ economyEnabled: false, together: false, targetOptedOut: true, onCooldown: true, balance: 0 }), settings()), 'disabled');
  });

  it('разные голосовые важнее отказа получателя', () => {
    assert.equal(tipBlock(allowed({ together: false, targetOptedOut: true, onCooldown: true, balance: 0 }), settings()), 'not-together');
  });

  it('отказ получателя важнее кулдауна и денег отправителя', () => {
    assert.equal(tipBlock(allowed({ targetOptedOut: true, onCooldown: true, balance: 0 }), settings()), 'opted-out');
  });

  it('уже записанный кулдаун важнее проверки баланса и лимитов', () => {
    // Ловит перестановку проверок: на уже живом ключе человек должен увидеть «подожди», а не сведения о деньгах.
    assert.equal(tipBlock(allowed({ onCooldown: true, balance: 0, givenToday: 20, receivedToday: 20 }), settings()), 'cooldown');
  });

  it('нехватка монет важнее обоих суточных лимитов', () => {
    assert.equal(tipBlock(allowed({ balance: 4, givenToday: 20, receivedToday: 20 }), settings()), 'poor');
  });

  it('предел отправителя проверяется раньше предела получателя и граница равна ещё проходит', () => {
    const s = settings();
    assert.equal(tipBlock(allowed({ givenToday: 15, receivedToday: 15 }), s), null);
    assert.equal(tipBlock(allowed({ givenToday: 16, receivedToday: 20 }), s), 'out-limit');
  });

  it('предел получателя срабатывает только после всех предыдущих проверок', () => {
    // Цена 5, налог 20 % -> доходит 4. При потолке приёма 20 и уже полученных 17 следующий тип
    // дал бы 21 — это перебор.
    assert.equal(tipBlock(allowed({ givenToday: 15, receivedToday: 17 }), settings()), 'in-limit');
  });

  it('🔴 предел приёма считается по ДОШЕДШЕМУ, а не по списанному', () => {
    // Находка Codex: здесь сравнивалась грязная сумма, а транзакция перевода — чистая. Два места
    // считали один предел по-разному, и законный тип получал ложный отказ.
    // Цена 5, налог 20 % -> доходит 4. Потолок приёма 4, получено 0: тип обязан пройти.
    const s = settings({ tipAmount: 5, tipTaxPercent: 20, tipDailyIn: 4 });
    assert.equal(tipBlock(allowed({ receivedToday: 0 }), s), null, 'по грязной сумме это был бы отказ');
    // А вот следующий уже упрётся: 4 + 4 = 8 > 4.
    assert.equal(tipBlock(allowed({ receivedToday: 4 }), s), 'in-limit');
  });

  it('ровно в потолок приёма — это ещё можно', () => {
    // Та же граница, что у «хватает монет»: равенство не перебор.
    const s = settings({ tipAmount: 5, tipTaxPercent: 20, tipDailyIn: 20 });
    assert.equal(tipBlock(allowed({ receivedToday: 16 }), s), null, '16 + 4 = ровно 20');
    assert.equal(tipBlock(allowed({ receivedToday: 17 }), s), 'in-limit');
  });

  it('предел ОТДАЧИ по-прежнему по списанному, вместе с налогом', () => {
    // У отправителя уходит вся сумма целиком — считать её по дошедшему было бы подарком.
    const s = settings({ tipAmount: 5, tipTaxPercent: 80, tipDailyOut: 20 });
    assert.equal(tipBlock(allowed({ givenToday: 15 }), s), null, '15 + 5 = ровно 20');
    assert.equal(tipBlock(allowed({ givenToday: 16 }), s), 'out-limit', 'по дошедшему (1) прошло бы');
  });

  it('🔴 свой отказ от экономики закрывает и отдачу тоже', () => {
    // Контракт `optedOut` — «ни начисления, ни типов». Работала только первая половина (Codex).
    assert.equal(tipBlock(allowed({ senderOptedOut: true }), settings()), 'self-opted-out');
    // ⚠️ Раньше чужих проверок: про СВОЮ настройку человеку сказать можно прямо, выяснять нечего.
    assert.equal(
      tipBlock(allowed({ senderOptedOut: true, targetOptedOut: true, balance: 0 }), settings()),
      'self-opted-out',
    );
  });
});

describe('разложение типа на монеты и сток', () => {
  it('нулевой налог сохраняет всю сумму, а 100% сжигает даже единственную монету', () => {
    assert.deepEqual(tipSplit(1, 0), { debit: 1, credit: 1, burned: 0 });
    assert.deepEqual(tipSplit(1, 100), { debit: 1, credit: 0, burned: 1 });
  });

  it('дробь округляется вниз в пользу сгорания, а все части всегда дают исходное списание', () => {
    // Ловит тихое округление в пользу получателя: на мелких типах оно выключило бы налог как анти-альт защиту.
    for (const [amount, tax] of [[7, 25], [3, 33], [19, 87], [0, 50]]) {
      const split = tipSplit(amount, tax);
      assert.equal(split.debit, split.credit + split.burned);
      assert.ok(split.burned >= 0);
    }
    assert.deepEqual(tipSplit(7, 25), { debit: 7, credit: 5, burned: 2 });
  });

  it('каждая сумма и каждый допустимый налог сохраняют монету: дошедшее плюс сгоревшее равно списанному', () => {
    // Ловит край в один ГусКоин: именно там неверное округление тихо превращает налог в создание
    // или пропажу денег, хотя крупные «красивые» суммы выглядят правильно.
    for (const amount of [0, 1, 2, 3, 7, 99, 10_000]) {
      for (let tax = 0; tax <= 100; tax++) {
        const split = tipSplit(amount, tax);
        assert.equal(split.debit, amount);
        assert.equal(split.credit + split.burned, amount);
        assert.equal(split.credit, Math.floor((amount * (100 - tax)) / 100));
      }
    }
  });

  it('некорректные дробные суммы и налоги прижимаются к безопасным целым границам', () => {
    assert.deepEqual(tipSplit(-2.9, -1), { debit: 0, credit: 0, burned: 0 });
    assert.deepEqual(tipSplit(5.9, 101.2), { debit: 5, credit: 0, burned: 5 });
  });
});
