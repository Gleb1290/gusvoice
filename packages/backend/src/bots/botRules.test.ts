import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './botRules.js';

const token = `gvb_${'A'.repeat(43)}`; // Публичная синтетика, не настоящий токен.
const source = readFileSync(new URL('./botRules.ts', import.meta.url), 'utf8');
type Rules = typeof rules;

function loadModule(text: string): Rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, URL, require: (name: string) => {
      if (name === 'node:crypto') return crypto;
      if (name === '@gusvoice/shared') return shared;
      throw new Error(`неожиданная зависимость ${name}`);
    } });
  return module.exports as Rules;
}

describe('боты: токены и заголовок', () => {
  it('генератор выдаёт разные gvb_ с 43 знаками base64url после префикса', () => {
    const tokens = Array.from({ length: 8 }, () => rules.newBotToken());
    assert.equal(new Set(tokens).size, 8);
    for (const t of tokens) {
      assert.match(t, /^gvb_[A-Za-z0-9_-]{43}$/);
      assert.equal(t.length, 47);
      assert.equal(rules.botTokenFromHeader(`Bot ${t}`), t);
    }
    assert.equal(rules.BOT_TOKEN_RE.test(`gvb_${'_'.repeat(42)}-`), true);
  });

  it('канонический Bot принимается, разделители и хвостовой whitespace разрешены реальным разбором', () => {
    for (const h of [`Bot ${token}`, `Bot  ${token}`, `Bot\t${token}`, `Bot ${token} \t`]) assert.equal(rules.botTokenFromHeader(h), token);
  });

  it('Bearer, другой регистр схемы, ведущий пробел и whitespace внутри токена отвергаются', () => {
    for (const h of [undefined, '', token, `Bearer ${token}`, `bot ${token}`, `BOT ${token}`, ` Bot ${token}`, `Bot${token}`,
      `Bot gvb_${'A'.repeat(42)}`, `Bot gvb_${'A'.repeat(44)}`, `Bot gvb_${'A'.repeat(42)}+`, `Bot gvb_${'A'.repeat(20)} ${'A'.repeat(23)}`,
      `Bot ${token} garbage`, `Bot ${token},`]) assert.equal(rules.botTokenFromHeader(h), null, h);
  });

  it('sha256 не хранит исходный токен, неверный токен и негодный хеш не совпадают', () => {
    const hash = rules.hashBotToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, crypto.createHash('sha256').update(token, 'utf8').digest('hex'));
    assert.equal(rules.botTokenMatches(token, hash), true);
    assert.equal(rules.botTokenMatches(`${token.slice(0, -1)}B`, hash), false);
    for (const bad of ['', 'x', 'ab', 'ff'.repeat(31), 'ff'.repeat(33)]) assert.equal(rules.botTokenMatches(token, bad), false);
    const dead = rules.deadTokenHash();
    assert.match(dead, /^[0-9a-f]{64}$/);
    assert.equal(rules.botTokenMatches(token, dead), false);
    assert.notEqual(rules.deadTokenHash(), dead);
  });
});

describe('боты: выключатель, квота и создатели', () => {
  it('отсутствие и мусор дают серверные умолчания с enabled false', () => {
    const expected = { creators: 'all', perUserLimit: 10, allowInternalWebhooks: false, enabled: false };
    for (const raw of [undefined, null, false, true, 42, 'all', [], {}, { creators: 'any', perUserLimit: -1, allowInternalWebhooks: 1, enabled: 'true' }]) {
      assert.deepEqual(rules.normalizeBotSettings(raw), expected);
    }
    for (const limit of [NaN, Infinity, 1.5, '10', null]) assert.equal(rules.normalizeBotSettings({ perUserLimit: limit }).perUserLimit, 10);
  });

  it('ноль и 100 сохраняются, 101 обрезается; флаги включаются только boolean true', () => {
    for (const limit of [0, 1, 99, 100]) assert.equal(rules.normalizeBotSettings({ perUserLimit: limit }).perUserLimit, limit);
    assert.equal(rules.normalizeBotSettings({ perUserLimit: 101 }).perUserLimit, 100);
    assert.equal(rules.normalizeBotSettings({ perUserLimit: Number.MAX_SAFE_INTEGER }).perUserLimit, 100);
    for (const creators of ['all', 'approved', 'admin']) assert.equal(rules.normalizeBotSettings({ creators }).creators, creators);
    assert.deepEqual(rules.normalizeBotSettings({ enabled: true, allowInternalWebhooks: true, creators: 'approved', perUserLimit: 0 }),
      { enabled: true, allowInternalWebhooks: true, creators: 'approved', perUserLimit: 0 });
    for (const value of [false, 'true', 1, null, undefined]) {
      const s = rules.normalizeBotSettings({ enabled: value, allowInternalWebhooks: value });
      assert.equal(s.enabled, false); assert.equal(s.allowInternalWebhooks, false);
    }
  });

  it('матрица создателей, статусов, квоты и выключателя не даёт обходить запреты', () => {
    for (const creators of ['all', 'approved', 'admin'] as const) for (const enabled of [false, true]) {
      for (const superAdmin of [false, true]) for (const approved of [false, true]) for (const owned of [0, 1, 2]) {
        const expected = enabled && (superAdmin || (creators !== 'admin' && (creators !== 'approved' || approved) && owned < 1));
        assert.equal(rules.canCreateBot({ enabled, creators, perUserLimit: 1, allowInternalWebhooks: false }, { superAdmin, approved, owned }), expected,
          JSON.stringify({ creators, enabled, superAdmin, approved, owned }));
      }
    }
    const zero = { enabled: true, creators: 'all' as const, perUserLimit: 0, allowInternalWebhooks: false };
    assert.equal(rules.canCreateBot(zero, { superAdmin: false, approved: true, owned: 0 }), false);
    assert.equal(rules.canCreateBot(zero, { superAdmin: true, approved: false, owned: 101 }), true);
  });
});

