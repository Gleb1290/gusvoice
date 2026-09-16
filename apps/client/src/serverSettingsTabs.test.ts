import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Permission } from '@gusvoice/shared';
import { canOpenServerSettings, serverSettingsTabs } from './serverSettingsTabs.js';

const keys = (p: bigint) => serverSettingsTabs(p).map((t) => t.key);

/**
 * Регрессия на найденный тестером баг: право на эмодзи/стикеры давало вкладку внутри настроек,
 * но НЕ давало самого пункта «Настройки сервера» — до вкладки было не добраться.
 *
 * Поэтому главная проверка здесь — не «какие вкладки», а «дверь открывается ровно тогда, когда
 * есть что показать».
 */
describe('вкладки настроек сервера', () => {
  it('без прав вкладок нет и пункта меню нет', () => {
    assert.deepEqual(keys(0n), []);
    assert.equal(canOpenServerSettings(0n), false);
  });

  it('каждое право в одиночку открывает свою вкладку И пункт меню', () => {
    const пары: [bigint, string][] = [
      [Permission.MANAGE_SERVER, 'general'],
      [Permission.MANAGE_CHANNELS, 'general'],
      [Permission.BAN_MEMBERS, 'bans'],
      [Permission.MANAGE_EMOJIS, 'emoji'],
      [Permission.MANAGE_STICKERS, 'stickers'],
      [Permission.MANAGE_SOUNDS, 'sounds'],
      [Permission.MANAGE_SOUNDBOARD, 'soundboard'],
      [Permission.VIEW_AUDIT_LOG, 'audit'],
    ];
    for (const [perm, tab] of пары) {
      assert.deepEqual(keys(perm), [tab], `право ${tab} должно давать ровно свою вкладку`);
      assert.equal(canOpenServerSettings(perm), true, `право ${tab} должно открывать пункт меню`);
    }
  });

  /**
 * 🔴 Права на звуки и на саундборд РАЗВЕДЕНЫ (требование 03.09): звук уведомления человек слышит
   * по случаю, а сэмпл саундборда кто угодно проигрывает всему каналу по своему желанию.
   * ⚠️ Проверяется в обе стороны. Одностороннюю проверку прошла бы и реализация, где саундборд
   * открывается ЛЮБЫМ из двух прав, — а это ровно то разведение, которого не случилось бы.
   */
  it('🔴 звуки и саундборд не открывают вкладки друг друга', () => {
    assert.deepEqual(keys(Permission.MANAGE_SOUNDS), ['sounds']);
    assert.deepEqual(keys(Permission.MANAGE_SOUNDBOARD), ['soundboard']);
  });

  it('права на эмодзи достаточно — это и был баг', () => {
    assert.equal(canOpenServerSettings(Permission.MANAGE_EMOJIS), true);
  });

  it('право, не дающее ни одной вкладки, пункт меню НЕ открывает', () => {
    // Парное «не открывается»: иначе тест выше проходил бы и у функции «всегда true».
    assert.equal(canOpenServerSettings(Permission.KICK_MEMBERS), false);
    assert.equal(canOpenServerSettings(Permission.SEND_MESSAGES | Permission.CONNECT), false);
  });

  it('MANAGE_CHANNELS тоже открывает «Основное» — там живут категории', () => {
    // Роуты категорий требуют именно MANAGE_CHANNELS. Пока вкладка висела на одном MANAGE_SERVER,
    // выходило две беды сразу: один видел редактор и ловил 403, другой не мог войти вообще.
    assert.deepEqual(keys(Permission.MANAGE_CHANNELS), ['general']);
    assert.equal(canOpenServerSettings(Permission.MANAGE_CHANNELS), true);
  });

  it('оба права на «Основное» не двоят вкладку', () => {
    assert.deepEqual(keys(Permission.MANAGE_SERVER | Permission.MANAGE_CHANNELS), ['general']);
  });

  it('несколько прав дают несколько вкладок в объявленном порядке', () => {
    assert.deepEqual(keys(Permission.MANAGE_SOUNDS | Permission.MANAGE_EMOJIS), ['emoji', 'sounds']);
    assert.deepEqual(keys(Permission.VIEW_AUDIT_LOG | Permission.MANAGE_SERVER), ['general', 'audit']);
  });

  it('администратор видит все вкладки', () => {
    // has() пропускает ADMINISTRATOR мимо любых битов — значит и здесь обязан.
    // ⚠️ Число обновляется при КАЖДОЙ новой вкладке (последняя — «Саундборд», #21). Так и задумано:
    // тест обязан падать, чтобы про вход в новую вкладку нельзя было забыть — ровно ради этого
    // список вкладок и свели в один модуль. Он и упал, когда вкладка появилась.
    assert.equal(keys(Permission.ADMINISTRATOR).length, 8);
  });

  it('первая вкладка — стартовая, и у неё есть подпись', () => {
    const [first] = serverSettingsTabs(Permission.MANAGE_EMOJIS | Permission.VIEW_AUDIT_LOG);
    assert.equal(first.key, 'emoji');
    assert.equal(typeof first.label, 'string');
    assert.equal(first.label.length > 0, true);
  });
});
