import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import * as shared from '@gusvoice/shared';
import * as zod from 'zod';
import ts from 'typescript';
import * as rules from './webhookRules.js';
import * as convRules from './convRules.js';

type Rules = typeof rules;
const ZWSP = '\u200b';
const raw = readFileSync(new URL('./webhookRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Загружается целый модуль с настоящими чистыми зависимостями. Время не измеряем:
// одинаковый результат === не доказывает защищённость сравнения от побочного канала.
function load(source = raw, onCompare?: (a: Uint8Array, b: Uint8Array) => void): Rules {
  const box = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    exports: box.exports, module: box, Buffer,
    require: (name: string) => {
      if (name === 'node:crypto') return { ...crypto, timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
        onCompare?.(a, b);
        return crypto.timingSafeEqual(a, b);
      } };
      if (name === '@gusvoice/shared') return shared;
      if (name === 'zod') return zod;
      if (name === './convRules.js') return convRules;
      throw new Error(`Неожиданная зависимость webhookRules: ${name}`);
    },
  });
  return box.exports as Rules;
}

function rejectMutant(from: string, to: string, marker: string, check: (api: Rules) => void): void {
  check(load());
  assert.equal(raw.split(from).length - 1, 1, `Единственный якорь мутанта: ${from}`);
  const mutant = load(raw.replace(from, to));
  assert.throws(() => check(mutant), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.includes(marker));
}

describe('R274 токен вебхука и служебный логин', () => {
  it('новые токены содержат 32 случайных байта без padding и проходят адресную проверку', () => {
    const tokens = Array.from({ length: 3 }, () => rules.newWebhookToken());
    assert.equal(new Set(tokens).size, tokens.length);
    for (const token of tokens) {
      assert.equal(token.length, 43);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
      assert.equal(rules.WEBHOOK_TOKEN_RE.test(token), true);
    }
  });

  it('форма токена принимает ровно 20–128 адресных знаков, соседние длины и чужие знаки отвергает', () => {
    for (const length of [20, 21, 43, 127, 128]) assert.equal(rules.WEBHOOK_TOKEN_RE.test('a'.repeat(length)), true);
    for (const length of [0, 19, 129]) assert.equal(rules.WEBHOOK_TOKEN_RE.test('a'.repeat(length)), false);
    assert.equal(rules.WEBHOOK_TOKEN_RE.test('Abc_0123456789-abcdef'), true);
    for (const char of ['/', '+', '=', ' ', '\n', 'я']) {
      assert.equal(rules.WEBHOOK_TOKEN_RE.test(`a${char}${'a'.repeat(20)}`), false);
    }
  });

  it('хеш — настоящий SHA-256 UTF-8, в базе не остаётся открытого токена', () => {
    assert.equal(rules.hashWebhookToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = 'Тестовый локальный токен';
    const hash = rules.hashWebhookToken(token);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, token);
    assert.equal(hash, crypto.createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex'));
  });

  it('совпадение хеша принимается, другой токен и повреждённая длина хеша — нет', () => {
    const token = 'local-webhook-token';
    const hash = rules.hashWebhookToken(token);
    assert.equal(rules.webhookTokenMatches(token, hash), true);
    assert.equal(rules.webhookTokenMatches(token, hash.toUpperCase()), true);
    assert.equal(rules.webhookTokenMatches(`${token}!`, hash), false);
    for (const broken of ['', 'a'.repeat(62), 'a'.repeat(63), 'a'.repeat(66), 'z'.repeat(64)]) {
      assert.equal(rules.webhookTokenMatches(token, broken), false);
    }
  });

  it('равный и неравный хеши сравниваются timingSafeEqual, а неразмерный хеш туда не доходит', () => {
    const calls: [Uint8Array, Uint8Array][] = [];
    const api = load(raw, (a, b) => calls.push([a, b]));
    assert.equal(api.webhookTokenMatches('abc', api.hashWebhookToken('abc')), true);
    assert.equal(api.webhookTokenMatches('abd', api.hashWebhookToken('abc')), false);
    assert.equal(api.webhookTokenMatches('abc', ''), false);
    assert.equal(calls.length, 2);
    for (const [a, b] of calls) {
      assert.equal(a.byteLength, 32);
      assert.equal(b.byteLength, 32);
    }
  });

  it('контракт отвергает === даже при том же ответе: обязан вызываться constant-time примитив', () => {
    const marker = 'R274 обязательный timingSafeEqual';
    const check = (source: string) => {
      let calls = 0;
      const api = load(source, () => calls++);
      assert.equal(api.webhookTokenMatches('abc', api.hashWebhookToken('abc')), true);
      assert.equal(api.webhookTokenMatches('abd', api.hashWebhookToken('abc')), false);
      assert.equal(calls, 2, marker);
    };
    check(raw);
    const from = 'return timingSafeEqual(a, b);';
    assert.equal(raw.split(from).length - 1, 1);
    assert.throws(() => check(raw.replace(from, "return a.toString('hex') === b.toString('hex');")),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker));
  });

  it('служебный логин содержит невозможный для человеческого логина разделитель', () => {
    assert.equal(rules.webhookUsername('local-id'), 'webhook:local-id');
    assert.notEqual(rules.webhookUsername('local-id'), rules.webhookUsername('other-id'));
  });
});

