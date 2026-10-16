import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  asUserId,
  bindSuperAdminWith,
  bootstrapIdentity,
  claimsAreSuperAdmin,
  decideSuperAdminBinding,
  isSuperAdminId,
  type BindingIo,
} from './superAdminRules.js';

function loadSuperAdminRules(source: string): typeof import('./superAdminRules.js') {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports as typeof import('./superAdminRules.js');
}

async function ensureApprovedContract(bind: typeof bindSuperAdminWith): Promise<void> {
  const calls: string[] = [];
  const io: BindingIo = {
    readStored: async () => (calls.push('read'), undefined),
    userExists: async (id) => (calls.push(`exists:${id}`), true),
    findIdByUsername: async (name) => (calls.push(`find:${name}`), 'final-id'),
    persist: async (id) => void calls.push(`persist:${id}`),
    ensureApproved: async (id) => void calls.push(`approve:${id}`),
    envUsername: 'admin',
    log: () => {},
  };
  const result = await bind(io);
  assert.equal(result.superAdminId, 'final-id', 'одобряется итоговый id после новой привязки');
  assert.deepEqual(calls, ['read', 'find:admin', 'persist:final-id', 'approve:final-id'], 'одобрение следует после записи и получает её id');

  calls.length = 0;
  const stored = await bind({
    ...io,
    readStored: async () => (calls.push('read'), { value: { userId: 'already-bound' } }),
  });
  assert.equal(stored.superAdminId, 'already-bound', 'одобряется ранее сохранённая привязка');
  assert.deepEqual(calls, ['read', 'exists:already-bound', 'approve:already-bound']);
}

type IsSuperAdmin = typeof import('./auth.js').isSuperAdmin;
const checkBrandedBoundary = (check: IsSuperAdmin) => {
  check(asUserId('database-id'));
  // @ts-expect-error Логин и обычная строка не должны проходить границу проверки прав без явного asUserId.
  check('plain-string');
};
void checkBrandedBoundary;

describe('супер-админ — человек по id, а не логин (#140)', () => {
  it('тот же логин, но другой id — не супер-админ', () => {
    // Ловит возврат к сравнению логинов: на инстансе друга можно завести такой же логин.
    assert.equal(isSuperAdminId('impostor-id', 'real-id'), false);
    assert.equal(isSuperAdminId('real-id', 'real-id'), true);
  });

  it('без привязки супер-админа нет ни у кого, включая пустой id', () => {
    // Ловит «пустая строка равна пустой строке» — выдачу прав при непривязанном инстансе.
    assert.equal(isSuperAdminId('', null), false);
    assert.equal(isSuperAdminId(undefined, null), false);
    assert.equal(isSuperAdminId('', ''), false);
  });

  it('токен с подменённым username, но чужим sub — не супер-админ', () => {
    // Ловит проверку прав по полю username из JWT.
    assert.equal(claimsAreSuperAdmin({ sub: 'someone-else', username: 'SuperGoose' }, 'real-id'), false);
    assert.equal(claimsAreSuperAdmin({ sub: 'real-id', username: 'renamed' }, 'real-id'), true);
  });
});

