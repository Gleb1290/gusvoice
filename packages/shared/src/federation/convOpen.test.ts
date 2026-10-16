import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { fedDisplayText, fedHash, fedId, fedUsername, FED_FIELD_LIMITS } from './fieldRules.js';
import {
  convOpenWinner,
  decideFedDmOpen,
  fedDmEnabledFromEnv,
  FED_DM_NEW_LIMIT,
  FED_DM_REFUSAL,
  parseConvOpenRequest,
  parseConvOpenResponse,
  parseFedDmPolicy,
  parseRemoteHandle,
  serializeConvOpenRequest,
  serializeConvOpenResponse,
} from './convOpen.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), 'utf8'));

function loadConvOpen(source: string): typeof import('./convOpen.js') {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === './fieldRules') return { fedDisplayText, fedHash, fedId, fedUsername, FED_FIELD_LIMITS };
      throw new Error(`неожиданный импорт convOpen: ${name}`);
    },
  });
  return module.exports as typeof import('./convOpen.js');
}

type OpenRules = typeof import('./convOpen.js');

const decision = (overrides: Partial<Parameters<OpenRules['decideFedDmOpen']>[0]> = {}) =>
  decideFedDmOpen({
    exists: false,
    targetOk: true,
    hidden: false,
    blocked: false,
    sharedServer: false,
    policy: 'shared',
    ...overrides,
  });

function blockedPolicyContract(rules: Pick<OpenRules, 'decideFedDmOpen'>): void {
  assert.equal(decisionWith(rules, { blocked: true, sharedServer: true, policy: 'anyone' }), 'policy',
    'блокировка не раскрывается и маскируется отказом policy');
}

function decisionWith(rules: Pick<OpenRules, 'decideFedDmOpen'>, overrides: Partial<Parameters<OpenRules['decideFedDmOpen']>[0]>) {
  return rules.decideFedDmOpen({
    exists: false,
    targetOk: true,
    hidden: false,
    blocked: false,
    sharedServer: false,
    policy: 'shared',
    ...overrides,
  });
}

function winnerContract(rules: OpenRules): void {
  assert.equal(rules.convOpenWinner('0190a000-0000-7000-8000-000000000001', '0190a000-0000-7000-8000-000000000002'), 'mine',
    'меньший id выигрывает встречное открытие');
  assert.equal(rules.convOpenWinner('0190a000-0000-7000-8000-000000000002', '0190a000-0000-7000-8000-000000000001'), 'theirs',
    'меньший id побеждает независимо от того, чьё поле сравнивается');
  assert.equal(rules.convOpenWinner('0199d2a0-1a2b-7c3d-8e4f-5a6b7c8d9e0f', '0199d2a0-1a2b-7c3d-8e4f-5a6b7c8d9e0f'), 'mine',
    'при равном id входящий повтор встречает уже летящую локальную беседу');
}

function hiddenPolicyContract(rules: Pick<OpenRules, 'decideFedDmOpen'>): void {
  assert.equal(decisionWith(rules, { hidden: true, sharedServer: true, policy: 'anyone' }), 'hidden',
    'скрытая цель отказывает до проверки общего сервера');
}