describe('R274 схемы входящего тела', () => {
  it('имя обрезается, один знак и 80 знаков проходят, пустое и 81 — нет', () => {
    assert.equal(rules.webhookName.parse('  Бот  '), 'Бот');
    for (const length of [1, 80]) assert.equal(rules.webhookName.safeParse('я'.repeat(length)).success, true);
    for (const name of ['', ' \n\t ', 'я'.repeat(81)]) assert.equal(rules.webhookName.safeParse(name).success, false);
  });

  it('подменное имя имеет тот же предел после trim, иначе выбирается имя вебхука', () => {
    assert.equal(rules.overrideName('  CI  '), 'CI');
    for (const length of [1, 80]) assert.equal(rules.overrideName('я'.repeat(length)), 'я'.repeat(length));
    for (const value of [null, undefined, '', '  ', 'я'.repeat(81)]) assert.equal(rules.overrideName(value), null);
  });

  it('пустое тело и null-поля допустимы схемой, чужие Discord-поля отбрасываются', () => {
    assert.deepEqual(rules.webhookExecuteBody.parse({}), {});
    assert.deepEqual(rules.webhookExecuteBody.parse({ content: 'CI', tts: true, flags: 4, components: [] }), { content: 'CI' });
    const nullable = { content: null, username: null, avatar_url: null, embeds: null, allowed_mentions: null };
    assert.deepEqual(rules.webhookExecuteBody.parse(nullable), nullable);
    assert.equal(rules.webhookExecuteBody.safeParse({ content: 5 }).success, false);
  });

  const strings: [string, number, (value: string) => unknown][] = [
    ['текст', 4096, (content) => ({ content })],
    ['сырое подменное имя', 320, (username) => ({ username })],
    ['адрес аватара', 2048, (avatar_url) => ({ avatar_url })],
    ['заголовок embed', 256, (title) => ({ embeds: [{ title }] })],
    ['описание embed', 4096, (description) => ({ embeds: [{ description }] })],
    ['адрес embed', 2048, (url) => ({ embeds: [{ url }] })],
    ['имя поля embed', 256, (name) => ({ embeds: [{ fields: [{ name, value: 'значение' }] }] })],
    ['значение поля embed', 1024, (value) => ({ embeds: [{ fields: [{ name: 'поле', value }] }] })],
    ['автор embed', 256, (name) => ({ embeds: [{ author: { name } }] })],
    ['подвал embed', 2048, (text) => ({ embeds: [{ footer: { text } }] })],
    ['слово allowed_mentions.parse', 16, (value) => ({ allowed_mentions: { parse: [value] } })],
    ['id роли', 64, (value) => ({ allowed_mentions: { roles: [value] } })],
    ['id пользователя', 64, (value) => ({ allowed_mentions: { users: [value] } })],
  ];
  for (const [name, limit, body] of strings) {
    it(`${name}: ровно ${limit} знаков проходит, ${limit + 1} — отказ`, () => {
      assert.equal(rules.webhookExecuteBody.safeParse(body('x'.repeat(limit))).success, true);
      assert.equal(rules.webhookExecuteBody.safeParse(body('x'.repeat(limit + 1))).success, false);
    });
  }

  const lists: [string, number, (length: number) => unknown][] = [
    ['embeds', 10, (length) => ({ embeds: Array.from({ length }, () => ({ title: 'CI' })) })],
    ['поля embed', 25, (length) => ({ embeds: [{ fields: Array.from({ length }, () => ({ name: 'поле', value: 'текст' })) }] })],
    ['allowed_mentions.parse', 8, (length) => ({ allowed_mentions: { parse: Array.from({ length }, () => 'users') } })],
    ['allowed_mentions.roles', 100, (length) => ({ allowed_mentions: { roles: Array.from({ length }, (_, i) => `${i}`) } })],
    ['allowed_mentions.users', 100, (length) => ({ allowed_mentions: { users: Array.from({ length }, (_, i) => `${i}`) } })],
  ];
  for (const [name, limit, body] of lists) {
    it(`${name}: ровно ${limit} элементов проходит, ${limit + 1} — отказ`, () => {
      assert.equal(rules.webhookExecuteBody.safeParse(body(limit)).success, true);
      assert.equal(rules.webhookExecuteBody.safeParse(body(limit + 1)).success, false);
    });
  }

  it('цвет embed принимается целым, дробь отвергается; inline — boolean либо null', () => {
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds: [{ color: 16711680, fields: [{ name: 'a', value: 'b', inline: true }] }] }).success, true);
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds: [{ color: 1.5 }] }).success, false);
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds: [{ fields: [{ name: 'a', value: 'b', inline: null }] }] }).success, true);
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds: [{ fields: [{ name: 'a', value: 'b', inline: 'true' }] }] }).success, false);
  });
});