describe('привязка супер-админа с внешними операциями (#143)', () => {
  function bindingIo(overrides: Partial<BindingIo> = {}) {
    const calls: string[] = [];
    const logs: Array<{ level: string; message: string }> = [];
    const io: BindingIo = {
      readStored: async () => (calls.push('read'), undefined),
      userExists: async (id) => (calls.push(`exists:${id}`), true),
      findIdByUsername: async (name) => (calls.push(`find:${name}`), 'matched-id'),
      persist: async (id) => void calls.push(`persist:${id}`),
      envUsername: 'admin',
      log: (level, message) => void logs.push({ level, message }),
      ...overrides,
    };
    return { io, calls, logs };
  }

  it('первая привязка ищет точный логин, записывает найденный id и объявляет решение', async () => {
    // Ловит запись логина вместо id и нарушение порядка read → find → persist.
    const { io, calls, logs } = bindingIo();
    const result = await bindSuperAdminWith(io);
    assert.equal(result.superAdminId, 'matched-id');
    assert.deepEqual(calls, ['read', 'find:admin', 'persist:matched-id']);
    assert.equal(logs[0]?.level, 'info');
  });

  it('валидная сохранённая привязка не ищет логин и не перезаписывает строку', async () => {
    // Ловит возврат к выдаче прав по изменяемому SUPERADMIN_USERNAME на каждом старте.
    const { io, calls } = bindingIo({ readStored: async () => ({ value: { userId: 'bound-id' } }) });
    const result = await bindSuperAdminWith(io);
    assert.equal(result.superAdminId, 'bound-id');
    assert.deepEqual(calls, ['exists:bound-id']);
  });

  it('каждая нечитаемая сохранённая запись закрывает права без поиска и записи', async () => {
    // Ловит трактовку пустого, отсутствующего или нестрокового userId как свободного места для новой привязки.
    for (const value of [{}, { userId: 42 }, { userId: '   ' }]) {
      const { io, calls, logs } = bindingIo({
        readStored: async () => ({ value }),
        ensureApproved: async (id) => void calls.push(`approve:${id}`),
      });
      const result = await bindSuperAdminWith(io);
      assert.equal(result.superAdminId, null);
      assert.deepEqual(calls, []);
      assert.equal(logs[0]?.level, 'warn');
    }
  });

  it('пропавший сохранённый аккаунт не заменяется совпадением по env', async () => {
    // Ловит автоматическую передачу инстанса новому владельцу того же логина.
    let checked = '';
    const { io, calls, logs } = bindingIo({
      readStored: async () => ({ value: { userId: 'gone' } }),
      userExists: async (id) => (checked = id, false),
      ensureApproved: async (id) => void calls.push(`approve:${id}`),
    });
    const result = await bindSuperAdminWith(io);
    assert.equal(result.superAdminId, null);
    assert.equal(checked, 'gone');
    assert.deepEqual(calls, []);
    assert.equal(logs[0]?.level, 'warn');
  });

  it('пустой env не обращается к пользователям и остаётся без привязки', async () => {
    // Ловит бессмысленный поиск пустого логина и случайную привязку к некорректной строке пользователя.
    const { io, calls, logs } = bindingIo({ envUsername: '   ' });
    assert.deepEqual(await bindSuperAdminWith(io), { superAdminId: null, persist: false, log: null });
    assert.deepEqual(calls, ['read']);
    assert.deepEqual(logs, []);
  });

  it('env обрезается по краям, но регистр передаётся поиску без изменения', async () => {
    // Ловит lower-case нормализацию логина, способную выбрать другого пользователя.
    const { io, calls } = bindingIo({ envUsername: '  SuperGoose  ' });
    await bindSuperAdminWith(io);
    assert.equal(calls[1], 'find:SuperGoose');
  });

  it('заданный логин без точного совпадения предупреждает и ничего не записывает', async () => {
    // Ловит привязку к пользователю с отличающимся регистром и тихий старт без ожидаемого владельца.
    let persisted = 0;
    const { io, logs } = bindingIo({
      envUsername: 'Supergoose',
      findIdByUsername: async (name) => (name === 'SuperGoose' ? 'real-id' : null),
      persist: async () => void (persisted += 1),
      ensureApproved: async () => assert.fail('одобрение не зовётся без найденного id'),
    });
    const result = await bindSuperAdminWith(io);
    assert.equal(result.superAdminId, null);
    assert.equal(persisted, 0);
    assert.equal(logs[0]?.level, 'warn');
  });

  it('новая и сохранённая привязки одобряют только итоговый id', async () => {
    // Ловит одобрение найденного кандидата до принятия решения или пропуск уже готового супер-админа.
    await ensureApprovedContract(bindSuperAdminWith);
  });

  it('контрфакт: целый модуль отвергает привязку без ensureApproved', async () => {
    // Ловит регрессию при удалении необязательного одобрения из реального модуля правил.
    const source = readFileSync(new URL('./superAdminRules.ts', import.meta.url), 'utf8');
    await ensureApprovedContract(loadSuperAdminRules(source).bindSuperAdminWith);

    const anchor = '  if (decision.superAdminId && io.ensureApproved) await io.ensureApproved(decision.superAdminId);';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь одобрения должен встретиться ровно один раз');
    await assert.rejects(
      () => ensureApprovedContract(loadSuperAdminRules(source.replace(anchor, '')).bindSuperAdminWith),
      (error) => error instanceof assert.AssertionError && error.message.includes('одобрение следует после записи и получает её id'),
      'контракт должен отвергнуть модульный мутант без ensureApproved',
    );
  });
});

