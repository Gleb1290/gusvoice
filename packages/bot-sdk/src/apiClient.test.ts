import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { setImmediate as eventLoopCheckpoint } from 'node:timers/promises';
import { Script } from 'node:vm';
import ts from 'typescript';
import { Api, GusVoiceApiError, normalizeBase, type ApiOptions } from './apiClient.js';
import { InlineKeyboard } from './keyboard.js';

const baseUrl = 'https://sdk.example.test';
const token = 'public-test-bot-token';
const apiSource = readFileSync(new URL('./apiClient.ts', import.meta.url), 'utf8');
const jsonResponse = (body: unknown, status = 200, headers?: ConstructorParameters<typeof Headers>[0]) =>
  new Response(JSON.stringify(body), { status, headers });
const success = (result: unknown = true) => jsonResponse({ ok: true, result });
const limited = (retryAfter = 1) => jsonResponse({
  ok: false, error_code: 429, description: 'too many requests', retry_after: retryAfter,
}, 429);
const makeApi = (fetchFn: typeof fetch, options: Partial<ApiOptions> = {}) =>
  new Api(token, { baseUrl, discover: false, fetch: fetchFn, ...options });

/** Тикают только явно выбранные таймеры: 2 повтора по секунде не замедляют гейт на 2 секунды. */
class Clock {
  private nextId = 0;
  private pending = new Map<number, { callback: () => void; ms: number }>();
  readonly delays: number[] = [];

  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.nextId;
    this.delays.push(ms);
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(id: number): void { this.pending.delete(id); }

  fireRetry(): void {
    const timer = [...this.pending].find(([, entry]) => entry.ms === 1000);
    assert.ok(timer, 'повтор обязан ждать retry_after:1, а не таймаут запроса');
    this.pending.delete(timer[0]);
    timer[1].callback();
  }

  get size(): number { return this.pending.size; }
}

// Исполняется ЦЕЛЫЙ реальный модуль; меняются окружение часов и (только в мутанте) одна строка.
// Импортировать кусок функции и проверять его копию здесь было бы ложным доказательством.
function controlledApi(source: string, clock: Clock): typeof import('./apiClient.js') {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: 'apiClient.ts',
  }).outputText;
  const exports = {};
  new Script(compiled, { filename: 'apiClient.test-vm.cjs' }).runInNewContext({
    exports, AbortController, Blob, FormData, Uint8Array, URL,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
  });
  return exports as typeof import('./apiClient.js');
}

// Даём host Response.text() завершить также задачи потоков/nextTick, не угадывая число микрозадач.
// Это один оборот event loop, не ожидание wall clock; таймеры самого SDK остаются управляемыми.
async function settle(): Promise<void> {
  await eventLoopCheckpoint();
}

async function retryScenario(source: string): Promise<void> {
  const clock = new Clock();
  const { Api: ControlledApi } = controlledApi(source, clock);
  let calls = 0;
  const result = 'synthetic-message';
  const api = new ControlledApi(token, {
    baseUrl, discover: false, maxRetryAfter: 1,
    fetch: async () => ++calls <= 2 ? limited() : success(result),
  });
  // Обе ветки перехвачены сразу: мутант не оставляет необработанного rejection.
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  const completion = api.call('getMe').then(
    value => { outcome = { ok: true, value }; },
    error => { outcome = { ok: false, error }; },
  );
  await settle();
  assert.equal(calls, 1);
  assert.equal(outcome, undefined, '429 не должен завершать метод до повтора');
  clock.fireRetry();
  await settle();
  assert.equal(calls, 2, 'после первой паузы запрос повторяется, а не выбрасывает старую 429');
  assert.equal(outcome, undefined);
  clock.fireRetry();
  await completion;
  assert.deepEqual(outcome, { ok: true, value: result });
  assert.equal(calls, 3, 'два 429 и успех — ровно три запроса');
  assert.deepEqual(clock.delays.filter(ms => ms === 1000), [1000, 1000]);
  assert.equal(clock.size, 0, 'таймеры завершённых запросов и повторов очищены');
}