describe('R274 сворачивание Discord embeds', () => {
  it('автор, заголовок, открытая ссылка, строки описания, поля и подвал сохраняют порядок', () => {
    assert.equal(rules.flattenEmbeds([{
      author: { name: '  CI\n server ' }, title: ' build\tready ', url: ' https://ci.example/build/1 ',
      description: ' first\r\nsecond ', color: 123,
      fields: [{ name: ' result\nname ', value: ' ok\r\nnow ', inline: true }, { name: '', value: 'standalone' }],
      footer: { text: ' foot\n note ' },
    }]), '> CI server\n> **build ready**\n> https://ci.example/build/1\n> first\n> second\n> **result name**: ok now\n> standalone\n> foot note');
  });

  it('пустые embeds исчезают, непустые разделяются пустой строкой без ложной карточки', () => {
    for (const embeds of [null, undefined, [], [{}], [{ title: '  ', description: '\n', fields: [{ name: '', value: '' }] }]]) {
      assert.equal(rules.flattenEmbeds(embeds), '');
    }
    assert.equal(rules.flattenEmbeds([{ title: 'one' }, {}, { description: 'two' }]), '> **one**\n\n> two');
  });

  it('HTTP и HTTPS остаются видимой ссылкой, javascript/data/относительные адреса не выдаются', () => {
    for (const url of ['http://ci.example', 'HTTPS://ci.example']) assert.equal(rules.flattenEmbeds([{ url }]), `> ${url}`);
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '/build/1', '//ci.example']) {
      assert.equal(rules.flattenEmbeds([{ url }]), '');
    }
  });

  it('content и embeds соединяются после trim, а полностью пустое тело даёт пустой текст', () => {
    assert.equal(rules.webhookContent({ content: '  report  ', embeds: [{ title: 'build' }] }), 'report\n\n> **build**');
    assert.equal(rules.webhookContent({ embeds: [{ description: 'only embed' }] }), '> only embed');
    assert.equal(rules.webhookContent({ content: ' \n ', embeds: [{}] }), '');
  });

  it('готовый текст ровно 4096 сохраняется, 4097 обрезается с многоточием в пределах 4096', () => {
    assert.equal(rules.webhookContent({ content: 'x'.repeat(4096) }), 'x'.repeat(4096));
    assert.equal(rules.webhookContent({ content: 'x'.repeat(4097) }), `${'x'.repeat(4095)}…`);
    // По отдельности оба поля валидны: общий предел должен действовать уже после склейки.
    const body = rules.webhookExecuteBody.parse({ content: 'x'.repeat(4090), embeds: [{ description: '12345' }] });
    const content = rules.webhookContent(body);
    assert.equal(content.length, 4096);
    assert.equal(content, `${'x'.repeat(4090)}\n\n> 1…`);
  });
});