describe('порядок bootstrap личности инстанса (#143)', () => {
  it('сначала создаётся аккаунт, только затем привязываются права', async () => {
    // Ловит свежий запуск без супер-админа из-за поиска пользователя до сида.
    const calls: string[] = [];
    await bootstrapIdentity({
      seedSuperAdmin: async () => void calls.push('seed'),
      bindSuperAdmin: async () => void calls.push('bind'),
    });
    assert.deepEqual(calls, ['seed', 'bind']);
  });

  it('ошибка сида останавливает привязку и выходит наружу', async () => {
    // Ловит продолжение старта с частично созданной личностью и ложной привязкой прав.
    let bound = false;
    await assert.rejects(
      bootstrapIdentity({
        seedSuperAdmin: async () => { throw new Error('seed failed'); },
        bindSuperAdmin: async () => void (bound = true),
      }),
      /seed failed/,
    );
    assert.equal(bound, false);
  });
});

describe('привязка супер-админа при старте', () => {
  it('привязанный id выигрывает у логина из env, даже если логин теперь у другого', () => {
    // Ловит повторный поиск по SUPERADMIN_USERNAME на каждом старте: смена .env молча
    // передавала бы инстанс другому человеку.
    const d = decideSuperAdminBinding({
      storedId: 'real-id',
      storedExists: true,
      envUsername: 'SuperGoose',
      usernameMatchId: 'impostor-id',
    });
    assert.equal(d.superAdminId, 'real-id');
    assert.equal(d.persist, false);
  });

  it('первая привязка по точному логину записывается один раз', () => {
    // Ловит забытую запись: без неё привязка по логину происходила бы на каждом старте.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'real-id',
    });
    assert.equal(d.superAdminId, 'real-id');
    assert.equal(d.persist, true);
  });

  it('пропавший привязанный аккаунт не заменяется поиском по логину', () => {
    // Ловит «автоматика назначила нового супер-админа, потому что старого не нашла».
    const d = decideSuperAdminBinding({
      storedId: 'gone-id',
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'impostor-id',
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('повреждённая запись оставляет инстанс без супер-админа и требует внимания', () => {
    // Ловит трактовку битого JSON как отсутствующей настройки с тихой новой привязкой.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedMalformed: true,
      storedExists: false,
      envUsername: '',
      usernameMatchId: null,
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
    assert.match(d.log?.message ?? '', /повреждена/);
  });

  it('повреждённая запись сильнее совпавшего логина из env', () => {
    // Ловит повторную выдачу прав по изменяемому env, пока занятая битая строка не перезаписывается.
    const d = decideSuperAdminBinding({
      storedId: null,
      storedMalformed: true,
      storedExists: false,
      envUsername: 'SuperGoose',
      usernameMatchId: 'matched-id',
    });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('логин задан, аккаунта нет — никого и громко в лог, без записи', () => {
    const d = decideSuperAdminBinding({ storedId: null, storedExists: false, envUsername: 'admin', usernameMatchId: null });
    assert.equal(d.superAdminId, null);
    assert.equal(d.persist, false);
    assert.equal(d.log?.level, 'warn');
  });

  it('пустой env и нет привязки — никого и молча', () => {
    const d = decideSuperAdminBinding({ storedId: null, storedExists: false, envUsername: '', usernameMatchId: null });
    assert.deepEqual(d, { superAdminId: null, persist: false, log: null });
  });
});
