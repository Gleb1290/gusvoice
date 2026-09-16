import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUY_BLOCK_TEXT,
  SHOP_CATALOG,
  animatedAvatarFor,
  avatarMinutesFor,
  avatarPriceAllowed,
  avatarRentalActive,
  avatarRentalUntil,
  SHOP_ITEMS,
  buyBlock,
  buyCooldownKey,
  minutesForPrice,
  priceCoins,
  shopItem,
  type BuyInput,
} from './shopRules.js';

const spec = SHOP_CATALOG['mega-poke'];

const input = (patch: Partial<BuyInput> = {}): BuyInput => ({
  item: spec,
  buyerId: 'buyer',
  targetId: 'target',
  economyEnabled: true,
  itemEnabled: true,
  buyerInVoice: true,
  targetInVoice: true,
  buyerOptedOut: false,
  targetOptedOut: false,
  targetDnd: false,
  targetGotToday: 0,
  targetDailyLimit: 3,
  onCooldown: false,
  alreadyOwned: false,
  balance: 1000,
  price: 90,
  ...patch,
});

describe('цена награды в минутах сидения', () => {
  it('минуты переводятся в монеты по текущей ставке', () => {
    // Ставка 10 монет за 5 минут → 45 минут стоят 90 монет.
    assert.equal(priceCoins(45, 10), 90);
    assert.equal(priceCoins(5, 10), 10, 'ровно один период ставки');
  });

  it('🔴 подъём ставки НЕ ломает прайс — цена в монетах едет вместе с ней', () => {
    // Ровно та причина, по которой цена хранится в минутах: награда как стоила вечер, так и стоит.
    const minutes = 45;
    assert.equal(priceCoins(minutes, 10), 90);
    assert.equal(priceCoins(minutes, 20), 180);
    assert.equal(priceCoins(minutes, 5), 45);
  });

  it('округляет ВВЕРХ — дешёвая награда не проваливается в бесплатную', () => {
    // 1 минута при ставке 1/5мин честно даёт 0.2 монеты; вниз это был бы ноль, то есть дыра в стоке.
    assert.equal(priceCoins(1, 1), 1);
    assert.equal(priceCoins(7, 3), 5, '7*60*3/300 = 4.2 → 5');
  });

  it('нулевая ставка или нулевая цена дают ноль честно, а не NaN', () => {
    assert.equal(priceCoins(45, 0), 0);
    assert.equal(priceCoins(0, 10), 0);
    assert.equal(priceCoins(-5, 10), 0);
  });

  it('обратный пересчёт показывает, сколько сидеть ради награды', () => {
    assert.equal(minutesForPrice(90, 10), 45);
    assert.equal(minutesForPrice(1, 10), 1, 'даже копеечная награда — это минута, а не ноль');
    assert.equal(minutesForPrice(90, 0), 0, 'начисления нет — окупать нечем');
  });
});

describe('каталог', () => {
  it('ключ из внешнего мира не проходит мимо каталога', () => {
    assert.equal(shopItem('mega-poke')?.key, 'mega-poke');
    assert.equal(shopItem('mega-poke '), null, 'без нормализации — строку присылает клиент');
    assert.equal(shopItem('__proto__'), null, 'и наследованные ключи объекта тоже не позиции');
    assert.equal(shopItem('constructor'), null);
  });

  it('у каждой позиции есть цена, подпись и осмысленный адресат', () => {
    for (const key of SHOP_ITEMS) {
      const s = SHOP_CATALOG[key];
      assert.ok(s.defaultMinutes > 0, `${key}: бесплатная награда по умолчанию — это дыра`);
      assert.ok(s.label.length > 0 && s.hint.length > 0, `${key}: без подписи в каталоге не показать`);
      assert.ok(s.durationMinutes >= 0);
    }
  });

  it('на каждую причину отказа есть человеческий текст', () => {
    // Забытый текст = пустой отказ в интерфейсе; типы этого не ловят, потому что ключ строковый.
    for (const reason of Object.keys(BUY_BLOCK_TEXT)) {
      assert.ok(BUY_BLOCK_TEXT[reason as keyof typeof BUY_BLOCK_TEXT].length > 0, reason);
    }
  });
});