describe('боты: доставка и прочтение', () => {
  it('подпись соответствует независимому UTF-8 HMAC-SHA256 вектору времени и точного тела', () => {
    // Вектор вычислен отдельно через .NET HMACSHA256, не через тестируемый сериализатор/подпись.
    const body = '{"update_id":1,"text":"тест"}';
    const expected = 't=1700000000,v1=f46672bb1a4828bf1817454779a95a25289b4e86d4df8eb94ebf70d66683f94a';
    assert.equal(rules.webhookSignature('R297_public_test_secret', body, 1700000000), expected);
    assert.equal(rules.webhookSignature('R297_public_test_secret', Buffer.from(body), 1700000000), expected);
    assert.notEqual(rules.webhookSignature('R297_public_test_secret', `${body}\n`, 1700000000), expected);
    assert.notEqual(rules.webhookSignature('R297_public_test_secret', body, 1700000001), expected);
    assert.notEqual(rules.webhookSignature('other_public_test_secret', body, 1700000000), expected);
  });

  it('повторы растут от 5 секунд до 600 секунд и не превышают потолок', () => {
    for (const [failures, expected] of [[-1, 5000], [0, 5000], [1, 5000], [2, 10000], [3, 20000], [7, 320000], [8, 600000], [9, 600000], [1000, 600000]]) {
      assert.equal(rules.webhookBackoffMs(failures), expected);
    }
  });

  it('прочтение группируется по беседам, сохраняет порядок и убирает повтор id только в своей беседе', () => {
    const row = (chat: string, id: string) => ({ type: 'message', payload: { chat: { id: chat }, message_id: id } });
    assert.deepEqual([...rules.readMarksOf([row('a', 'm2'), row('b', 'm2'), row('a', 'm1'), row('a', 'm2')])],
      [['a', ['m2', 'm1']], ['b', ['m2']]]);
    assert.deepEqual([...rules.readMarksOf([])], []);
  });

  it('правки, удаления, членство и повреждённые грузы не двигают прочтение', () => {
    const payload = { chat: { id: 'chat' }, message_id: 'message' };
    const rows: { type: string; payload: unknown }[] = ['edited_message', 'message_deleted', 'my_chat_member', 'unknown'].map(type => ({ type, payload }));
    for (const bad of [null, undefined, false, 3, 'text', [], {}, { message_id: '', chat: { id: 'a' } },
      { message_id: 1, chat: { id: 'a' } }, { message_id: 'm', chat: null }, { message_id: 'm', chat: 'a' },
      { message_id: 'm', chat: { id: '' } }, { message_id: 'm', chat: { id: 1 } }]) rows.push({ type: 'message', payload: bad });
    assert.deepEqual([...rules.readMarksOf(rows)], []);
    assert.deepEqual([...rules.readMarksOf([...rows, { type: 'message', payload }])], [['chat', ['message']]]);
  });
});

