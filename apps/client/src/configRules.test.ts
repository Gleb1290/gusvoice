import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hostOf,
  instanceFrom,
  migrateRegistry,
  normalizeServerInput,
  serverHost,
  stripSlash,
  type Instance,
  type ServerConfig,
} from './configRules.js';

const server = (apiUrl: string): ServerConfig => ({ apiUrl, presenceWs: 'wss://presence.example.test/' });
const instance = (id: string, order = 0): Instance => ({
  id,
  name: `Custom ${id}`,
  apiUrl: `https://api.${id}.example.test`,
  presenceWs: `wss://presence.${id}.example.test`,
  pushGateway: `https://push.${id}.example.test`,
  ntfyServer: `https://ntfy.${id}.example.test`,
  token: `token-${id}`,
  order,
});

describe('нормализация адресов инстанса', () => {
  it('хвостовые слэши срезаются, а пустые значения становятся пустой строкой', () => {
    // Ловит двойной слэш при последующей склейке API-пути и падение на optional-поле.
    assert.equal(stripSlash('https://voice.example.test///'), 'https://voice.example.test');
    assert.equal(stripSlash(''), '');
    assert.equal(stripSlash(undefined), '');
    assert.equal(stripSlash(null), '');
  });

  it('host извлекается из URL, а мусор возвращается без исключения', () => {
    // Ловит падение списка инстансов на старой или вручную повреждённой записи.
    assert.equal(hostOf('https://api.voice.example.test:8443/path'), 'api.voice.example.test:8443');
    assert.equal(hostOf('not a url'), 'not a url');
  });

  it('дружелюбное имя снимает только ведущий api-префикс', () => {
    // Ловит показ технического API-хоста или чрезмерное вырезание api из середины имени.
    assert.equal(serverHost('https://api.voice.example.test'), 'voice.example.test');
    assert.equal(serverHost('https://voice.api.example.test'), 'voice.api.example.test');
  });

  it('путь, query и fragment отбрасываются до голого origin', () => {
    // Ловит регрессию #89 с запросом к /channels/.../config.json вместо корня сервера.
    assert.equal(
      normalizeServerInput('  https://voice.example.test/channels/12?from=invite#chat  '),
      'https://voice.example.test',
    );
  });

  it('адрес без схемы получает HTTPS, а нестандартный порт сохраняется', () => {
    // Ловит потерю рабочего self-hosted порта при очистке пользовательского ввода.
    assert.equal(normalizeServerInput('voice.example.test:8443/path'), 'https://voice.example.test:8443');
  });

  it('пустой и синтаксически неверный адрес отклоняются пустой строкой', () => {
    // Ловит попытку discovery по заведомо несуществующему адресу.
    assert.equal(normalizeServerInput('   '), '');
    assert.equal(normalizeServerInput('not a url'), '');
    assert.equal(normalizeServerInput('https://'), '');
  });

  it('явные неподдерживаемые схемы с двойным слэшем отклоняются', () => {
    // Регрессия #95: иначе ftp://example превращался в правдоподобный чужой https-origin.
    for (const value of ['ftp://files.example.test', 'ws://voice.example.test', 'file://local/path']) {
      assert.equal(normalizeServerInput(value), '');
    }
  });

  it('схемы без двойного слэша тоже отклоняются', () => {
    // Ловит превращение mailto/data/javascript в адрес сервера после слепого добавления HTTPS.
    for (const value of ['mailto:a@b.example', 'javascript:alert(1)', 'data:text/plain,hello']) {
      assert.equal(normalizeServerInput(value), '');
    }
  });

  it('userinfo и маскировка чужого хоста под знакомый адрес отклоняются', () => {
    // Ловит добавление присланного злоумышленником инстанса, где видимая часть до @ не является host.
    assert.equal(normalizeServerInput('voice.example.com@evil.example'), '');
    assert.equal(normalizeServerInput('https://user:password@voice.example.test'), '');
  });

  it('localhost с портом не принимается за неизвестную схему', () => {
    // Ловит слишком широкую проверку двоеточия, которая ломает штатную локальную установку.
    assert.equal(normalizeServerInput('localhost:3000/path'), 'https://localhost:3000');
  });

  it('IPv4 и IPv6 с портом остаются рабочими адресами самохостера', () => {
    // Ловит отказ локальным инстансам из-за двоеточия порта или квадратных скобок IPv6.
    assert.equal(normalizeServerInput('192.168.1.229:8080'), 'https://192.168.1.229:8080');
    assert.equal(normalizeServerInput('[::1]:8080/path'), 'https://[::1]:8080');
  });

  it('HTTP(S) без учёта регистра и локальное DNS-имя принимаются', () => {
    // Ловит защиту #95, которая вместе с мусором могла отрезать корректные варианты ввода.
    assert.equal(normalizeServerInput('HTTPS://VOICE.EXAMPLE.TEST/path'), 'https://voice.example.test');
    assert.equal(normalizeServerInput('http://voice.example.test/path'), 'http://voice.example.test');
    assert.equal(normalizeServerInput('my-server.local'), 'https://my-server.local');
  });

  it('двоеточие без порта считается опечаткой, а не рабочим сервером', () => {
    // Ловит молчаливое исправление неоднозначного ввода, после которого пользователь не понимает ошибку.
    assert.equal(normalizeServerInput('voice.example.test:'), '');
  });

  it('новый инстанс получает дружелюбное имя и очищенные сетевые поля', () => {
    // Ловит потерю токена или сохранение хвостовых слэшей при первом добавлении сервера.
    assert.deepEqual(
      instanceFrom(
        {
          apiUrl: 'https://api.voice.example.test/',
          presenceWs: 'wss://presence.example.test/',
          pushGateway: 'https://push.example.test/',
        },
        'legacy-token',
        3,
        'new-id',
      ),
      {
        id: 'new-id',
        name: 'voice.example.test',
        apiUrl: 'https://api.voice.example.test',
        presenceWs: 'wss://presence.example.test',
        pushGateway: 'https://push.example.test',
        ntfyServer: '',
        token: 'legacy-token',
        order: 3,
      },
    );
  });
});