describe('можно ли купить', () => {
  it('всё в порядке — покупка разрешена', () => {
    assert.equal(buyBlock(input()), null);
  });

  it('порядок проверок: неденежное раньше денежного', () => {
    // Иначе по коду отказа выясняли бы чужой баланс там, где действие вообще запрещено.
    assert.equal(buyBlock(input({ economyEnabled: false, balance: 0 })), 'disabled');
    assert.equal(buyBlock(input({ itemEnabled: false, balance: 0 })), 'item-off');
    assert.equal(buyBlock(input({ targetId: 'buyer', balance: 0 })), 'self');
    assert.equal(buyBlock(input({ targetInVoice: false, balance: 0 })), 'not-together');
  });

  /**
   * 🔴 Пробел, найденный Codex: свой отказ от экономики не подавался НИ ОДНИМ тестом — удаление
   * этой защиты прошло бы зелёным.
   *
   * ⚠️ Проверяется не только сам отказ, но и его МЕСТО в очереди: он должен срабатывать раньше
   * причин про адресата и про деньги. Иначе по коду отказа можно было бы выяснять чужое состояние
   * там, где действие и так запрещено.
   */
  it('🔴 свой отказ от экономики закрывает покупку и идёт раньше остальных причин', () => {
    assert.equal(buyBlock(input({ buyerOptedOut: true })), 'self-opted-out');
    assert.equal(
      buyBlock(input({ buyerOptedOut: true, targetOptedOut: true, targetDnd: true, balance: 0, price: 90 })),
      'self-opted-out',
    );
    // Но НЕ раньше выключенной экономики и снятой с продажи позиции: это состояние сервера, а не
    // человека, и оно первично.
    assert.equal(buyBlock(input({ buyerOptedOut: true, economyEnabled: false })), 'disabled');
    assert.equal(buyBlock(input({ buyerOptedOut: true, itemEnabled: false })), 'item-off');
  });

  /**
   * 🔴 «Уже есть» стоит ДО денег. Списать за то, что у человека уже куплено, — худший вид отказа,
   * потому что он не отказ: монеты ушли, нового не появилось.
   * ⚠️ Проверяется и обратное: расходник с `alreadyOwned: false` не должен нечаянно попасть под это
   * правило — иначе оно молча запретило бы повторные покупки всего подряд.
   */
  it('🔴 уже купленное не покупается второй раз, и это решается раньше денег', () => {
    assert.equal(buyBlock(input({ alreadyOwned: true })), 'already-owned');
    assert.equal(buyBlock(input({ alreadyOwned: true, balance: 0 })), 'already-owned');
    assert.equal(buyBlock(input({ alreadyOwned: false })), null);
  });

  it('🔴 нулевая цена — отказ, а не подарок', () => {
    // МЕГА пок без цены превращается в тык без кулдауна: цена и есть тормоз.
    assert.equal(buyBlock(input({ price: 0 })), 'free');
    assert.equal(buyBlock(input({ price: -10 })), 'free');
  });

  it('адресная награда без адресата не покупается', () => {
    assert.equal(buyBlock(input({ targetId: null })), 'no-target');
  });

  it('награда без адресата не требует ни адресата, ни совместного присутствия', () => {
    const cosmetic = { ...spec, target: 'none' as const };
    assert.equal(
      buyBlock(input({ item: cosmetic, targetId: null, buyerInVoice: false, targetInVoice: false })),
      null,
    );
  });

  /**
   * Канальная награда — третий вид: адресата нет, но стрелять можно только оттуда, где сидишь.
   * ⚠️ `targetInVoice: false` намеренно: у канальной награды адресата нет, и присутствие
   * несуществующего человека не должно на неё влиять НИКАК.
   */
  it('канальная награда требует своего присутствия и не смотрит на адресата', () => {
    const shot = { ...spec, target: 'channel' as const };
    assert.equal(
      buyBlock(input({ item: shot, targetId: null, buyerInVoice: false, targetInVoice: false })),
      'not-in-voice',
    );
    assert.equal(
      buyBlock(input({ item: shot, targetId: null, buyerInVoice: true, targetInVoice: false })),
      null,
    );
  });

  /**
   * 🔴 Разделение `together` на два поля затевалось ради этого случая: адресной награде мало, чтобы
   * в канале сидел кто-то один. Отсутствие ЛЮБОЙ из сторон — отказ.
   */
  it('адресной награде мало присутствия одной стороны', () => {
    assert.equal(buyBlock(input({ buyerInVoice: false, targetInVoice: true })), 'not-together');
    assert.equal(buyBlock(input({ buyerInVoice: true, targetInVoice: false })), 'not-together');
  });

  it('отказ адресата и кулдаун проверяются до баланса', () => {
    assert.equal(buyBlock(input({ targetOptedOut: true, balance: 0 })), 'target-opted-out');
    assert.equal(buyBlock(input({ onCooldown: true, balance: 0 })), 'cooldown');
  });

  it('🔴 «не беспокоить» не пробивается за деньги', () => {
    // Тишину не продаём: купленное право мешать человеку — ровно то, чего в экономике быть не должно.
    assert.equal(buyBlock(input({ targetDnd: true, balance: 100000 })), 'target-dnd');
  });

  it('у получателя свой суточный предел, и он не про деньги', () => {
    // Цена сдерживает кошельком, но у того, кто много сидит, монет всегда достаточно.
    assert.equal(buyBlock(input({ targetGotToday: 3, targetDailyLimit: 3 })), 'target-full');
    assert.equal(buyBlock(input({ targetGotToday: 2, targetDailyLimit: 3 })), null);
    assert.equal(buyBlock(input({ targetGotToday: 99, targetDailyLimit: 0 })), null, '0 — предел выключен');
  });

  it('предел получателя не действует на безадресные награды', () => {
    // Салют на весь канал никому персонально не адресован — считать ему «полученное» нечем.
    const salute = { ...spec, target: 'none' as const };
    assert.equal(buyBlock(input({ item: salute, targetId: null, targetGotToday: 99, targetDailyLimit: 3 })), null);
  });

  it('не хватает монет — последняя причина', () => {
    assert.equal(buyBlock(input({ balance: 89, price: 90 })), 'poor');
    assert.equal(buyBlock(input({ balance: 90, price: 90 })), null, 'ровно хватает — это хватает');
  });
});

