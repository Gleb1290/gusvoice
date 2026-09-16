import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  lockoutSeconds,
  lockTriggered,
  loginKey,
  MAX_FAILS,
  REFRESH_AFTER_S,
  retryAfter,
  retryMessage,
  shouldRefresh,
  TOKEN_TIMING,
  TOKEN_TTL_S,
} from './authRules.js';

describe('продление токена по активности', () => {
  it('публичные тайминги закрепляют сутки до refresh и восемь суток TTL', () => {
    // Ловит рассинхрон констант, документации и решения о продлении токена.
    assert.equal(REFRESH_AFTER_S, 24 * 3600);
    assert.equal(TOKEN_TTL_S, 8 * 24 * 3600);
    assert.deepEqual(TOKEN_TIMING, { ttlSeconds: TOKEN_TTL_S, refreshAfterSeconds: REFRESH_AFTER_S });
  });

  it('отсутствующий и нулевой iat не продлеваются', () => {
    // Ловит бесконечное обновление старого токена, у которого нечем измерить возраст.
    assert.equal(shouldRefresh(undefined, 100_000), false);
    assert.equal(shouldRefresh(0, 100_000), false);
  });

  it('iat из будущего не считается старым при разъехавшихся часах', () => {
    // Ловит выпуск нового токена на каждом запросе при отрицательном возрасте.
    assert.equal(shouldRefresh(100_001, 100_000), false);
  });

  it('секунда до порога не продлевает, а ровно порог уже продлевает', () => {
    // Ловит ошибку на включительной суточной границе refresh.
    const issued = 10_000;
    assert.equal(shouldRefresh(issued, issued + REFRESH_AFTER_S - 1), false);
    assert.equal(shouldRefresh(issued, issued + REFRESH_AFTER_S), true);
  });
});

describe('фиксированное окно rate limit', () => {
  it('значение до лимита и ровно лимит не требуют ожидания', () => {
    // Ловит преждевременную блокировку законного последнего запроса окна.
    assert.equal(retryAfter(4, 5, 30, 60), 0);
    assert.equal(retryAfter(5, 5, 30, 60), 0);
  });

  it('после лимита возвращается положительный остаток Redis TTL', () => {
    // Ловит подмену реального остатка полным окном и лишнее ожидание пользователя.
    assert.equal(retryAfter(6, 5, 17, 60), 17);
  });

  it('нулевой и служебные отрицательные TTL заменяются полным окном', () => {
    // Ловит сообщения «ждите -1 секунду» для ключа без TTL или уже исчезнувшего ключа.
    assert.equal(retryAfter(6, 5, 0, 60), 60);
    assert.equal(retryAfter(6, 5, -1, 60), 60);
    assert.equal(retryAfter(6, 5, -2, 60), 60);
  });

  it('сообщение округляет ожидание вверх и никогда не обещает меньше минуты', () => {
    // Ловит преждевременное обещание разблокировки на неполной следующей минуте.
    assert.equal(retryMessage(0), 'Слишком много попыток. Попробуйте через 1 мин.');
    assert.equal(retryMessage(60), 'Слишком много попыток. Попробуйте через 1 мин.');
    assert.equal(retryMessage(61), 'Слишком много попыток. Попробуйте через 2 мин.');
  });
});

describe('ступенчатый lockout пароля', () => {
  it('ключ различает IP и нормализует регистр имени', () => {
    // Ловит как общий lockout для разных адресов, так и обход счётчика сменой регистра логина.
    assert.equal(loginKey('203.0.113.7', 'MaSha'), '203.0.113.7:masha');
    assert.notEqual(loginKey('203.0.113.8', 'masha'), loginKey('203.0.113.7', 'masha'));
  });

  it('блокировка включается ровно на MAX_FAILS', () => {
    // Ловит ошибку на единицу, ослабляющую brute-force или запирающую раньше срока.
    assert.equal(lockTriggered(MAX_FAILS - 1), false);
    assert.equal(lockTriggered(MAX_FAILS), true);
  });

  it('первые три ступени дают 15, 30 и 45 минут', () => {
    // Ловит потерю эскалации наказания после повторных серий неверных паролей.
    assert.deepEqual([lockoutSeconds(1), lockoutSeconds(2), lockoutSeconds(3)], [900, 1_800, 2_700]);
  });
});
