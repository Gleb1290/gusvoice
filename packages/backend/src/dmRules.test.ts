import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { canWriteDm, decideDmOpen, dmPair, openDm, parseDmPolicy, dmOpenRefusal, dmNewLimitError, type OpenDmIo } from './dmRules.js';

it('откат отказа лимита и ранний расход попытки отвергаются тем же контрактом открытия', async () => {
  // Без проверки откатом тест может описывать правильный результат, не замечая запрещённой вставки или раннего расхода.
  const raw = readFileSync(new URL('./dmRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const load = (source: string) => {
    const box = { exports: {} };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, box);
    return box.exports as typeof import('./dmRules.js');
  };
  const contract = async (rules: typeof import('./dmRules.js')) => {
    for (const reachable of [true, false]) {
      let spent = 0, inserted = 0;
      const result = await rules.openDm({ findExisting: async () => null, shareServer: async () => false,
        initiatorIsSuperAdmin: () => false, policy: async () => 'anyone', peerReachable: () => reachable,
        spendNewDm: async () => { spent++; return 61; }, create: async () => { inserted++; return { id: 'new' }; },
      }, 'a', 'b');
      assert.equal(result.ok, false); assert.equal(inserted, 0); assert.equal(spent, reachable ? 1 : 0);
    }
  };
  await contract(load(raw));
  for (const [from, to] of [
    ['if (retryAfter > 0)', 'if (false)'],
    ["if (verdict === 'no-shared-server' || verdict === 'peer-unreachable')", "if (verdict === 'no-shared-server')"],
  ]) {
    assert.ok(raw.includes(from), 'найден якорь отказа');
    await assert.rejects(() => contract(load(raw.replace(from, to))), assert.AssertionError);
  }
});

it('anyone разрешает новую ограниченную беседу только с доступным собеседником', () => {
  // Отдельный вердикт необходим, чтобы новая политика не обходила почасовой предел.
  const base = { exists: false, sharedServer: false, initiatorIsSuperAdmin: false, policy: 'anyone' as const };
  assert.equal(decideDmOpen({ ...base, peerReachable: true }), 'create-limited');
  assert.equal(decideDmOpen({ ...base, peerReachable: false }), 'peer-unreachable');
  assert.equal(decideDmOpen({ ...base, exists: true, peerReachable: false }), 'open-existing');
  assert.equal(decideDmOpen({ ...base, sharedServer: true, peerReachable: false }), 'create');
  assert.equal(decideDmOpen({ ...base, initiatorIsSuperAdmin: true, peerReachable: false }), 'create');
});

it('битая политика закрывается до shared, а обе известные политики принимаются', () => {
  // Повреждённая настройка не должна молча открывать личку всем.
  for (const raw of [null, undefined, {}, 'anyone', { policy: 'ANYONE' }, { policy: true }]) assert.equal(parseDmPolicy(raw), 'shared');
  assert.equal(parseDmPolicy({ policy: 'shared' }), 'shared');
  assert.equal(parseDmPolicy({ policy: 'anyone' }), 'anyone');
});

it('существующая беседа, общий сервер и супер-админ не спрашивают политику и лимит', async () => {
  // Дополнительный I/O не должен отнимать существующую беседу при отказе настроек или Redis.
  for (const mode of ['existing', 'shared', 'admin']) {
    const calls: string[] = [];
    const result = await openDm({
      findExisting: async () => mode === 'existing' ? { id: 'existing' } : null,
      shareServer: async () => mode === 'shared', initiatorIsSuperAdmin: () => mode === 'admin',
      policy: async () => { calls.push('policy'); throw new Error('unexpected'); },
      peerReachable: () => { calls.push('peer'); throw new Error('unexpected'); },
      spendNewDm: async () => { calls.push('spend'); throw new Error('unexpected'); },
      create: async () => { calls.push('create'); return { id: 'new' }; },
    }, 'a', 'b');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, mode === 'existing' ? [] : ['create']);
  }
});