describe('адрес Bot API', () => {
  it('обрезает пробелы, хвостовые слеши и /api, не дублируя префикс методов', () => {
    assert.equal(normalizeBase('  https://sdk.example.test/api///  '), baseUrl);
    assert.equal(normalizeBase(`${baseUrl}///`), baseUrl);
    assert.equal(normalizeBase(`${baseUrl}/nested/api/`), `${baseUrl}/nested`);
    assert.equal(normalizeBase(`${baseUrl}/api-v2`), `${baseUrl}/api-v2`);
  });

  it('принимает https и http, включая регистр схемы', () => {
    assert.equal(normalizeBase(baseUrl), baseUrl);
    assert.equal(normalizeBase('http://sdk.example.test/api'), 'http://sdk.example.test');
    assert.equal(normalizeBase('HTTPS://sdk.example.test/'), 'HTTPS://sdk.example.test');
  });

  it('не-http адреса отклоняются до отправки токена', () => {
    for (const address of ['file:///public-test', 'javascript:alert(1)', 'ftp://sdk.example.test', '//sdk.example.test', '']) {
      assert.throws(() => normalizeBase(address), TypeError, address);
    }
  });

  it('использует apiUrl из config.json и нормализует его перед отправкой метода', async () => {
    const requests: string[] = [];
    const api = makeApi(async (url, init) => {
      requests.push(String(url));
      if (requests.length === 1) {
        assert.equal(new Headers(init?.headers).get('authorization'), null, 'config.json не получает токен');
        assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
        return jsonResponse({ apiUrl: ' https://api.example.test/api/// ' });
      }
      return success('done');
    }, { discover: true });
    assert.equal(await api.call('getMe'), 'done');
    assert.deepEqual(requests, [`${baseUrl}/config.json`, 'https://api.example.test/api/bot/v1/getMe']);
    assert.equal(await api.apiUrl(), 'https://api.example.test');
    assert.equal(requests.length, 2, 'успешное обнаружение закешировано');
  });

  it('относительный apiUrl разрешается от адреса сайта', async () => {
    const api = makeApi(async () => jsonResponse({ apiUrl: './backend/api/' }), { discover: true });
    assert.equal(await api.apiUrl(), `${baseUrl}/backend`);
  });

  it('404 config.json оставляет исходный baseUrl', async () => {
    const api = makeApi(async () => new Response('not found', { status: 404 }), { discover: true });
    assert.equal(await api.apiUrl(), baseUrl);
  });

  it('пустой, неподходящий и не-JSON config.json оставляет исходный baseUrl', async () => {
    for (const body of ['', '{}', 'null', '{"apiUrl":"   "}', '{"apiUrl":42}', 'not json']) {
      const api = makeApi(async () => new Response(body), { discover: true });
      assert.equal(await api.apiUrl(), baseUrl, body);
    }
  });

  it('discover:false не запрашивает config.json даже перед первым методом', async () => {
    const requests: string[] = [];
    const api = makeApi(async url => { requests.push(String(url)); return success(); });
    assert.equal(await api.apiUrl(), baseUrl);
    assert.deepEqual(requests, []);
    assert.equal(await api.call('getMe'), true);
    assert.deepEqual(requests, [`${baseUrl}/api/bot/v1/getMe`]);
  });

  it('одновременные читатели разделяют единственный запрос config.json', async () => {
    let calls = 0;
    let resolveFetch!: (value: Response) => void;
    const api = makeApi(async () => {
      calls++;
      return new Promise<Response>(resolve => { resolveFetch = resolve; });
    }, { discover: true });
    const first = api.apiUrl();
    const second = api.apiUrl();
    assert.equal(calls, 1);
    resolveFetch(jsonResponse({ apiUrl: 'https://api.example.test' }));
    assert.deepEqual(await Promise.all([first, second]), ['https://api.example.test', 'https://api.example.test']);
  });

  it('не-http apiUrl из config.json отклоняется, метод и токен туда не уходят', async () => {
    const requests: string[] = [];
    const api = makeApi(async url => {
      requests.push(String(url));
      return jsonResponse({ apiUrl: 'file:///public-test' });
    }, { discover: true });
    await assert.rejects(api.call('getMe'), TypeError);
    assert.deepEqual(requests, [`${baseUrl}/config.json`]);
  });

  it('сетевая ошибка обнаружения не кешируется навсегда', async () => {
    const failure = new Error('synthetic network error');
    let calls = 0;
    const api = makeApi(async () => {
      if (++calls === 1) throw failure;
      return jsonResponse({ apiUrl: 'https://api.example.test' });
    }, { discover: true });
    await assert.rejects(api.apiUrl(), error => error === failure);
    assert.equal(await api.apiUrl(), 'https://api.example.test');
    assert.equal(calls, 2);
  });
});