describe('ключ кулдауна', () => {
  it('адресная награда считает пару, безадресная — только покупателя', () => {
    assert.equal(buyCooldownKey('mega-poke', 'a', 'b'), 'buy:mega-poke:a:b');
    assert.equal(buyCooldownKey('mega-poke', 'a', null), 'buy:mega-poke:a');
  });

  it('пара направленная: «я ему» и «он мне» — разные кулдауны', () => {
    assert.notEqual(buyCooldownKey('mega-poke', 'a', 'b'), buyCooldownKey('mega-poke', 'b', 'a'));
  });
});

describe('аренда анимированного аватара', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('первая покупка даёт 30 дней от сегодня', () => {
    assert.equal(avatarRentalUntil(null, now).getTime(), now.getTime() + 30 * day);
  });

  it('покупка за день до конца ПРОДЛЕВАЕТ, а не обнуляет', () => {
    // Обнуление наказывало бы за то, что человек продлил заранее, — то есть ровно за аккуратность.
    const until = new Date(now.getTime() + day);
    assert.equal(avatarRentalUntil(until, now).getTime(), until.getTime() + 30 * day);
  });

  it('просроченная аренда начинается заново от сегодня, а не от даты окончания', () => {
    const expired = new Date(now.getTime() - 100 * day);
    assert.equal(avatarRentalUntil(expired, now).getTime(), now.getTime() + 30 * day);
  });

  it('действует строго ДО срока: в момент окончания уже нет', () => {
    assert.equal(avatarRentalActive(new Date(now.getTime() + 1), now), true);
    assert.equal(avatarRentalActive(now, now), false);
    assert.equal(avatarRentalActive(null, now), false);
  });

  it('истёкшая аренда прячет анимацию, но ССЫЛКУ не стирает', () => {
    // Ровно та дыра, что нашлась 05.09: проверка стояла в одном сериализаторе из двух, и у всех,
    // кроме самого покупателя, анимация не гасла никогда.
    const url = 'https://minio/gusvoice/avatars/u1-anim-1.gif';
    assert.equal(animatedAvatarFor(url, new Date(now.getTime() + day), now), url);
    assert.equal(animatedAvatarFor(url, new Date(now.getTime() - day), now), null);
    assert.equal(animatedAvatarFor(url, null, now), null);
  });

  it('нет анимации — нет и ссылки, даже при живой аренде', () => {
    // Оплаченная, но не залитая анимация: `undefined` наружу уходить не должен.
    assert.equal(animatedAvatarFor(null, new Date(now.getTime() + day), now), null);
    assert.equal(animatedAvatarFor(undefined, new Date(now.getTime() + day), now), null);
  });
});