it('предел тратится последним перед вставкой, retryAfter не допускает вставки', async () => {
  // Отказы видимости не расходуют лимит, а превышение лимита не создаёт пустую беседу.
  for (const reachable of [false, true]) for (const retryAfter of [0, 61]) {
    const calls: string[] = [];
    const result = await openDm({
      findExisting: async () => { calls.push('find'); return null; },
      shareServer: async () => { calls.push('shared'); return false; }, initiatorIsSuperAdmin: () => false,
      policy: async () => { calls.push('policy'); return 'anyone'; },
      peerReachable: () => { calls.push('peer'); return reachable; },
      spendNewDm: async () => { calls.push('spend'); return retryAfter; },
      create: async () => { calls.push('create'); return { id: 'new' }; },
    }, 'a', 'b');
    assert.deepEqual(calls, ['find', 'shared', 'policy', 'peer', ...(reachable ? ['spend', ...(retryAfter === 0 ? ['create'] : [])] : [])]);
    assert.deepEqual(result, !reachable ? { ok: false, reason: 'peer-unreachable' } : retryAfter > 0 ? { ok: false, reason: 'new-limit', retryAfter } : { ok: true, row: { id: 'new' } });
  }
});

it('отказы открытия сохраняют reason и Retry-After, минуты округляются вверх', () => {
  // Клиент ветвится по машинной причине; старый клиент читает человекочитаемый текст.
  const shared = dmOpenRefusal({ ok: false, reason: 'no-shared-server' });
  assert.equal(shared.status, 403); assert.equal(shared.body.reason, 'dm.no_shared_server');
  const unreachable = dmOpenRefusal({ ok: false, reason: 'peer-unreachable' });
  assert.deepEqual(unreachable, { status: 404, body: { error: 'Пользователь не найден' } });
  const limited = dmOpenRefusal({ ok: false, reason: 'new-limit', retryAfter: 61 });
  assert.equal(limited.status, 429); assert.equal(limited.retryAfter, 61); assert.equal(limited.body.reason, 'dm.new_limit');
  for (const [sec, min] of [[0, 1], [1, 1], [60, 1], [61, 2], [3600, 60]]) assert.match(dmNewLimitError(sec), new RegExp(`через ${min} мин\\.`));
});

describe('открытие личной переписки (F0, #139)', () => {
  it('новую беседу без общего сервера открыть нельзя', () => {
    // Ловит возврат к «POST /dm с любым id»: спам в личку кому угодно на инстансе.
    assert.equal(decideDmOpen({ exists: false, sharedServer: false, initiatorIsSuperAdmin: false }), 'no-shared-server');
  });

  it('с общим сервером новая беседа создаётся', () => {
    // Ловит перегиб, при котором личка пропала бы и у законных соседей по серверу.
    assert.equal(decideDmOpen({ exists: false, sharedServer: true, initiatorIsSuperAdmin: false }), 'create');
  });

  it('существующая беседа открывается и без общего сервера', () => {
    // Ловит потерю истории у двоих, когда один из них вышел из общего сервера.
    assert.equal(decideDmOpen({ exists: true, sharedServer: false, initiatorIsSuperAdmin: false }), 'open-existing');
  });

  it('супер-админ может написать любому', () => {
    // Ловит отказ держателю инстанса связаться с человеком, с которым у него нет сервера.
    assert.equal(decideDmOpen({ exists: false, sharedServer: false, initiatorIsSuperAdmin: true }), 'create');
  });
});

