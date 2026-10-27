import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { botUsernameError, botsEnabled, DEFAULT_BOT_SETTINGS, BOT_PER_USER_LIMIT_MAX, BOT_TOKEN_PREFIX } from './bots.js';

describe('боты: общие правила имён и совместимости', () => {
  it('bot — минимальный ник, 32 символа и смешанный регистр суффикса принимаются', () => {
    for (const name of ['bot', 'BOT', 'a_BoT', '0_bot', `${'a'.repeat(29)}bot`]) assert.equal(botUsernameError(name), null, name);
  });

  it('имя длиннее 32, короткое, кириллица, пробел и посторонние знаки отвергаются', () => {
    for (const name of ['', 'bo', `${'a'.repeat(30)}bot`, 'гусьbot', 'a bot', 'a-bot', 'ab.bot', ' bot']) {
      assert.equal(botUsernameError(name), 'Ник: 3–32 символа, латиница, цифры и _', JSON.stringify(name));
    }
  });

  it('корректный человеческий ник без конечного bot не становится ботом', () => {
    for (const name of ['alice', 'bot_a', 'botbotx']) assert.equal(botUsernameError(name), 'Ник бота должен оканчиваться на bot');
    assert.equal(botUsernameError('alicebot'), null);
  });

  it('новый инстанс поставляется с выключенными ботами и безопасными пределами', () => {
    assert.deepEqual(DEFAULT_BOT_SETTINGS, { enabled: false, creators: 'all', perUserLimit: 10, allowInternalWebhooks: false });
    assert.equal(BOT_PER_USER_LIMIT_MAX, 100);
    assert.equal(BOT_TOKEN_PREFIX, 'gvb_');
  });

  it('клиент выключает ботов только по явному false, старый ответ без поля остаётся совместимым', () => {
    assert.equal(botsEnabled({ enabled: false }), false);
    for (const response of [{ enabled: true }, {}, null, undefined]) assert.equal(botsEnabled(response), true);
    // У серверной нормализации и клиентской совместимости намеренно разные умолчания.
    assert.equal(botsEnabled(DEFAULT_BOT_SETTINGS), false);
  });
});
