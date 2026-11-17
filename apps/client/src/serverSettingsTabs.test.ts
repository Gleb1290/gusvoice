import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { Permission } from '@gusvoice/shared';
import { canOpenServerSettings, serverSettingsHas, serverSettingsTabs } from './serverSettingsTabs.js';

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
      [Permission.MANAGE_CHANNELS, 'general'],
      [Permission.BAN_MEMBERS, 'bans'],
      [Permission.MANAGE_EMOJIS, 'emoji'],
      [Permission.MANAGE_STICKERS, 'stickers'],
      [Permission.MANAGE_SOUNDS, 'sounds'],
      [Permission.MANAGE_SOUNDBOARD, 'soundboard'],
      [Permission.MANAGE_WEBHOOKS, 'integrations'],
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
    // KICK_MEMBERS здесь больше не годится: с 23.09 он открывает раздел «Участники» (кик живёт там).
    assert.equal(canOpenServerSettings(Permission.MOVE_MEMBERS), false);
    assert.equal(canOpenServerSettings(Permission.SEND_MESSAGES | Permission.CONNECT), false);
  });

  it('MANAGE_CHANNELS тоже открывает «Основное» — там живут категории', () => {
    // Роуты категорий требуют именно MANAGE_CHANNELS. Пока вкладка висела на одном MANAGE_SERVER,
    // выходило две беды сразу: один видел редактор и ловил 403, другой не мог войти вообще.
    assert.deepEqual(keys(Permission.MANAGE_CHANNELS), ['general']);
    assert.equal(canOpenServerSettings(Permission.MANAGE_CHANNELS), true);
  });

  it('оба права на «Основное» не двоят вкладку', () => {
    assert.deepEqual(keys(Permission.MANAGE_SERVER | Permission.MANAGE_CHANNELS), ['general', 'soundboard', 'integrations']);
  });

  it('несколько прав дают несколько вкладок в объявленном порядке', () => {
    assert.deepEqual(keys(Permission.MANAGE_SOUNDS | Permission.MANAGE_EMOJIS), ['emoji', 'sounds']);
    assert.deepEqual(keys(Permission.VIEW_AUDIT_LOG | Permission.MANAGE_SERVER), ['general', 'soundboard', 'integrations', 'audit']);
  });

  it('администратор видит все вкладки', () => {
    // has() пропускает ADMINISTRATOR мимо любых битов — значит и здесь обязан.
    // ⚠️ Число обновляется при КАЖДОЙ новой вкладке (последняя — «Интеграции», R279: вебхуки).
    // Так и задумано: тест обязан падать, чтобы про
    // вход в новую вкладку нельзя было забыть — ровно ради этого список вкладок и свели в один модуль.
    assert.equal(keys(Permission.ADMINISTRATOR).length, 11);
  });

  it('первая вкладка — стартовая, и у неё есть подпись', () => {
    const [first] = serverSettingsTabs(Permission.MANAGE_EMOJIS | Permission.VIEW_AUDIT_LOG);
    assert.equal(first.key, 'emoji');
    assert.equal(typeof first.label, 'string');
    assert.equal(first.label.length > 0, true);
  });

  it('кик в одиночку открывает только участников, а управление ролями — роли и участников', () => {
    // Ловит старую дверь 👥, которая не пускала к списку человека с правом кика.
    assert.deepEqual(keys(Permission.KICK_MEMBERS), ['members']);
    assert.equal(serverSettingsHas(Permission.KICK_MEMBERS, 'members'), true);
    assert.deepEqual(keys(Permission.MANAGE_ROLES), ['roles', 'members']);
    assert.equal(serverSettingsHas(Permission.MANAGE_ROLES, 'roles'), true);
  });

  it('каждая доступная вкладка имеет непустые подпись, пояснение и иконку', () => {
    // Ловит новый раздел, который есть в рейле, но выглядит пустым или без пиктограммы.
    for (const tab of serverSettingsTabs(Permission.ADMINISTRATOR)) {
      assert.ok(tab.label.trim(), tab.key);
      assert.ok(tab.sub.trim(), tab.key);
      assert.ok(tab.icon.trim(), tab.key);
    }
  });

  it('выключенная экономика скрывает вкладку и не открывает пустую дверь', () => {
    // Ловит доступ к несуществующей на инстансе подсистеме по одному лишь праву.
    const features = { economy: false };
    assert.deepEqual(serverSettingsTabs(Permission.MANAGE_ECONOMY, features), []);
    assert.equal(canOpenServerSettings(Permission.MANAGE_ECONOMY, features), false);
    assert.equal(serverSettingsHas(Permission.MANAGE_ECONOMY, 'economy', features), false);
  });
});

