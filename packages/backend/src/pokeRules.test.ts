import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  POKE_COOLDOWN_MS,
  POKE_MAX_LEN,
  pokeBlock,
  pokeCooldownKey,
  pokeMessage,
  pokeReceiveKey,
  POKE_BLOCK_TEXT,
  POKE_RECEIVE_LIMIT,
  type PokeInput,
} from './pokeRules.js';

const allowed = (patch: Partial<PokeInput> = {}): PokeInput => ({
  fromUserId: 'from',
  toUserId: 'to',
  allowed: true,
  targetInChannel: true,
  targetDnd: false,
  onCooldown: false,
  targetOptedOut: false,
  targetReceived: 0,
  ...patch,
});

describe('ограничения громкого действия', () => {
  it('кулдаун остаётся полминуты, а сообщение — не длиннее ста символов', () => {
    // Ловит рассинхрон чисел с пользовательским текстом «подожди полминуты» и назначением короткого окрика.
    assert.equal(POKE_COOLDOWN_MS, 30_000);
    assert.equal(POKE_MAX_LEN, 100);
  });
});

describe('ключ кулдауна тыка', () => {
  it('различает и отправителя, и получателя, и направление пары', () => {
    // Ловит оба перекоса: запрет позвать двоих подряд и возможность толпе обходить кулдаун жертвы.
    const first = pokeCooldownKey('alice', 'bob');
    assert.notEqual(first, pokeCooldownKey('alice', 'carol'));
    assert.notEqual(first, pokeCooldownKey('carol', 'bob'));
    assert.notEqual(first, pokeCooldownKey('bob', 'alice'));
  });
});

describe('сообщение тыка', () => {
  it('отсутствующий и пробельный текст остаётся валидным пустым тыком', () => {
    // Ловит превращение необязательной подписи в обязательное сообщение.
    assert.equal(pokeMessage(undefined), '');
    assert.equal(pokeMessage(' \n\t '), '');
  });

  it('крайние и повторные пробелы с переводами строк схлопываются', () => {
    // Ловит растягивание модального окна пачкой невидимых переносов.
    assert.equal(pokeMessage('  зайди\n\n\tв голос  '), 'зайди в голос');
  });

  it('ровно предельная длина проходит без обрезания', () => {
    // Ловит ошибку на единицу, съедающую последний допустимый символ.
    const message = 'x'.repeat(POKE_MAX_LEN);
    assert.equal(pokeMessage(message), message);
  });

  it('лишний символ после предела отрезается', () => {
    // Ловит отправку длинного текста в громкую модалку вместо короткого окрика.
    assert.equal(pokeMessage(`${'x'.repeat(POKE_MAX_LEN)}y`), 'x'.repeat(POKE_MAX_LEN));
  });

  it('ровно сто эмодзи проходят как сто символов, а не двести code units', () => {
    // Регрессия Unicode-границы: UTF-16 длина раньше преждевременно обрезала корректный текст вдвое.
    const message = '😀'.repeat(POKE_MAX_LEN);
    assert.equal(pokeMessage(message), message);
  });

  it('сто первый Unicode-символ отрезается без половины суррогатной пары', () => {
    // Ловит replacement-character в конце модалки после slice по code units на смешанной строке.
    const message = `a${'😀'.repeat(POKE_MAX_LEN)}`;
    const result = pokeMessage(message);
    assert.equal(result, `a${'😀'.repeat(POKE_MAX_LEN - 1)}`);
    assert.equal(Array.from(result).length, POKE_MAX_LEN);
  });
});

describe('причина блокировки тыка', () => {
  it('разрешённый свежий тык человеку в канале проходит', () => {
    // Парный успешный путь не даёт защитным веткам случайно запретить всю функцию.
    assert.equal(pokeBlock(allowed()), null);
  });

  it('попытка ткнуть себя скрывает все последующие причины', () => {
    // Ловит утечку DND или кулдауна через более позднюю проверку заведомо запрещённого действия.
    assert.equal(pokeBlock(allowed({ toUserId: 'from', allowed: false, targetDnd: true, onCooldown: true })), 'self');
  });

  it('отсутствие права проверяется раньше статуса и присутствия цели', () => {
    // Ловит раскрытие состояния чужого пользователя тому, кто вообще не может его тыкать.
    assert.equal(pokeBlock(allowed({ allowed: false, targetInChannel: false, targetDnd: true, onCooldown: true })), 'forbidden');
  });

  it('человек вне голосового канала отклоняется до DND и кулдауна', () => {
    // Ловит превращение тыка в замену личным сообщениям для людей вне голоса.
    assert.equal(pokeBlock(allowed({ targetInChannel: false, targetDnd: true, onCooldown: true })), 'not-in-voice');
  });

  it('режим «не беспокоить» приоритетнее живого кулдауна', () => {
    // Ловит предложение «подожди» там, где тык в принципе не должен звучать.
    assert.equal(pokeBlock(allowed({ targetDnd: true, onCooldown: true })), 'dnd');
  });

  it('повторный разрешённый тык блокируется кулдауном', () => {
    // Ловит возможность спамить модальным окном одного и того же человека без паузы.
    assert.equal(pokeBlock(allowed({ onCooldown: true })), 'cooldown');
  });
});

describe('защита получателя от наплыва', () => {
  it('🔴 личный выключатель сильнее права тыкать', () => {
    // Право даёт владелец сервера, а страдает конкретный человек. Последнее слово — за ним (#122).
    assert.equal(pokeBlock(allowed({ targetOptedOut: true })), 'opted-out');
  });

  it('потолок ловит наплыв толпы, где каждый формально в своём праве', () => {
    // Кулдаун стоит на ПАРЕ «кто→кого», поэтому пятнадцать разных людей проходили его свободно.
    assert.equal(pokeBlock(allowed({ targetReceived: POKE_RECEIVE_LIMIT })), 'flooded');
    assert.equal(pokeBlock(allowed({ targetReceived: POKE_RECEIVE_LIMIT - 1 })), null);
  });

  it('обе причины отказа звучат ОДИНАКОВО и ничего не выдают', () => {
    // Скажи «он тебя отключил» — и выключатель сам станет поводом для травли; скажи «его уже
    // задолбали» — и подскажешь, что можно продолжить с другого аккаунта.
    assert.equal(POKE_BLOCK_TEXT['opted-out'], POKE_BLOCK_TEXT.flooded);
  });

  it('порядок: право и «не беспокоить» проверяются раньше защиты получателя', () => {
    // Иначе отправитель без права узнавал бы по отказу чужие настройки.
    assert.equal(pokeBlock(allowed({ allowed: false, targetOptedOut: true })), 'forbidden');
    assert.equal(pokeBlock(allowed({ targetDnd: true, targetOptedOut: true })), 'dnd');
  });

  it('защита получателя проверяется РАНЬШЕ кулдауна отправителя', () => {
    // Отправителю важнее «сейчас нельзя вообще», чем «ты поторопился».
    assert.equal(pokeBlock(allowed({ onCooldown: true, targetOptedOut: true })), 'opted-out');
  });

  it('ключ счётчика — по получателю, отправитель в нём не участвует', () => {
    assert.equal(pokeReceiveKey('bob'), 'pokercv:bob');
    assert.notEqual(pokeCooldownKey('a', 'bob'), pokeReceiveKey('bob'));
  });
});
