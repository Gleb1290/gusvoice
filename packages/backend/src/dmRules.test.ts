import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canWriteDm, decideDmOpen, dmPair, openDm, type OpenDmIo } from './dmRules.js';

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
