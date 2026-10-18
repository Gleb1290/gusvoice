import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  gooseCooldownKey,
  gooseCurrentKey,
  gooseEnabled,
  gooseOfferAllowed,
  gooseTokenKey,
  gooseTokenTtlMs,
} from './gooseRules.js';

type OfferGoose = (serverId: string, userId: string, economy: object, at: { peers: number }) => Promise<void>;
type GooseModule = { __testOfferGoose: OfferGoose };

type HarnessOptions = {
  claimResult?: string | null;
  currentOfferId?: string | null;
  cooldownActive?: boolean;
};

function makeHarness(options: HarnessOptions = {}, rawSource?: string) {
  const operations: Array<{ op: string; key: string; args?: unknown[] }> = [];
  const pushes: Array<{ userId: string; payload: Record<string, unknown> }> = [];
  const errors: unknown[][] = [];
  let generatedId = 0;
  const curKey = gooseCurrentKey('server', 'user');
  const cooldownKey = gooseCooldownKey('server', 'user');
  const redis = {
    async exists(key: string) {
      operations.push({ op: 'exists', key });
      return key === cooldownKey && options.cooldownActive ? 1 : 0;
    },
    async get(key: string) {
      operations.push({ op: 'get', key });
      return key === curKey ? options.currentOfferId ?? null : null;
    },
    async set(...args: unknown[]) {
      const key = String(args[0]);
      operations.push({ op: 'set', key, args });
      if (key === curKey && args[4] === 'NX') return options.claimResult === undefined ? 'OK' : options.claimResult;
      return 'OK';
    },
  };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': { previewAllows: () => true },
    'drizzle-orm': { inArray: () => ({}) },
    './coins.js': { creditVoice: async () => {}, economyFor: async () => new Map() },
    './gooseRules.js': { gooseCooldownKey, gooseCurrentKey, gooseEnabled, gooseOfferAllowed, gooseTokenKey, gooseTokenTtlMs },
    './seasons.js': { closeSeasonIfNeeded: async () => {} },
    './db/index.js': { db: {} },
    './db/schema.js': { channels: {}, users: {}, voiceActivity: {} },
    './env.js': { env: { economyPreviewUsers: [] } },
    './realtime.js': {
      publishToUser: async (userId: string, payload: Record<string, unknown>) => { pushes.push({ userId, payload }); },
      redisPub: redis,
    },
    './util.js': { id: () => `generated-${++generatedId}` },
    './voiceActivityRules.js': { planSamples: () => ({}), SAMPLE_PERIOD_MS: 60_000 },
  };

  const source = rawSource ?? readFileSync(new URL('./voiceActivity.ts', import.meta.url), 'utf8');
  // Транспилируем весь модуль и только добавляем доступ к его локальной функции для теста.
  // Тело offerGoose остаётся исходным: это ловит ошибки в реальных ветках, не в копии функции.
  const withTestExport = `${source}\nexport { offerGoose as __testOfferGoose };\n`;
  const compiled = ts.transpileModule(withTestExport, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as GooseModule };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name: string) => {
      assert.ok(Object.hasOwn(deps, name), `неожиданный импорт voiceActivity.ts: ${name}`);
      return deps[name];
    },
    console: { error: (...args: unknown[]) => { errors.push(args); } },
    Date: class extends Date { static now() { return 1_000; } },
  });
  return { offerGoose: module.exports.__testOfferGoose, operations, pushes, errors, curKey, cooldownKey };
}

function changeOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length, 2, `якорь мутанта должен встретиться ровно один раз: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'мутант обязан менять исходник');
  return changed;
}

describe('повторный показ висящего гуся', () => {
  it('при занятом goose:cur повторяет прежний offerId и не создаёт жетон или новый откат', async () => {
    // Если заменить повтор старого предложения новой выдачей, клиент получит второй гусь,
    // а потерянная доставка останется неразличимой от уже показанного предложения.
    const h = makeHarness({ claimResult: null, currentOfferId: 'old-offer' });

    await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 1 });
    await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 1 });

    assert.deepEqual(h.pushes.map(({ payload }) => [payload.offerId, payload.t]), [
      ['old-offer', 'goose.offer'],
      ['old-offer', 'goose.offer'],
    ], 'каждый повтор отправляет именно предложение, которое ещё висит');
    assert.equal(h.pushes.every(({ userId, payload }) => userId === 'user' && payload.serverId === 'server'), true);
    assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0,
      'повтор не выдаёт второй goose:tok');
    assert.equal(h.operations.some(({ op, key }) => op === 'set' && key === h.cooldownKey), false,
      'повтор не изменяет откат');
    assert.deepEqual(h.operations.filter(({ op, key }) => op === 'set' && key === h.curKey)
      .map(({ args }) => args?.slice(2)), [
      ['PX', gooseTokenTtlMs(), 'NX'],
      ['PX', gooseTokenTtlMs(), 'NX'],
    ], 'повторный SET остаётся NX, поэтому не заменяет существующий offerId и не продлевает TTL');
    assert.deepEqual(h.errors, []);
  });

  it('если goose:cur уже исчез, не публикует устаревший offerId', async () => {
    // Между неудачным SET NX и GET предложение могли уже удалить; пуш произвольного id
    // воскресил бы на клиенте гусыню, для которой серверного жетона больше нет.
    const h = makeHarness({ claimResult: null, currentOfferId: null });

    await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 1 });

    assert.deepEqual(h.pushes, [], 'пустой GET не должен превращаться в повторную выдачу');
    assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0);
    assert.deepEqual(h.errors, []);
  });
});

describe('мутации offerGoose', () => {
  it('оригинал проходит первым, а пять регрессионных мутантов падают на своём инварианте', async () => {
    // Одних «обычных» примеров недостаточно: этот прогон доказывает, что тестовый контракт
    // действительно замечает удалённый повтор, подмену id, жетон при повторе и пропуск обоих ворот.
    const source = readFileSync(new URL('./voiceActivity.ts', import.meta.url), 'utf8');
    const publish = "      if (hanging) await publishToUser(userId, { t: 'goose.offer', serverId, offerId: hanging });";
    const currentRead = '      const hanging = await redisPub.get(gooseCurrentKey(serverId, userId));';
    const cooldownGuard = '    if ((await redisPub.exists(gooseCooldownKey(serverId, userId))) === 1) return;';
    const peersGuard = '  if (!gooseOfferAllowed(at)) return;';
    const mutants = [
      {
        name: 'удалённый повторный push',
        source: changeOnce(source, publish, '      /* мутант: повторный push удалён */'),
        options: { claimResult: null, currentOfferId: 'old-offer' },
        peers: 1,
        verify: (h: ReturnType<typeof makeHarness>) => {
          assert.equal(h.pushes.length, 1, 'висящий offer обязан повторно публиковаться');
          assert.equal(h.pushes[0]?.payload.offerId, 'old-offer', 'повтор обязан сохранить исходный offerId');
          assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0,
            'повтор не выдаёт goose:tok');
        },
        failure: 'висящий offer обязан повторно публиковаться',
      },
      {
        name: 'подмена висящего id новым',
        source: changeOnce(source, publish, publish.replace('offerId: hanging', 'offerId')),
        options: { claimResult: null, currentOfferId: 'old-offer' },
        peers: 1,
        verify: (h: ReturnType<typeof makeHarness>) => {
          assert.equal(h.pushes[0]?.payload.offerId, 'old-offer', 'повтор обязан сохранить исходный offerId');
        },
        failure: 'повтор обязан сохранить исходный offerId',
      },
      {
        name: 'жетон на повторе',
        source: changeOnce(source, currentRead, `${currentRead}\n      await redisPub.set(gooseTokenKey(serverId, userId, hanging ?? offerId), '1', 'PX', gooseTokenTtlMs());`),
        options: { claimResult: null, currentOfferId: 'old-offer' },
        peers: 1,
        verify: (h: ReturnType<typeof makeHarness>) => {
          assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0,
            'повтор не выдаёт goose:tok');
        },
        failure: 'повтор не выдаёт goose:tok',
      },
      {
        name: 'пропуск cooldown',
        source: changeOnce(source, cooldownGuard, '    /* мутант: проверка cooldown пропущена */'),
        options: { cooldownActive: true },
        peers: 1,
        verify: (h: ReturnType<typeof makeHarness>) => {
          assert.equal(h.pushes.length, 0, 'активный cooldown запрещает push');
          assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0,
            'активный cooldown запрещает жетон');
        },
        failure: 'активный cooldown запрещает push',
      },
      {
        name: 'пропуск peers',
        source: changeOnce(source, peersGuard, '  /* мутант: проверка peers пропущена */'),
        options: {},
        peers: 0,
        verify: (h: ReturnType<typeof makeHarness>) => {
          assert.deepEqual(h.operations, [], 'peers=0 не обращается к Redis');
        },
        failure: 'peers=0 не обращается к Redis',
      },
    ];

    for (const mutant of mutants) {
      const original = makeHarness(mutant.options);
      await original.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: mutant.peers });
      assert.deepEqual(original.errors, [], `${mutant.name}: исходник не логирует ошибку`);
      mutant.verify(original);

      const mutated = makeHarness(mutant.options, mutant.source);
      await mutated.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: mutant.peers });
      assert.deepEqual(mutated.errors, [], `${mutant.name}: мутант должен доходить до адресного инварианта, не падать внутри`);
      assert.throws(
        () => mutant.verify(mutated),
        (error: unknown) => error instanceof assert.AssertionError && error.message.includes(mutant.failure),
        `${mutant.name}: мутант обязан упасть именно на «${mutant.failure}»`,
      );
    }
  });
});

describe('условия появления гуся', () => {
  it('при активном откате не занимает goose:cur ни при пустом, ни при занятом предложении', async () => {
    // Откат после поимки — серверный запрет на новую попытку; пропуск проверки породил бы
    // новый жетон либо повторный push в период, когда гусь ещё не должен выходить.
    for (const currentOfferId of [null, 'old-offer']) {
      const h = makeHarness({
        cooldownActive: true,
        currentOfferId,
        ...(currentOfferId ? { claimResult: null } : {}),
      });

      await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 1 });

      assert.deepEqual(h.pushes, [], `cooldown с goose:cur=${currentOfferId ?? 'пустым'} не публикует push`);
      assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key === h.curKey).length, 0);
      assert.equal(h.operations.some(({ op }) => op === 'get'), false);
      assert.equal(h.operations.filter(({ op, key }) => op === 'set' && key.startsWith('goose:tok:')).length, 0);
      assert.deepEqual(h.errors, []);
    }
  });

  it('при нуле собеседников не обращается к Redis ни с пустым, ни с занятым goose:cur', async () => {
    // Одиночное присутствие не считается совместным голосом; проверка должна стоять до
    // любых повторов, иначе одинокий участник всё равно получит пуш уже висящего гуся.
    for (const currentOfferId of [null, 'old-offer']) {
      const h = makeHarness({ currentOfferId, ...(currentOfferId ? { claimResult: null } : {}) });

      await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 0 });

      assert.deepEqual(h.operations, [], `peers=0 не обращается к Redis при goose:cur=${currentOfferId ?? 'пустом'}`);
      assert.deepEqual(h.pushes, []);
      assert.deepEqual(h.errors, []);
    }
  });

  it('при пустом goose:cur атомарно выдаёт один жетон и отправляет новый offerId', async () => {
    // Проверка только отказных ветвей могла бы скрыть регрессию, при которой нормальная
    // пустая очередь никогда не начинает выдачу гусей.
    const h = makeHarness();

    await h.offerGoose('server', 'user', { gooseBonus: 1, gooseMinutes: 1 }, { peers: 1 });

    assert.deepEqual(h.operations.filter(({ op }) => op === 'set').map(({ key, args }) => [key, ...args!.slice(1)]), [
      [gooseCurrentKey('server', 'user'), 'generated-1', 'PX', gooseTokenTtlMs(), 'NX'],
      [gooseTokenKey('server', 'user', 'generated-1'), '1', 'PX', gooseTokenTtlMs()],
    ], 'claim goose:cur с NX предшествует созданию единственного жетона');
    assert.deepEqual(h.pushes.map(({ userId, payload }) => [
      userId, payload.t, payload.serverId, payload.offerId,
    ]), [['user', 'goose.offer', 'server', 'generated-1']]);
    assert.deepEqual(h.errors, []);
  });
});