describe('вызовы Bot API', () => {
  it('два 429 с retry_after:1 повторяются и третий ответ принимается, включая границу maxRetryAfter', async () => {
    await retryScenario(apiSource);
  });

  it('maxRetries:0 возвращает исходную 429 с retryAfter без повторов', async () => {
    let calls = 0;
    const api = makeApi(async () => { calls++; return limited(1); }, { maxRetries: 0 });
    await assert.rejects(api.call('getMe'), error => {
      assert.ok(error instanceof GusVoiceApiError);
      assert.equal(error.code, 429);
      assert.equal(error.retryAfter, 1);
      assert.equal(error.description, 'too many requests');
      assert.equal(error.method, 'getMe');
      return true;
    });
    assert.equal(calls, 1);
  });

  it('retry_after на секунду больше maxRetryAfter сразу возвращает ошибку', async () => {
    let calls = 0;
    const api = makeApi(async () => { calls++; return limited(2); }, { maxRetryAfter: 1 });
    await assert.rejects(api.call('getMe'), error => {
      assert.ok(error instanceof GusVoiceApiError);
      assert.equal(error.code, 429);
      assert.equal(error.retryAfter, 2);
      return true;
    });
    assert.equal(calls, 1);
  });

  it('после разрешённых двух повторов третья 429 завершает метод, не создавая бесконечного цикла', async () => {
    const clock = new Clock();
    const { Api: ControlledApi, GusVoiceApiError: ControlledError } = controlledApi(apiSource, clock);
    let calls = 0;
    const api = new ControlledApi(token, {
      baseUrl, discover: false, maxRetries: 2,
      fetch: async () => { calls++; return limited(); },
    });
    const checked = assert.rejects(api.call('getMe'), error => {
      assert.ok(error instanceof ControlledError);
      assert.equal(error.code, 429);
      assert.equal(error.retryAfter, 1);
      return true;
    });
    await settle();
    clock.fireRetry();
    await settle();
    clock.fireRetry();
    await checked;
    assert.equal(calls, 3);
    assert.equal(clock.size, 0);
  });

  it('не-JSON ответ прокси 502 становится GusVoiceApiError с HTTP-кодом', async () => {
    const api = makeApi(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    await assert.rejects(api.call('getMe'), error => {
      assert.ok(error instanceof GusVoiceApiError);
      assert.equal(error.code, 502);
      assert.equal(error.description, 'HTTP 502');
      assert.equal(error.retryAfter, undefined);
      return true;
    });
  });

  it('числовой Retry-After сохраняется и при не-JSON 429', async () => {
    const api = makeApi(async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } }), { maxRetries: 0 });
    await assert.rejects(api.call('getMe'), error => {
      assert.ok(error instanceof GusVoiceApiError);
      assert.equal(error.code, 429);
      assert.equal(error.retryAfter, 7);
      return true;
    });
  });

  it('429 без допустимого Retry-After не повторяется вслепую', async () => {
    for (const header of [undefined, 'soon', '-1', '1.5']) {
      let calls = 0;
      const api = makeApi(async () => {
        calls++;
        return new Response('rate limited', { status: 429, headers: header === undefined ? {} : { 'retry-after': header } });
      });
      await assert.rejects(api.call('getMe'), error => {
        assert.ok(error instanceof GusVoiceApiError);
        assert.equal(error.code, 429);
        assert.equal(error.retryAfter, undefined);
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it('JSON-метод отправляет POST, параметры и Authorization: Bot, возвращая только result', async () => {
    const params = { chat_id: 'chat-1', text: 'Привет' };
    const api = makeApi(async (url, init) => {
      assert.equal(String(url), `${baseUrl}/api/bot/v1/sendMessage`);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bot ${token}`);
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), params);
      assert.equal(init?.signal?.aborted, false);
      return success({ message_id: 'message-1' });
    });
    assert.deepEqual(await api.call('sendMessage', params), { message_id: 'message-1' });
  });

  it('multipart передаёт chat_id/text/embeds и упорядоченные файлы с именами, без ручного boundary', async () => {
    const embeds = [{ title: 'Карточка', fields: [{ name: 'name', value: 'value', inline: false }] }];
    let calls = 0;
    const api = makeApi(async (url, init) => {
      calls++;
      assert.equal(String(url), `${baseUrl}/api/bot/v1/sendMessage`);
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bot ${token}`);
      assert.equal(headers.get('content-type'), null, 'fetch сам добавит multipart boundary');
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      assert.equal(form.get('chat_id'), 'chat-1');
      assert.equal(form.get('text'), 'Привет');
      assert.equal(form.get('embeds'), JSON.stringify(embeds));
      assert.equal(form.get('reply_to_message_id'), null);
      assert.deepEqual([...form.keys()], ['chat_id', 'text', 'embeds', 'files[0]', 'files[1]', 'files[2]']);
      for (const [index, expected] of [
        { name: 'first.txt', type: 'text/plain', bytes: [65, 66] },
        { name: 'second.bin', type: 'application/octet-stream', bytes: [0, 255] },
        { name: 'file', type: '', bytes: [7] },
      ].entries()) {
        const file = form.get(`files[${index}]`);
        assert.ok(file && typeof file !== 'string');
        assert.equal(file.name, expected.name);
        assert.equal(file.type, expected.type);
        assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], expected.bytes);
      }
      return success({ message_id: 'sent' });
    });
    assert.deepEqual(await api.sendMessage('chat-1', 'Привет', {
      embeds,
      files: [
        { data: new Blob(['AB'], { type: 'text/plain' }), name: 'first.txt' },
        { data: new Uint8Array([0, 255]), name: 'second.bin', type: 'application/octet-stream' },
        new Uint8Array([7]),
      ],
    }), { message_id: 'sent' });
    assert.equal(calls, 1);
  });
});