it('R303 управление сервером открывает Интеграции без права вебхуков, оба права не дублируют дверь', () => {
  assert.deepEqual(keys(Permission.MANAGE_SERVER), ['general', 'soundboard', 'integrations']);
  assert.equal(serverSettingsHas(Permission.MANAGE_SERVER, 'integrations'), true);
  assert.deepEqual(keys(Permission.MANAGE_WEBHOOKS), ['integrations']);
  assert.deepEqual(keys(Permission.MANAGE_SERVER | Permission.MANAGE_WEBHOOKS), ['general', 'soundboard', 'integrations']);
  assert.equal(serverSettingsHas(Permission.MANAGE_CHANNELS, 'integrations'), false);
});

type Tabs = typeof import('./serverSettingsTabs');
const tabsSource = readFileSync(new URL('./serverSettingsTabs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tabsActual: Tabs = { serverSettingsTabs, serverSettingsHas, canOpenServerSettings };
const P = 'R363/tabs/check/';
function loadTabs(raw: string): Tabs {
  const module = { exports: {} };
  // Исполняется весь чистый модуль с настоящими has/Permission, не вырезанный фильтр вкладок.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, require(name: string) {
    assert.equal(name, '@gusvoice/shared', 'R363/tabs/setup/закрытый-импорт'); return shared;
  } }, { timeout: 1000 });
  return module.exports as Tabs;
}
function tabsProof(check: (module: Tabs) => void, edit?: [string, string]): void {
  check(tabsActual);
  check(loadTabs(tabsSource));
  if (!edit) return;
  counterfact(() => {
    const [from, to] = edit;
    assert.equal(tabsSource.split(from).length - 1, 1, 'R363/tabs/setup/единственный-якорь');
    const mutant = loadTabs(tabsSource.replace(from, to));
    assert.throws(() => check(mutant), error => error instanceof assert.AssertionError && error.message.startsWith(P),
      'мутант падает на поведении, не на загрузке или лимите VM');
  });
  check(loadTabs(tabsSource));
}

it('R363 право на экономику открывает Монеты и Игры в этом порядке только с явными обоими флагами', () => tabsProof(module => {
  const features = { economy: true, games: true };
  assert.deepEqual(Array.from(module.serverSettingsTabs(Permission.MANAGE_ECONOMY, features), tab => tab.key), ['economy', 'games'], P + 'явные-обе-вкладки');
  assert.equal(module.serverSettingsHas(Permission.MANAGE_ECONOMY, 'games', features), true, P + 'дверь-игр-открыта');
  assert.equal(module.canOpenServerSettings(Permission.MANAGE_ECONOMY, features), true, P + 'меню-открыто');
  assert.deepEqual(Array.from(module.serverSettingsTabs(0n, features), tab => tab.key), [], P + 'флаги-не-заменяют-право');
}));

it('R363 отсутствующий или false games оставляет только Монеты даже при праве управления экономикой', () => tabsProof(module => {
  for (const features of [{ economy: true }, { economy: true, games: false }]) {
    assert.deepEqual(Array.from(module.serverSettingsTabs(Permission.MANAGE_ECONOMY, features), tab => tab.key), ['economy'], P + 'games-только-явно-true');
    assert.equal(module.serverSettingsHas(Permission.MANAGE_ECONOMY, 'games', features), false, P + 'дверь-игр-скрыта');
    assert.equal(module.serverSettingsHas(Permission.MANAGE_ECONOMY, 'economy', features), true, P + 'монеты-не-потеряны');
  }
}));

it('R363 games true без экономики не создаёт ни вкладок, ни пустой двери настроек', () => tabsProof(module => {
  const features = { economy: false, games: true };
  assert.deepEqual(Array.from(module.serverSettingsTabs(Permission.MANAGE_ECONOMY, features), tab => tab.key), [], P + 'нет-игр-без-монет');
  assert.equal(module.canOpenServerSettings(Permission.MANAGE_ECONOMY, features), false, P + 'нет-пустого-меню');
  assert.equal(module.serverSettingsHas(Permission.MANAGE_ECONOMY, 'games', features), false, P + 'нет-отдельной-двери');
}, ["if (t.key === 'games') return features.economy && features.games === true;", "if (t.key === 'games') return features.games === true;"]));

it('R363 умолчание старых вызовов не включает Игры, включая полный набор прав администратора', () => tabsProof(module => {
  assert.deepEqual(Array.from(module.serverSettingsTabs(Permission.MANAGE_ECONOMY), tab => tab.key), ['economy'], P + 'games-нет-в-умолчании');
  assert.equal(module.serverSettingsHas(Permission.ADMINISTRATOR, 'games'), false, P + 'админ-не-обходит-флаг');
  assert.equal(module.serverSettingsHas(Permission.MANAGE_ECONOMY, 'economy'), true, P + 'экономика-в-умолчании-сохранена');
}, ['const ALL_FEATURES: ServerSettingsFeatures = { economy: true };', 'const ALL_FEATURES: ServerSettingsFeatures = { economy: true, games: true };']));