describe('цена аватара на сервере: своя, но не ниже инстанса (14.09)', () => {
  /** Своей цены нет — действует пол инстанса. Так живёт любой сервер, где владелец цену не трогал. */
  it('без своей цены сервера — цена инстанса', () => {
    assert.equal(avatarMinutesFor(1500, null), 1500);
    assert.equal(avatarMinutesFor(1500, undefined), 1500);
  });

  it('наценка владельца выше пола — действует наценка', () => {
    assert.equal(avatarMinutesFor(1500, 3000), 3000);
  });

  /**
   * 🔴 Главная проверка правила. Цена сервера НИЖЕ пола обязана проигрывать полу — иначе владелец
   * обошёл бы инстанс одной записью в каталог, ради чего строку сервера раньше игнорировали целиком.
   */
  it('цена сервера ниже пола — действует пол, а не она', () => {
    assert.equal(avatarMinutesFor(1500, 500), 1500);
    assert.equal(avatarMinutesFor(1500, 0), 1500);
  });

  /**
   * ⚠️ Пол могут ПОДНЯТЬ после того, как владелец назначил свою цену. Его прежнее число оказывается
   * ниже нового пола — и выиграть обязан пол, без правок в базе. Поэтому `max`, а не «сервер, если есть».
   */
  it('пол подняли выше прежней наценки — выигрывает новый пол', () => {
    assert.equal(avatarMinutesFor(4000, 3000), 4000);
  });

  it('пол опустили — наценка владельца остаётся его решением', () => {
    assert.equal(avatarMinutesFor(1000, 3000), 3000);
  });

  it('мусор вместо цены сервера не ломает цену, а даёт пол', () => {
    assert.equal(avatarMinutesFor(1500, Number.NaN), 1500);
  });

  it('дробные минуты не создают цену между целыми', () => {
    assert.equal(avatarMinutesFor(1500.9, 3000.7), 3000);
  });
});

describe('можно ли сохранить цену аватара (14.09)', () => {
  /** ⚠️ «Не ниже», а не «выше»: ровно цена инстанса — законная цена сервера. */
  it('ровно пол — можно', () => {
    assert.equal(avatarPriceAllowed(1500, 1500), true);
  });

  it('выше пола — можно', () => {
    assert.equal(avatarPriceAllowed(1500, 3000), true);
  });

  it('на минуту ниже пола — нельзя', () => {
    assert.equal(avatarPriceAllowed(1500, 1499), false);
  });

  it('ноль при ненулевом полу — нельзя: это «даром» в обход инстанса', () => {
    assert.equal(avatarPriceAllowed(1500, 0), false);
  });

  it('при нулевом полу инстанса ноль законен', () => {
    assert.equal(avatarPriceAllowed(0, 0), true);
  });
});