describe('R300 тексты доставки для владельца и английского провода', () => {
  it('статус HTTP остаётся русским в базе, но в проводе явно называет HTTP', () => {
    for (const [status, ru, en] of [
      [400, 'ответ 400', 'Wrong response from the webhook: HTTP 400'],
      [500, 'ответ 500', 'Wrong response from the webhook: HTTP 500'],
      [503, 'ответ 503', 'Wrong response from the webhook: HTTP 503'],
    ] as const) {
      assert.equal(rules.webhookErrorText({ status, error: new Error('ignored because status exists') }), ru);
      assert.equal(rules.webhookErrorWire(ru), en);
    }
  });
  it('сетевые коды имеют парные русские и английские тексты, а не необработанный код Node', () => {
    for (const [code, ru, en] of [
      ['ECONNREFUSED', 'соединение отклонено', 'Connection refused'],
      ['ECONNRESET', 'соединение сброшено', 'Connection reset by peer'],
      ['ENOTFOUND', 'имя хоста не резолвится', 'Failed to resolve host'],
      ['EAI_AGAIN', 'имя хоста не резолвится', 'Failed to resolve host'],
      ['ETIMEDOUT', 'нет соединения: срок истёк', 'Connection timed out'],
      ['EHOSTUNREACH', 'хост недоступен', 'Host unreachable'],
      ['ENETUNREACH', 'сеть недоступна', 'Network unreachable'],
    ]) {
      const stored = rules.webhookErrorText({ error: Object.assign(new Error('synthetic network error'), { code }) });
      assert.equal(stored, ru); assert.equal(rules.webhookErrorWire(stored), en);
      assert.doesNotMatch(rules.webhookErrorWire(stored), /[А-Яа-яЁё]/);
    }
  });
  it('ошибки TLS и сертификата не выдают людям необъяснимый код и переводятся для Bot API', () => {
    for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      const stored = rules.webhookErrorText({ error: Object.assign(new Error('synthetic TLS failure'), { code }) });
      assert.equal(stored, 'сертификат адреса не прошёл проверку');
      assert.equal(rules.webhookErrorWire(stored), 'SSL error: certificate verify failed');
    }
  });
  it('незнакомый русский текст становится общей ошибкой, английский текст сохраняется побайтно', () => {
    for (const stored of ['другая ошибка', 'Ёж', 'prefix СБОЙ suffix']) assert.equal(rules.webhookErrorWire(stored), 'Webhook delivery failed');
    for (const stored of ['HTTP 500', 'socket hang up', 'another failure', '']) assert.equal(rules.webhookErrorWire(stored), stored);
  });
  it('старые таймауты и запреты цели переводятся без исходной русской причины', () => {
    for (const stored of ['срок запроса истёк (10000 мс)', 'таймаут']) assert.equal(rules.webhookErrorWire(stored), 'Read timeout expired');
    assert.equal(rules.webhookErrorWire('заблокированная цель: synthetic-address'), 'Blocked: the webhook address is not allowed');
  });
  it('неизвестная ошибка ограничивается 200 символами с обеих сторон границы', () => {
    for (const length of [199, 200, 201]) {
      const message = 'x'.repeat(length);
      assert.equal(rules.webhookErrorText({ error: new Error(message) }), message.slice(0, 200));
    }
    assert.equal(rules.webhookErrorText({ error: 'synthetic string error' }), 'synthetic string error');
  });
});

const mutations = [
  { name: 'лимит нельзя снять', from: 'return who.owned < s.perUserLimit;', to: 'return true;', message: 'квота блокирует следующего бота',
    check: (r: Rules) => assert.strictEqual(r.canCreateBot({ enabled: true, creators: 'all', perUserLimit: 1, allowInternalWebhooks: false }, { superAdmin: false, approved: true, owned: 1 }), false, 'квота блокирует следующего бота') },
  { name: 'approved не пускает неодобренного', from: "if (s.creators === 'approved' && !who.approved) return false;", to: '', message: 'неодобренный не создаёт бота',
    check: (r: Rules) => assert.strictEqual(r.canCreateBot({ enabled: true, creators: 'approved', perUserLimit: 10, allowInternalWebhooks: false }, { superAdmin: false, approved: false, owned: 0 }), false, 'неодобренный не создаёт бота') },
  { name: 'выключатель нельзя игнорировать даже супер-админу', from: 'if (!s.enabled) return false;', to: '', message: 'выключенный инстанс блокирует создание',
    check: (r: Rules) => assert.strictEqual(r.canCreateBot({ enabled: false, creators: 'all', perUserLimit: 10, allowInternalWebhooks: false }, { superAdmin: true, approved: true, owned: 0 }), false, 'выключенный инстанс блокирует создание') },
  { name: 'отсутствующий enabled не включает сервер', from: 'enabled: v.enabled === true,', to: 'enabled: v.enabled !== false,', message: 'нет enabled означает выключено',
    check: (r: Rules) => assert.strictEqual(r.normalizeBotSettings({}).enabled, false, 'нет enabled означает выключено') },
  { name: 'edited_message не считается прочитанным новым сообщением', from: "r.type !== 'message' ||", to: "(r.type !== 'message' && r.type !== 'edited_message') ||", message: 'правка не добавляет отметку прочтения',
    check: (r: Rules) => assert.strictEqual(r.readMarksOf([{ type: 'edited_message', payload: { message_id: 'm', chat: { id: 'c' } } }]).has('c'), false, 'правка не добавляет отметку прочтения') },
  { name: 'R301 удаление проверки схемы открывает FTP-кнопку', from: "(u.protocol === 'http:' || u.protocol === 'https:') && ", to: '', message: 'FTP нельзя открыть кнопкой бота',
    check: (r: Rules) => assert.strictEqual(r.isHttpUrlWithoutCredentials('ftp://example.invalid/'), false, 'FTP нельзя открыть кнопкой бота') },
];