describe('R274 разрешения упоминаний', () => {
  it('без allowed_mentions зовутся все виды упоминаний; пустой объект запрещает всех', () => {
    for (const absent of [undefined, null]) assert.deepEqual(rules.mentionPolicy(absent), { users: true, everyone: true, roles: true });
    assert.deepEqual(rules.mentionPolicy({}), { users: false, everyone: false, roles: false });
    assert.deepEqual(rules.mentionPolicy({ parse: [] }), { users: false, everyone: false, roles: false });
  });

  it('явный parse не зависит от регистра; users по id сужает список людей, а неизвестный parse ничего не открывает', () => {
    assert.deepEqual(rules.mentionPolicy({ parse: ['UsErS', 'EVERYONE', 'RoLeS'] }), { users: true, everyone: true, roles: true });
    assert.deepEqual(rules.mentionPolicy({ users: ['person'], parse: ['unknown'] }), { users: ['person'], everyone: false, roles: false });
    assert.deepEqual(rules.mentionPolicy({ roles: [] }), { users: false, everyone: false, roles: false });
  });

  it('список ролей копируется, parse roles даёт все уже разрешённые роли, а не новые id', () => {
    const input = ['role-a'];
    const policy = rules.mentionPolicy({ roles: input });
    assert.deepEqual(policy.roles, ['role-a']);
    input.push('role-b');
    assert.deepEqual(policy.roles, ['role-a']);
    assert.deepEqual(rules.mentionPolicy({ parse: ['roles'], roles: ['role-a'] }).roles, true);
    const resolved = ['role-a', 'role-b'];
    const accepted = rules.allowedRoleIds(resolved, { users: false, everyone: false, roles: true });
    assert.deepEqual(accepted, resolved);
    assert.notEqual(accepted, resolved);
  });

  it('только пересечение разрешённых сервером ролей и списка вебхука попадает в сообщение', () => {
    const resolved = ['role-a', 'role-b'];
    assert.deepEqual(rules.allowedRoleIds(resolved, rules.mentionPolicy(undefined)), resolved);
    assert.deepEqual(rules.allowedRoleIds(resolved, rules.mentionPolicy({ roles: ['role-b', 'not-resolved'] })), ['role-b']);
    assert.deepEqual(resolved, ['role-a', 'role-b']);
  });

  it('по умолчанию текст @everyone, @here, ролей и людей не меняется ни на один байт', () => {
    assert.equal(rules.neutralizeMentions('@everyone @HERE @alice @everyone-team user@here', rules.mentionPolicy(undefined)),
      '@everyone @HERE @alice @everyone-team user@here');
  });

  it('запрет users обезвреживает ники, явный everyone оставляет broadcasts, разрешение обоих не меняет текст', () => {
    const text = '@alice @everyone @here';
    assert.equal(rules.neutralizeMentions(text, rules.mentionPolicy({})), `@${ZWSP}alice @${ZWSP}everyone @${ZWSP}here`);
    assert.equal(rules.neutralizeMentions(text, rules.mentionPolicy({ parse: ['everyone'] })), `@${ZWSP}alice @everyone @here`);
    assert.equal(rules.neutralizeMentions(text, rules.mentionPolicy({ parse: ['users', 'everyone'] })), text);
  });

  it('почта не меняется, упоминание после разрешённой пунктуации обезвреживается один раз', () => {
    const text = 'user@alice.dev юзер@alice o\'brien@alice +@alice (**@alice**)';
    const filtered = rules.neutralizeMentions(text, rules.mentionPolicy({}));
    assert.equal(filtered, `user@alice.dev юзер@alice o'brien@alice +@alice (**@${ZWSP}alice**)`);
    assert.equal(rules.neutralizeMentions(filtered, rules.mentionPolicy({})), filtered);
  });

  it('разрешённая роль сохраняет написание и границу имени, похожий длинный ник не получает исключение', () => {
    assert.equal(rules.neutralizeMentions('@Mods @MODS! @Mods2 @Mods_2 @Mods Team @alice', rules.mentionPolicy({ roles: ['role'] }), [' mods ']),
      `@Mods @MODS! @${ZWSP}Mods2 @${ZWSP}Mods_2 @Mods Team @${ZWSP}alice`);
    assert.equal(rules.neutralizeMentions('@Build Team @Build Teams', rules.mentionPolicy({}), ['Build Team']), `@Build Team @${ZWSP}Build Teams`);
  });

  it('мутант старого строгого умолчания отвергается контрактом Discord', () => {
    const marker = 'R279 по умолчанию зовутся все';
    rejectMutant('if (!allowed) return { users: true, everyone: true, roles: true };',
      'if (!allowed) return { users: true, everyone: false, roles: false };', marker,
      (api) => assert.equal(api.neutralizeMentions('@everyone @here @alice', api.mentionPolicy(undefined)), '@everyone @here @alice', marker));
  });

  it('мутант, пропускающий роли при полном запрете, отвергается', () => {
    const marker = 'R279 явный запрет закрывает роли';
    rejectMutant('if (policy.roles === false) return [];', 'if (policy.roles === false) return [...resolved];', marker,
      (api) => assert.equal(api.allowedRoleIds(['role-a'], api.mentionPolicy({})).length, 0, marker));
  });

  it('мутант без пересечения allowedRoleIds отвергается, разрешённая роль остаётся положительным контролем', () => {
    const marker = 'R274 только разрешённая роль';
    rejectMutant('return resolved.filter((r) => only.has(r));', 'return [...resolved];', marker, (api) => {
      const actual = api.allowedRoleIds(['role-a', 'role-b'], api.mentionPolicy({ roles: ['role-b'] }));
      assert.deepEqual([...actual], ['role-b'], marker);
    });
  });

  it('мутант с обезвреживанием разрешённой роли отвергается парой разрешённая роль/обычный ник', () => {
    const marker = 'R274 разрешённая роль сохраняется';
    rejectMutant("const keep = keepRoleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);", 'const keep: string[] = [];', marker,
      (api) => assert.equal(api.neutralizeMentions('@Mods @alice', api.mentionPolicy({ roles: ['role-a'] }), ['Mods']),
        `@Mods @${ZWSP}alice`, marker));
  });
});

