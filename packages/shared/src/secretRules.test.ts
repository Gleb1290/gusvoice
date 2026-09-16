import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstPlaceholderSecret, isPlaceholderSecret } from './secretRules.js';

describe('секрет-заглушка', () => {
  it('узнаёт change-me с дефисом, подчёркиванием, пробелом и любым регистром', () => {
    // Ловит копирование очевидной публичной подсказки из env-шаблона в рабочий конфиг.
    for (const value of ['change-me', 'CHANGE_ME', 'change me', '  Change-Me-Later  ']) {
      assert.equal(isPlaceholderSecret(value), true, value);
    }
  });

  it('заглушка из .env.example обязательно считается небезопасной', () => {
    // Регрессия О5: именно эту публично известную строку пользователь получает при копировании шаблона.
    assert.equal(isPlaceholderSecret('change-me-with-openssl-rand-hex-32'), true);
  });

  it('пустое и отсутствующее значение не подменяют отдельную ошибку required', () => {
    // Иначе при незаданной переменной сервер покажет неверную причину отказа.
    assert.equal(isPlaceholderSecret(''), false);
    assert.equal(isPlaceholderSecret('   '), false);
    assert.equal(isPlaceholderSecret(undefined), false);
  });

  it('настоящий случайный hex не принимается за подсказку', () => {
    // Парный успешный случай не даёт защите запретить корректно настроенный сервер.
    assert.equal(isPlaceholderSecret('d4e5f60718293a4b5c6d7e8f9012abcd'), false);
  });
});

describe('поиск первой заглушки', () => {
  it('пропускает настоящие и пустые значения, сохраняя порядок ключей', () => {
    // Ловит недетерминированный текст запуска: оператор должен чинить первую переменную по конфигу.
    assert.equal(
      firstPlaceholderSecret({
        JWT_SECRET: 'd4e5f60718293a4b5c6d7e8f9012abcd',
        OPTIONAL_SECRET: '',
        LIVEKIT_API_SECRET: 'CHANGE_ME',
        FEDERATION_SECRET: 'change-me-too',
      }),
      'LIVEKIT_API_SECRET',
    );
  });

  it('возвращает null, когда все заданные секреты настоящие', () => {
    // Парный чистый путь не даёт стражу ронять правильно настроенный инстанс.
    assert.equal(
      firstPlaceholderSecret({ JWT_SECRET: 'real-secret', LIVEKIT_API_SECRET: undefined }),
      null,
    );
  });
});