describe('открытие личной беседы между инстансами', () => {
  it('запрос из исторической фикстуры сохраняет смысл после сериализации и разбора', () => {
    // Ловит незаметную смену обязательных полей запроса, уже отправленного соседям v1.
    const raw = fixture('conv-open-request.json');
    const parsed = parseConvOpenRequest(raw);
    assert.ok(parsed);
    assert.deepEqual(parseConvOpenRequest(serializeConvOpenRequest(parsed)), parsed);
  });

  it('ответы ok, exists и refused из исторических фикстур сохраняют смысл при roundtrip', () => {
    // Ловит переименование кодов или полей ответа, от которых зависит обработка встречного открытия.
    for (const name of ['conv-open-ok.json', 'conv-open-exists.json', 'conv-open-refused.json']) {
      const parsed = parseConvOpenResponse(fixture(name));
      assert.ok(parsed, `${name} должен разбираться`);
      assert.deepEqual(parseConvOpenResponse(serializeConvOpenResponse(parsed)), parsed, name);
    }
  });

  it('старый читатель игнорирует незнакомые поля запроса и ответа, включая профиль to', () => {
    // Ловит отказ совместимости при добавлении необязательных полей в пределах версии протокола.
    const request = fixture('conv-open-request.json') as Record<string, unknown>;
    const from = request.from as Record<string, unknown>;
    assert.deepEqual(parseConvOpenRequest({
      ...request,
      future_sender_field: { feature: 'v1-addition' },
      from: { ...from, future_profile_field: true },
    }), parseConvOpenRequest(request));

    const response = fixture('conv-open-ok.json') as Record<string, unknown>;
    const to = response.to as Record<string, unknown>;
    assert.deepEqual(parseConvOpenResponse({
      ...response,
      future_sender_field: { feature: 'v1-addition' },
      to: { ...to, future_profile_field: true },
    }), parseConvOpenResponse(response));
  });

  it('неизвестная причина отказа безопасно сводится к policy', () => {
    // Ловит падение или раскрытие случайного текста вместо общей причины для старого соседа.
    assert.deepEqual(parseConvOpenResponse({ error: 'federation.dm_refused', reason: 'newer-peer-code' }), {
      kind: 'refused',
      reason: 'policy',
    });
  });

  it('негодный UUID беседы в запросе отклоняется целиком', () => {
    // Ловит принятие произвольной строки как ключа беседы, который должен быть UUID.
    const raw = fixture('conv-open-request.json') as Record<string, unknown>;
    assert.equal(parseConvOpenRequest({ ...raw, conversation_id: 'conversation-1' }), null);
    assert.ok(parseConvOpenRequest(raw));
  });

  it('негодный created_at запроса отклоняется, а положительное время из фикстуры принимается', () => {
    // Ловит нулевое, бесконечное и нечисловое время в подписанном запросе.
    const raw = fixture('conv-open-request.json') as Record<string, unknown>;
    for (const createdAt of [0, -1, NaN, Infinity, null, '1760270300000']) {
      assert.equal(parseConvOpenRequest({ ...raw, created_at: createdAt }), null);
    }
    assert.ok(parseConvOpenRequest({ ...raw, created_at: 1 }));
    assert.ok(parseConvOpenRequest(raw));
  });

  it('негодный UUID в положительном ответе не принимается за открывшуюся беседу', () => {
    // Ловит создание теневой беседы по id, который не является частью протокольного формата.
    assert.equal(parseConvOpenResponse({ ok: true, conversation_id: 'not-a-uuid' }), null);
  });

  it('плохой логин в необязательном to отбрасывается без потери успешного ответа', () => {
    // Ловит превращение ошибки профиля в отказ от уже успешно созданной беседы.
    const raw = fixture('conv-open-ok.json') as Record<string, unknown>;
    const to = raw.to as Record<string, unknown>;
    assert.deepEqual(parseConvOpenResponse({ ...raw, to: { ...to, username: 'not a valid login!' } }), {
      kind: 'ok',
      conversationId: raw.conversation_id,
      to: null,
    });
  });

  it('уже существующая беседа побеждает даже при пропавшей цели', () => {
    // Ловит повторное раскрытие цели или создание дубля вместо идемпотентного exists.
    assert.equal(decision({ exists: true, targetOk: false }), 'exists');
  });

  it('не найденная цель отказывает раньше скрытости и блокировки', () => {
    // Ловит обход no_user, который выдавал бы постороннему статус скрытия или блокировки.
    assert.equal(decision({ targetOk: false, hidden: true, blocked: true }), FED_DM_REFUSAL.noUser);
  });

  it('скрытая цель отказывает раньше общего сервера и политики anyone', () => {
    // Ловит проверку shared до hidden, из-за которой скрытый человек становился бы доступен соседям.
    assert.equal(decision({ hidden: true, sharedServer: true, policy: 'anyone' }), FED_DM_REFUSAL.hidden);
    assert.equal(decision({ hidden: true, blocked: true }), FED_DM_REFUSAL.hidden);
  });

  it('блокировка маскируется policy даже при общем сервере и anyone', () => {
    // Ловит утечку факта блокировки в отдельный протокольный отказ.
    blockedPolicyContract({ decideFedDmOpen });
  });

  it('общий сервер разрешает открытие при политике shared', () => {
    // Ловит чрезмерный запрет легального контакта по общему серверу.
    assert.equal(decision({ sharedServer: true }), 'create');
    assert.equal(decision({ sharedServer: true, policy: 'anyone' }), 'create');
  });

  it('политика shared отказывает без общего сервера', () => {
    // Ловит превращение значения по умолчанию в разрешение писать любому соседу.
    assert.equal(decision({ sharedServer: false, policy: 'shared' }), FED_DM_REFUSAL.policy);
  });

  it('anyone разрешает только ветку create-limited с заданным часовым пределом', () => {
    // Ловит неограниченную ветку открытия вместо результата, на котором вызывающий расходует лимит.
    assert.equal(decision({ policy: 'anyone' }), 'create-limited');
    assert.deepEqual(FED_DM_NEW_LIMIT, { max: 10, windowS: 3600 });
  });

  it('при равных id локальная беседа остаётся победителем', () => {
    // Ловит ответ не-exists: обработчик встречного открытия для equal id возвращает id in-flight беседы.
    const id = '0199d2a0-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    assert.equal(convOpenWinner(id, id), 'mine');
  });

  it('меньший id побеждает независимо от стороны встречи', () => {
    // Ловит выбор большего id, который создавал бы две расходящиеся копии одной пары.
    assert.equal(convOpenWinner('a-id', 'b-id'), 'mine');
    assert.equal(convOpenWinner('b-id', 'a-id'), 'theirs');
  });

  it('адрес соседа с @ и доменом принимается с нормализованным регистром', () => {
    // Ловит ложный отказ от корректного поиска соседа из-за регистра домена или имени.
    assert.deepEqual(parseRemoteHandle('@Anna@Voice.Example:8443'), { username: 'anna', domain: 'voice.example:8443' });
  });

  it('адрес без домена или с недопустимыми символами не уходит в удалённый поиск', () => {
    // Ловит отправку локального текста на произвольный домен как федеративного поиска.
    assert.equal(parseRemoteHandle('@anna'), null);
    assert.equal(parseRemoteHandle('@an na@voice.example'), null);
  });

  it('DM-федерация включается только при двух true-флагах без учёта регистра', () => {
    // Ловит включение DM при одном лишь общем флаге или неверном значении любого из двух флагов.
    assert.equal(fedDmEnabledFromEnv({ FEDERATION_ENABLED: 'TRUE', FEDERATION_DM_ENABLED: 'true' }), true);
    assert.equal(fedDmEnabledFromEnv({ FEDERATION_ENABLED: 'true', FEDERATION_DM_ENABLED: 'false' }), false);
    assert.equal(fedDmEnabledFromEnv({ FEDERATION_ENABLED: 'false', FEDERATION_DM_ENABLED: 'true' }), false);
    assert.equal(fedDmEnabledFromEnv({}), false);
  });

  it('неизвестная политика по умолчанию становится shared, а anyone читается из записи', () => {
    // Ловит случайное открытие личных сообщений при пустой, старой или повреждённой настройке.
    assert.equal(parseFedDmPolicy('anyone'), 'anyone');
    assert.equal(parseFedDmPolicy({ policy: 'anyone' }), 'anyone');
    assert.equal(parseFedDmPolicy('future-policy'), 'shared');
    assert.equal(parseFedDmPolicy({ policy: 42 }), 'shared');
  });

  it('контрфакт: целый модуль отвергает отдельный blocked вместо policy', () => {
    // Ловит раскрытие факта блокировки реальным модулем после изменения ветки отказа.
    const source = readFileSync(new URL('./convOpen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    blockedPolicyContract(loadConvOpen(source));
    const anchor = '  if (input.blocked) return FED_DM_REFUSAL.policy;';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь маскировки блокировки должен быть уникальным');
    assert.throws(
      () => blockedPolicyContract(loadConvOpen(source.replace(anchor, "  if (input.blocked) return 'blocked' as FedDmRefusal;"))),
      (error) => error instanceof assert.AssertionError && error.message.includes('блокировка не раскрывается и маскируется отказом policy'),
      'контракт должен отвергнуть модульный мутант с раскрытой блокировкой',
    );
  });

  it('контрфакт: целый модуль отвергает победу большего id', () => {
    // Ловит расхождение id при встречном открытии, которое плодило бы параллельные беседы.
    const source = readFileSync(new URL('./convOpen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    winnerContract(loadConvOpen(source));
    const anchor = "  return mine <= theirs ? 'mine' : 'theirs';";
    assert.equal(source.split(anchor).length - 1, 1, 'якорь выбора меньшего id должен быть уникальным');
    assert.throws(
      () => winnerContract(loadConvOpen(source.replace(anchor, "  return mine >= theirs ? 'mine' : 'theirs';"))),
      (error) => error instanceof assert.AssertionError && error.message.includes('меньший id выигрывает встречное открытие'),
      'контракт должен отвергнуть модульный мутант, выбирающий больший id',
    );
  });

  it('контрфакт: целый модуль отвергает проверку hidden после общего сервера', () => {
    // Ловит доступ к скрытой цели, если shared-ветка срабатывает раньше проверки видимости.
    const source = readFileSync(new URL('./convOpen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    hiddenPolicyContract(loadConvOpen(source));
    const anchor = [
      '  if (input.hidden) return FED_DM_REFUSAL.hidden;',
      '  if (input.blocked) return FED_DM_REFUSAL.policy;',
      "  if (input.sharedServer) return 'create';",
    ].join('\n');
    const mutant = [
      '  if (input.blocked) return FED_DM_REFUSAL.policy;',
      "  if (input.sharedServer) return 'create';",
      '  if (input.hidden) return FED_DM_REFUSAL.hidden;',
    ].join('\n');
    assert.equal(source.split(anchor).length - 1, 1, 'якорь порядка hidden/shared должен быть уникальным');
    assert.throws(
      () => hiddenPolicyContract(loadConvOpen(source.replace(anchor, mutant))),
      (error) => error instanceof assert.AssertionError && error.message.includes('скрытая цель отказывает до проверки общего сервера'),
      'контракт должен отвергнуть модульный мутант с поздней проверкой hidden',
    );
  });
});