describe('полный порядок открытия личной переписки (#143)', () => {
  type Row = { id: string };

  function io(overrides: Partial<OpenDmIo<Row>> = {}): OpenDmIo<Row> {
    return {
      findExisting: async () => null,
      shareServer: async () => false,
      initiatorIsSuperAdmin: () => false,
      create: async () => ({ id: 'created' }),
      ...overrides,
    };
  }

  it('пара имеет один порядок независимо от инициатора, включая одинаковые id', () => {
    // Ловит две строки одной беседы при обратном порядке участников.
    assert.deepEqual(dmPair('z', 'a'), ['a', 'z']);
    assert.deepEqual(dmPair('a', 'z'), ['a', 'z']);
    assert.deepEqual(dmPair('a', 'a'), ['a', 'a']);
  });

  it('существующая беседа не спрашивает общий сервер и не создаётся заново', async () => {
    // Ловит отъём истории после выхода из общего сервера и лишнюю вставку поверх найденной строки.
    const calls: string[] = [];
    const row = { id: 'existing' };
    const result = await openDm(io({
      findExisting: async (a, b) => (calls.push(`find:${a}:${b}`), row),
      shareServer: async () => (calls.push('share'), false),
      create: async () => (calls.push('create'), null),
    }), 'z', 'a');
    assert.deepEqual(result, { ok: true, row });
    assert.deepEqual(calls, ['find:a:z']);
  });

  it('без общего сервера отказ происходит до создания', async () => {
    // Ловит обход правила через вызов create после отрицательной проверки соседства.
    let creates = 0;
    const result = await openDm(io({ create: async () => (creates += 1, { id: 'bad' }) }), 'me', 'other');
    assert.deepEqual(result, { ok: false, reason: 'no-shared-server' });
    assert.equal(creates, 0);
  });

  it('общий сервер создаёт ровно упорядоченную пару', async () => {
    // Ловит запись участников в порядке запроса вместо канонического порядка уникального индекса.
    let pair: string[] = [];
    const result = await openDm(io({
      shareServer: async () => true,
      create: async (a, b) => (pair = [a, b], { id: 'new' }),
    }), 'z', 'a');
    assert.deepEqual(result, { ok: true, row: { id: 'new' } });
    assert.deepEqual(pair, ['a', 'z']);
  });

  it('супер-админ создаёт беседу без общего сервера', async () => {
    // Ловит потерю явно разрешённого служебного пути при отрицательном shareServer.
    const result = await openDm(io({ initiatorIsSuperAdmin: () => true }), 'me', 'other');
    assert.deepEqual(result, { ok: true, row: { id: 'created' } });
  });

  it('проигравшая вставка перечитывает строку, созданную конкурентом', async () => {
    // Ловит падение одного из двух одновременных POST /dm на уникальном индексе пары.
    let finds = 0;
    const raced = { id: 'raced' };
    const result = await openDm(io({
      findExisting: async () => (++finds === 1 ? null : raced),
      shareServer: async () => true,
      create: async () => null,
    }), 'me', 'other');
    assert.deepEqual(result, { ok: true, row: raced });
    assert.equal(finds, 2);
  });

  it('невозможное состояние после проигранной вставки называется явно', async () => {
    // Ловит возврат undefined и поздний неинформативный TypeError при сериализации ответа.
    await assert.rejects(
      openDm(io({ shareServer: async () => true, create: async () => null }), 'me', 'other'),
      /не удалось ни создать беседу, ни найти/,
    );
  });
});

describe('право писать в существующую личную переписку', () => {
  it('неучастнику возвращается скрывающий существование беседы отказ', () => {
    // Ловит раскрытие существования чужой беседы через последующие проверки собеседника.
    assert.equal(canWriteDm({ member: false, peerExists: true, peerDeleted: false }), 'not-a-member');
  });

  it('пропавший или удалённый собеседник одинаково запрещает запись', () => {
    // Ловит отправку сообщения в беседу, где физического получателя уже нет.
    assert.equal(canWriteDm({ member: true, peerExists: false, peerDeleted: false }), 'peer-gone');
    assert.equal(canWriteDm({ member: true, peerExists: true, peerDeleted: true }), 'peer-gone');
  });

  it('живому собеседнику участник писать может', () => {
    // Парный принимающий случай не даёт запретам случайно закрыть все личные сообщения.
    assert.equal(canWriteDm({ member: true, peerExists: true, peerDeleted: false }), 'ok');
  });
});