describe('контрфакт SDK: повтор 429', () => {
  it('исходный модуль проходит сценарий, а удаление continue ловится именно ERR_ASSERTION', async () => {
    await retryScenario(apiSource);
    const needle = '        continue;';
    assert.equal(apiSource.split(needle).length - 1, 1, 'мутируется ровно одна ветка повторов');
    const mutant = apiSource.replace(needle, '        /* mutant: retry falls through */');
    await assert.rejects(retryScenario(mutant), error => {
      assert.ok(error instanceof assert.AssertionError, 'не принимаем ошибку VM/импорта вместо пойманной регрессии');
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.equal(error.actual, 1);
      assert.equal(error.expected, 2);
      assert.equal(error.operator, 'strictEqual');
      assert.equal(error.message.split('\n')[0], 'после первой паузы запрос повторяется, а не выбрасывает старую 429');
      return true;
    });
  });
});

describe('R301 Api — команды, клавиатура и ответы на нажатия по настоящему JSON-проводу', () => {
  it('set/get/deleteMyCommands передают команды и scope, возвращая result без обёртки', async () => {
    const commands = [{ command: 'status', description: 'Состояние 🪿' }];
    const calls: unknown[] = [];
    const api = makeApi(async (url, init) => {
      calls.push([String(url).split('/').at(-1), JSON.parse(String(init?.body))]);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bot ${token}`);
      return success(String(url).endsWith('/getMyCommands') ? commands : true);
    });
    assert.equal(await api.setMyCommands(commands, { scope: { type: 'all_private_chats' } }), true);
    assert.deepEqual(await api.getMyCommands({ scope: { type: 'all_private_chats' } }), commands);
    assert.equal(await api.deleteMyCommands({ scope: { type: 'default' } }), true);
    assert.deepEqual(calls, [
      ['setMyCommands', { commands, scope: { type: 'all_private_chats' } }],
      ['getMyCommands', { scope: { type: 'all_private_chats' } }],
      ['deleteMyCommands', { scope: { type: 'default' } }],
    ]);
  });

  it('пустой список команд и вызовы без scope не дописывают лишних полей', async () => {
    const bodies: unknown[] = [];
    const api = makeApi(async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return success(String(url).endsWith('/getMyCommands') ? [] : true);
    });
    assert.equal(await api.setMyCommands([]), true);
    assert.deepEqual(await api.getMyCommands(), []);
    assert.equal(await api.deleteMyCommands(), true);
    assert.deepEqual(bodies, [{ commands: [] }, {}, {}]);
  });

  it('sendMessage и editMessageText сериализуют сборщик без хвостового пустого ряда и читают Message с кнопками', async () => {
    const kb = new InlineKeyboard().text('Статус', 'st').row();
    const markup = kb.build();
    const message = { message_id: 'panel', chat: { id: 'chat', type: 'dm' }, text: 'Панель', reply_markup: markup };
    const calls: unknown[] = [];
    const api = makeApi(async (url, init) => {
      calls.push([String(url).split('/').at(-1), JSON.parse(String(init?.body))]);
      return success(message);
    });
    assert.deepEqual(await api.sendMessage('chat', 'Панель', { reply_markup: kb }), message);
    assert.deepEqual(await api.editMessageText('chat', 'panel', 'Панель', { reply_markup: kb }), message);
    assert.deepEqual(calls, [
      ['sendMessage', { chat_id: 'chat', text: 'Панель', reply_markup: markup }],
      ['editMessageText', { chat_id: 'chat', message_id: 'panel', text: 'Панель', reply_markup: markup }],
    ]);
  });

  it('multipart с карточкой и файлом отправляет reply_markup одной JSON-строкой', async () => {
    const kb = new InlineKeyboard().text('A', 'a').row();
    const api = makeApi(async (_, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('reply_markup'), JSON.stringify(kb.build()));
      assert.equal(init.body.get('embeds'), JSON.stringify([{ title: 'Панель' }]));
      assert.equal(init.body.get('text'), null);
      assert.ok(init.body.get('files[0]'));
      return success({ message_id: 'panel', reply_markup: kb.build() });
    });
    assert.deepEqual(await api.sendMessage('chat', undefined, {
      embeds: [{ title: 'Панель' }], reply_markup: kb, files: [new Uint8Array([1])],
    }), { message_id: 'panel', reply_markup: kb.build() });
  });

  it('editMessageReplyMarkup меняет сборщик или готовую разметку, отсутствие аргумента не посылает старые кнопки', async () => {
    const kb = new InlineKeyboard().text('A', 'a');
    const markup = kb.build();
    const bodies: unknown[] = [];
    const api = makeApi(async (url, init) => {
      assert.equal(String(url), `${baseUrl}/api/bot/v1/editMessageReplyMarkup`);
      bodies.push(JSON.parse(String(init?.body)));
      return success({ message_id: 'panel', text: 'Панель', ...(bodies.length < 3 ? { reply_markup: markup } : {}) });
    });
    assert.deepEqual((await api.editMessageReplyMarkup('chat', 'panel', kb)).reply_markup, markup);
    assert.deepEqual((await api.editMessageReplyMarkup('chat', 'panel', markup)).reply_markup, markup);
    assert.equal((await api.editMessageReplyMarkup('chat', 'panel')).reply_markup, undefined);
    assert.deepEqual(bodies, [
      { chat_id: 'chat', message_id: 'panel', reply_markup: markup },
      { chat_id: 'chat', message_id: 'panel', reply_markup: markup }, { chat_id: 'chat', message_id: 'panel' },
    ]);
  });

  it('editMessageText без разметки и sendMessage без разметки оставляют поле отсутствующим', async () => {
    const bodies: unknown[] = [];
    const api = makeApi(async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return success({ message_id: 'panel' }); });
    await api.editMessageText('chat', 'panel', 'Обновлено');
    await api.sendMessage('chat', 'Без кнопок');
    assert.deepEqual(bodies, [{ chat_id: 'chat', message_id: 'panel', text: 'Обновлено' }, { chat_id: 'chat', text: 'Без кнопок' }]);
  });

  it('answerCallbackQuery посылает id, текст и явный false, а пустой ответ только id', async () => {
    const bodies: unknown[] = [];
    const api = makeApi(async (url, init) => {
      assert.equal(String(url), `${baseUrl}/api/bot/v1/answerCallbackQuery`);
      bodies.push(JSON.parse(String(init?.body)));
      return success();
    });
    assert.equal(await api.answerCallbackQuery('cbq-1', { text: 'Готово', show_alert: true }), true);
    assert.equal(await api.answerCallbackQuery('cbq-2', { text: '', show_alert: false }), true);
    assert.equal(await api.answerCallbackQuery('cbq-3'), true);
    assert.deepEqual(bodies, [
      { callback_query_id: 'cbq-1', text: 'Готово', show_alert: true },
      { callback_query_id: 'cbq-2', text: '', show_alert: false }, { callback_query_id: 'cbq-3' },
    ]);
  });

  it('просроченный ответ 400 остаётся GusVoiceApiError конкретного метода, не превращается в успех', async () => {
    const description = 'query is too old and response timeout expired or query id is invalid';
    const api = makeApi(async () => jsonResponse({ ok: false, error_code: 400, description }, 400));
    await assert.rejects(api.answerCallbackQuery('expired'), error => {
      assert.ok(error instanceof GusVoiceApiError);
      assert.equal(error.method, 'answerCallbackQuery');
      assert.equal(error.code, 400);
      assert.equal(error.description, description);
      return true;
    });
  });
});