describe('R279 карточки и совместимость вебхуков', () => {
  const own = 'https://media.invalid/gusvoice/';
  const isOwn = (url: string) => url.startsWith(own);

  it('чужие HTTPS-картинки становятся ссылками, свои и файлы текущего запроса остаются картинками', () => {
    // Класс ошибки: трекинговый пиксель из embed не должен загружаться браузерами всех читателей.
    const files = new Map([['photo.png', `${own}photo.png`]]);
    assert.deepEqual(rules.normalizeEmbeds([{
      image: { url: 'https://tracker.invalid/pixel' }, thumbnail: { url: `${own}thumb.png` },
      author: { name: 'Автор', icon_url: 'https://tracker.invalid/icon' },
      footer: { text: 'Подвал', icon_url: 'attachment://photo.png' },
    }], isOwn, files), [{
      imageLink: 'https://tracker.invalid/pixel', thumbnail: { url: `${own}thumb.png` },
      author: { name: 'Автор' }, footer: { text: 'Подвал', iconUrl: `${own}photo.png` },
    }]);
    assert.deepEqual(rules.normalizeEmbeds([{ image: { url: 'attachment://photo.png' }, thumbnail: { url: 'https://outside.invalid/thumb' } }], isOwn, files),
      [{ image: { url: `${own}photo.png` }, thumbnailLink: 'https://outside.invalid/thumb' }]);
    for (const url of ['attachment://missing.png', 'http://outside.invalid/pixel', 'data:image/png;base64,AA', 'javascript:alert(1)', '/relative.png']) {
      assert.deepEqual(rules.normalizeEmbeds([{ image: { url } }], isOwn, files), []);
    }
  });

  it('цвет сохраняет обе границы RGB, время приводится к UTC, пустые карточки и поля исчезают', () => {
    // Класс ошибки: мусорная мета не должна давать пустую видимую карточку или портить допустимые границы цвета и времени.
    for (const color of [0, 0xffffff]) assert.deepEqual(rules.normalizeEmbeds([{ color }], isOwn), [{ color }]);
    for (const color of [-1, 0x1000000]) assert.deepEqual(rules.normalizeEmbeds([{ color }], isOwn), []);
    assert.deepEqual(rules.normalizeEmbeds([{
      title: '  сборка\nготова ', description: '  строка\nдругая  ', timestamp: '2026-10-19T12:00:00+03:00',
      fields: [{ name: ' \n ', value: ' ' }, { name: ' имя\tполя ', value: ' x\ny ', inline: true }],
    }, {}, { title: ' ', timestamp: 'не время' }], isOwn), [{
      title: 'сборка готова', description: 'строка\nдругая', timestamp: '2026-10-19T09:00:00.000Z',
      fields: [{ name: 'имя поля', value: 'x\ny', inline: true }],
    }]);
    assert.deepEqual(rules.normalizeEmbeds(null, isOwn), []);
  });

  it('общие 6000 знаков принимаются, 6001 отклоняется с учётом всех текстовых частей, но не URL', () => {
    // Класс ошибки: отдельные поля проходят пределы, а сумма нескольких карточек переполняет общий бюджет Discord.
    const embeds: rules.WebhookEmbed[] = [{ title: 't'.repeat(256), description: 'd'.repeat(4096), author: { name: 'a'.repeat(256) },
      footer: { text: 'f'.repeat(1000) }, fields: [{ name: 'n'.repeat(100), value: 'v'.repeat(292) }], url: 'https://ci.invalid/build' }];
    assert.equal(rules.embedsTextLength(embeds), 6000);
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds }).success, true);
    assert.equal(rules.webhookExecuteBody.safeParse({ embeds: [...embeds, { title: 'x' }] }).success, false);
    assert.equal(rules.embedsTextLength(undefined), 0);
  });

  it('свёртка для старых клиентов нейтрализует упоминания и не подмешивается в собственный текст', () => {
    // Класс ошибки: текст совместимости может повторно позвать людей из карточки или затереть собственную подпись.
    const embeds = rules.normalizeEmbeds([{ title: '@everyone', description: '@here @alice' }], isOwn);
    assert.equal(rules.embedsFallbackText(embeds), `> **@${ZWSP}everyone**\n> @${ZWSP}here @${ZWSP}alice`);
    assert.equal(rules.webhookText({ content: ' Свой текст ', embeds: [{ title: 'Карточка' }] }), 'Свой текст');
    const long = rules.embedsFallbackText([{ description: 'x'.repeat(4095) }]);
    assert.equal(long.length, 4096);
    assert.equal(long.endsWith('…'), true);
    assert.equal(rules.embedsPreview([{ title: ' CI\nготов ' }]), 'CI готов');
  });

  it('список пользователей хранит id, но обезвреживание разрешает только разрешённый ник с точной границей', () => {
    // Класс ошибки: разрешённый id ошибочно принимается за ник либо открывает похожие ники за пределами списка.
    const input = ['person'];
    const policy = rules.mentionPolicy({ users: input });
    input.push('other');
    assert.deepEqual(policy.users, ['person']);
    assert.equal(rules.neutralizeMentions('@Alice @alice2 @person @everyone', policy, [], ['Alice']),
      `@Alice @${ZWSP}alice2 @${ZWSP}person @${ZWSP}everyone`);
  });

  it('имена multipart-файлов принимают Discord и старые библиотеки, посторонние поля запрещены', () => {
    // Класс ошибки: файл из неожиданного поля молча теряется, а корректная программа считает его принятым.
    for (const field of ['files[0]', 'files[9]', 'file', 'file0', 'file99']) assert.equal(rules.isWebhookFileField(field), true);
    for (const field of ['avatar', 'files', 'files[-1]', 'files[x]', 'files[100]', 'file100', 'Files[0]']) assert.equal(rules.isWebhookFileField(field), false);
  });

  it('контрфакт показа чужой картинки отвергается по содержимому DTO после проверки оригинала', () => {
    // Класс ошибки: замена ссылки на image возвращает трекеру сетевой запрос от каждого читателя канала.
    const marker = 'R279 чужой пиксель не картинка';
    rejectMutant("else if (image) m.imageLink = image.link;", "else if (image) m.image = { url: image.link };", marker,
      (api) => assert.equal(api.normalizeEmbeds([{ image: { url: 'https://tracker.invalid/pixel' } }], isOwn)[0]?.image, undefined, marker));
  });
});