describe('боты: исполняемые контрфакты полного модуля', () => {
  for (const m of mutations) it(m.name, () => {
    m.check(rules);
    m.check(loadModule(source)); // Original-first: тот же полный TS→VM путь обязан быть зелёным до замены.
    assert.equal(source.split(m.from).length - 1, 1, `единственный якорь ${m.name}`);
    const changed = source.replace(m.from, m.to);
    assert.notEqual(changed, source);
    assert.throws(() => m.check(loadModule(changed)), (error: unknown) => error instanceof assert.AssertionError
      && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === m.message
      && error.operator === 'strictEqual' && error.actual === true && error.expected === false,
    `мутант обязан упасть именно на host AssertionError: ${m.message}`);
  });
});

describe('R301 чистые правила команд и кнопок', () => {
  it('HTTP и HTTPS без credentials принимаются, остальные схемы и логин либо пароль отвергаются', () => {
    for (const url of ['http://example.invalid/', 'https://example.invalid/path?q=1#x']) assert.equal(rules.isHttpUrlWithoutCredentials(url), true, url);
    for (const url of ['ftp://example.invalid/', 'javascript:alert(1)', 'data:text/plain,x', 'tg://resolve?domain=x',
      'https://user:pass@example.invalid/', 'https://user@example.invalid/', 'https://:pass@example.invalid/', '', '/relative', 'not-url']) {
      assert.equal(rules.isHttpUrlWithoutCredentials(url), false, url);
    }
  });
  it('области default, личных чатов и групп принимаются; адресные области и неверный регистр отвергаются', () => {
    assert.deepEqual(rules.BOT_COMMAND_SCOPES, ['default', 'all_private_chats', 'all_group_chats']);
    for (const type of ['default', 'all_private_chats', 'all_group_chats']) assert.equal(rules.commandScopeOk(type), true);
    for (const type of ['chat', 'chat_member', 'all_chat_administrators', 'Default', '', ' default ']) assert.equal(rules.commandScopeOk(type), false, type);
  });
  it('пустой и уникальный списки не имеют дублей, возвращается первое повторённое имя', () => {
    const list = (...names: string[]) => names.map(command => ({ command }));
    assert.equal(rules.duplicateCommand([]), null);
    assert.equal(rules.duplicateCommand(list('start', 'stop', 'status')), null);
    assert.equal(rules.duplicateCommand(list('start', 'stop', 'stop', 'start')), 'stop');
    // Ключи Object.prototype — обычные допустимые имена, не ложные «уже встреченные» из словаря-объекта.
    assert.equal(rules.duplicateCommand(list('constructor', '__proto__')), null);
    assert.equal(rules.duplicateCommand(list('__proto__', '__proto__')), '__proto__');
  });
  it('данные ищутся во всех рядах по точной строке, индекс и похожее имя кнопки не разрешают нажатие', () => {
    const keyboard = [[{ text: 'Статус', callback_data: 'st' }, { text: 'Сайт', url: 'https://example.invalid/' }],
      [{ text: 'Перезапустить', callback_data: 'rs:nginx' }, { text: 'Пробелы', callback_data: ' st ' }]];
    for (const data of ['st', 'rs:nginx', ' st ']) assert.equal(rules.keyboardHasData(keyboard, data), true, data);
    for (const data of ['0', '1', 'ST', 'rs', 'rs:nginx ', 'Статус', '', 'https://example.invalid/']) assert.equal(rules.keyboardHasData(keyboard, data), false, data);
    for (const empty of [null, undefined, [], [[]]]) assert.equal(rules.keyboardHasData(empty, 'st'), false);
  });
  it('callback_query входит в типы доставки, но не сдвигает прочтение сообщения панели', () => {
    assert.deepEqual(rules.BOT_UPDATE_TYPES, ['message', 'edited_message', 'message_deleted', 'my_chat_member', 'callback_query', 'message_reaction', 'chat_member', 'voice_state']);
    const payload = { message_id: 'panel', chat: { id: 'dm' }, message: { message_id: 'panel', chat: { id: 'dm' } } };
    assert.deepEqual([...rules.readMarksOf([{ type: 'callback_query', payload }])], []);
    assert.deepEqual([...rules.readMarksOf([{ type: 'message', payload }])], [['dm', ['panel']]]);
  });
});