describe('миграция реестра инстансов', () => {
  it('легаси-сервер становится первым инстансом вместе со старым токеном', () => {
    // Ловит молчаливый разлогин всех пользователей при переходе на multi-instance registry.
    const result = migrateRegistry({
      instances: [],
      activeId: null,
      legacy: server('https://api.legacy.example.test/'),
      envBase: null,
      injected: {},
      legacyToken: 'saved-token',
      newId: () => 'first',
    });
    assert.equal(result.activeId, 'first');
    assert.equal(result.instances[0].token, 'saved-token');
    assert.equal(result.instances[0].apiUrl, 'https://api.legacy.example.test');
  });

  it('легаси-настройка приоритетнее embedded-базы при первом посеве', () => {
    // Ловит незаметное переключение старого пользователя на другой backend с несовместимым JWT.
    const result = migrateRegistry({
      instances: [],
      activeId: null,
      legacy: server('https://api.legacy.example.test'),
      envBase: server('https://api.embedded.example.test'),
      injected: {},
      legacyToken: null,
      newId: () => 'first',
    });
    assert.equal(result.instances[0].apiUrl, 'https://api.legacy.example.test');
  });

  it('пустой picker без источника остаётся пустым с null activeId', () => {
    // Ловит создание фиктивного сервера вместо показа обязательного пикера.
    assert.deepEqual(
      migrateRegistry({
        instances: [],
        activeId: null,
        legacy: null,
        envBase: null,
        injected: {},
        legacyToken: null,
        newId: () => 'unused',
      }),
      { instances: [], activeId: null },
    );
  });

  it('nginx-инъекция обновляет сеть активного инстанса, сохраняя токен и пропущенные поля', () => {
    // Ловит разлогин или стирание работающего presence/ntfy при частичной runtime-конфигурации.
    const old = instance('one');
    const result = migrateRegistry({
      instances: [old, instance('two', 1)],
      activeId: 'one',
      legacy: null,
      envBase: null,
      injected: { apiUrl: 'https://api.new.example.test/', pushGateway: 'https://push.new.example.test/' },
      legacyToken: null,
      newId: () => 'unused',
    });
    assert.deepEqual(result.instances[0], {
      ...old,
      apiUrl: 'https://api.new.example.test',
      pushGateway: 'https://push.new.example.test',
    });
    assert.deepEqual(result.instances[1], instance('two', 1));
  });

  it('пустая desktop-инъекция не меняет выбранный вручную инстанс', () => {
    // Ловит перетирание desktop-конфигурации отсутствующими embedded-полями.
    const saved = instance('one');
    assert.deepEqual(
      migrateRegistry({
        instances: [saved],
        activeId: 'one',
        legacy: null,
        envBase: null,
        injected: {},
        legacyToken: null,
        newId: () => 'unused',
      }),
      { instances: [saved], activeId: 'one' },
    );
  });

  it('автоматическое api-имя освежается, а пользовательское сохраняется', () => {
    // Ловит как устаревший технический label, так и уничтожение ручного названия сервера.
    const auto = { ...instance('auto'), name: 'api.voice.example.test', apiUrl: 'https://api.voice.example.test' };
    const custom = { ...instance('custom', 1), name: 'Мой дом', apiUrl: 'https://api.home.example.test' };
    const result = migrateRegistry({
      instances: [auto, custom],
      activeId: 'auto',
      legacy: null,
      envBase: null,
      injected: {},
      legacyToken: null,
      newId: () => 'unused',
    });
    assert.equal(result.instances[0].name, 'voice.example.test');
    assert.equal(result.instances[1].name, 'Мой дом');
  });

  it('activeId, указывающий в никуда, чинится на первый инстанс', () => {
    // Ловит пустой экран после удаления или повреждения выбранной записи реестра.
    const result = migrateRegistry({
      instances: [instance('first'), instance('second', 1)],
      activeId: 'missing',
      legacy: null,
      envBase: null,
      injected: {},
      legacyToken: null,
      newId: () => 'unused',
    });
    assert.equal(result.activeId, 'first');
  });
});
