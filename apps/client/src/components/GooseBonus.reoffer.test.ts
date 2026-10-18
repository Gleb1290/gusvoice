import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { React, environment } from './R171.phoneHarness';

const hostSource = readFileSync(new URL('./GooseBonusHost.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bonusSource = readFileSync(new URL('./GooseBonus.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Offer = { serverId: string; offerId: string };
type State = {
  bootstrap: { server: { id: string } } | null;
  economy: Record<string, { goose: { offerId: string } | null }>;
};
type Mutation = { target: 'host' | 'bonus'; anchor: string; replacement: string };

function sourceFor(target: Mutation['target'], mutation?: Mutation) {
  const raw = target === 'host' ? hostSource : bonusSource;
  if (mutation?.target !== target) return raw;
  assert.equal(raw.split(mutation.anchor).length - 1, 1, 'R249: единственный точный якорь целого модуля');
  return raw.replace(mutation.anchor, mutation.replacement);
}

function load<T>(raw: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  const deps = { react: React, 'react/jsx-runtime': jsx, ...dependencies };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, document, window,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `R249: неописанная граница ${id}`);
      return deps[id as keyof typeof deps];
    },
  });
  return module.exports as T;
}

type Fixture = {
  dom: HTMLDivElement;
  state: State;
  calls: [string, string][];
  refreshes: [string, boolean][];
  emit: (id: string, serverId?: string) => Promise<void>;
  render: () => Promise<void>;
  click: () => Promise<void>;
  succeed: (bonus?: number) => Promise<void>;
  fail: () => Promise<void>;
};

async function fixture(check: (f: Fixture) => Promise<void>, options: { snapshot?: string; noServer?: boolean; mutation?: Mutation } = {}) {
  await environment(async (dom, renderElement) => {
    const state: State = { bootstrap: options.noServer ? null : { server: { id: 'server-a' } },
      economy: { 'server-a': { goose: options.snapshot ? { offerId: options.snapshot } : null } } };
    const listeners = new Set<(offer: Offer) => void>();
    const calls: [string, string][] = [], refreshes: [string, boolean][] = [];
    let resolveClaim: ((res: { bonus: number }) => void) | undefined;
    let rejectClaim: ((error: { reason: string }) => void) | undefined;
    const bonus = load<typeof import('./GooseBonus')>(sourceFor('bonus', options.mutation), {
      '../effectsDom': { fullscreenNow: () => false },
      './Goose': { Goose: () => React.createElement('span', { 'data-goose': true }) },
    });
    const { GooseBonusHost } = load<typeof import('./GooseBonusHost')>(sourceFor('host', options.mutation), {
      './GooseBonus': bonus,
      '../store': { useStore: (selector: (s: State) => unknown) => selector(state) },
      '../sockets': { onGooseOffer: (listener: (offer: Offer) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      } },
      '../economyClient': { ensureEconomy: (id: string, force: boolean) => { refreshes.push([id, force]); } },
      '../api': { api: { claimGoose: (serverId: string, id: string) => {
        calls.push([serverId, id]);
        return new Promise<{ bonus: number }>((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
      } } },
    });
    const render = () => renderElement(React.createElement(GooseBonusHost, { presentationAllowed: true }));
    await render();
    const f: Fixture = { dom, state, calls, refreshes, render,
      emit: async (id, serverId = 'server-a') => {
        await React.act(async () => { for (const listener of listeners) listener({ serverId, offerId: id }); });
      },
      click: async () => {
        const button = dom.querySelector<HTMLButtonElement>('button.goose-bonus');
        assert.ok(button, 'гусь доступен для нажатия');
        await React.act(async () => { button.click(); });
      },
      succeed: async (amount = 0) => {
        assert.ok(resolveClaim, 'настоящий хост отправил запрос');
        await React.act(async () => { resolveClaim!({ bonus: amount }); });
      },
      fail: async () => {
        assert.ok(rejectClaim, 'настоящий хост отправил запрос');
        await React.act(async () => { rejectClaim!({ reason: 'claimed' }); });
      },
    };
    try { await check(f); }
    finally {
      // Закрываем незавершённый запрос даже при убитом мутанте; DOM-харнесс затем снимает эффекты и таймеры.
      await React.act(async () => { resolveClaim?.({ bonus: 0 }); });
      await renderElement(null);
      assert.equal(listeners.size, 0, 'подписка на предложения снята после unmount');
    }
  });
}

function gooseCount(f: Fixture, count: number, message: string) {
  assert.equal(f.dom.querySelectorAll('button.goose-bonus').length, count, message);
  assert.equal(f.dom.querySelectorAll('[data-goose]').length, count, 'число птиц совпадает с числом кнопок');
}

async function pending(mutation?: Mutation) {
  await fixture(async f => {
    await f.emit('offer-a'); await f.click();
    assert.deepEqual(f.calls, [['server-a', 'offer-a']], 'клик отправляет серверный id');
    for (let i = 0; i < 3; i++) {
      await f.emit('offer-a');
      gooseCount(f, 1, 'повтор во время запроса оставляет одного улетающего гуся');
      assert.equal(f.dom.querySelector<HTMLButtonElement>('button.goose-bonus')!.disabled, true,
        'повтор того же id не разрешает второй claim до ответа');
      await f.click();
    }
    assert.equal(f.calls.length, 1, 'повторные события и клики не создают вторую операцию');
    await f.succeed();
  }, { mutation });
}

async function hidden(mutation?: Mutation) {
  await fixture(async f => {
    await f.emit('offer-a'); await f.click(); await f.succeed(7);
    gooseCount(f, 0, 'пойманный гусь скрыт после ответа');
    assert.equal(f.dom.querySelector('.goose-hint')?.textContent, '+7', 'награда приходит из ответа сервера');
    assert.deepEqual(f.refreshes, [['server-a', true]], 'успех обновляет снимок ровно один раз');
    for (let i = 0; i < 2; i++) {
      await f.emit('offer-a');
      gooseCount(f, 0, 'повтор нажатого id не воскрешает hiddenId');
      assert.equal(f.dom.querySelectorAll('.goose-hint').length, 1, 'повтор не дублирует надбавку');
    }
    await f.emit('offer-b');
    gooseCount(f, 1, 'новый id не наследует запрет старого');
    await f.click();
    assert.deepEqual(f.calls, [['server-a', 'offer-a'], ['server-a', 'offer-b']], 'новый гусь забирается по новому id');
    await f.succeed();
  }, { mutation });
}

it('R249 повтор одного предложения оставляет одну кнопку без самовольного запроса награды', async () => {
  // Сеть может доставить один жетон повторно: идентичность предложения — id, а не новый объект из сокета.
  await fixture(async f => {
    gooseCount(f, 0, 'до предложения гуся нет');
    await f.emit('offer-a'); const first = f.dom.querySelector('button.goose-bonus');
    for (let i = 0; i < 3; i++) {
      await f.emit('offer-a'); gooseCount(f, 1, 'повтор не размножает птицу');
      assert.equal(f.dom.querySelector('button.goose-bonus'), first, 'повтор не пересоздаёт кнопку');
    }
    assert.equal(f.calls.length, 0, 'предложение само не забирает деньги');
  });
});

it('R249 повтор во время медленного ответа не сбрасывает блокировку второго нажатия', async () => {
  await pending();
});

it('R249 повтор уже пойманного id не возвращает гуся, а новый id нормально показывается', async () => {
  await hidden();
});

it('R249 серверный отказ тоже прячет старый id, но не мешает следующему предложению', async () => {
  await fixture(async f => {
    await f.emit('offer-a'); await f.click(); await f.fail();
    await f.emit('offer-a'); gooseCount(f, 0, 'отказ не воскрешает пойманную кнопку');
    assert.equal(f.dom.querySelector('.goose-hint'), null, 'отказ не обещает монеты');
    assert.deepEqual(f.refreshes, [], 'отказ не выдают за успешную надбавку');
    await f.emit('offer-b'); gooseCount(f, 1, 'новое предложение принимается после отказа');
  });
});

it('R249 снимок поднимает пропущенного гуся, повтор пуша не дублирует и не воскрешает его', async () => {
  await fixture(async f => {
    gooseCount(f, 1, 'предложение из снимка доступно без первого пуша');
    await f.emit('snapshot-a'); gooseCount(f, 1, 'снимок и пуш одного id дают одного гуся');
    await f.click(); await f.succeed();
    assert.deepEqual(f.calls, [['server-a', 'snapshot-a']], 'восстановленный жетон действительно забирается');
    await f.emit('snapshot-a'); gooseCount(f, 0, 'повтор восстановленного id не воскрешает гуся');
    f.state.economy['server-a'] = { goose: { offerId: 'snapshot-b' } };
    await f.render(); gooseCount(f, 1, 'новый id из следующего снимка показывается');
  }, { snapshot: 'snapshot-a' });
});

it('R249 предложение чужого сервера отбрасывается, своего принимается, без сервера показ запрещён', async () => {
  await fixture(async f => {
    await f.emit('foreign-a', 'server-b'); gooseCount(f, 0, 'чужой кошелёк не показывает гуся');
    await f.emit('own-a'); gooseCount(f, 1, 'свой сервер принимается');
    await f.emit('foreign-b', 'server-b'); await f.click(); await f.succeed();
    assert.deepEqual(f.calls, [['server-a', 'own-a']], 'чужой повтор не заменяет актуальный жетон');
  });
  await fixture(async f => {
    await f.emit('own-a'); gooseCount(f, 0, 'без открытого сервера пуш игнорируется');
    assert.equal(f.calls.length, 0);
  }, { noServer: true });
});

it('R249 контрфакты снятого hiddenId и сброса скрытия отвергаются после настоящего claim', async () => {
  await hidden();
  for (const mutation of [
    { target: 'bonus', anchor: 'hiddenId !== opportunity.id &&', replacement: 'true &&' },
    { target: 'bonus', anchor: 'setHiddenId((id) => (id === opportunity.id ? id : null));', replacement: 'setHiddenId(null);' },
  ] satisfies Mutation[]) {
    await assert.rejects(hidden(mutation), e => e instanceof assert.AssertionError && e.message.includes('не воскрешает hiddenId'));
  }
});

it('R249 контрфакт зависимости от нового объекта вместо id ловит второй claim в полёте', async () => {
  await pending();
  const mutation: Mutation = { target: 'bonus', anchor: '}, [opportunity?.id]);', replacement: '}, [opportunity]);' };
  await assert.rejects(pending(mutation), e => e instanceof assert.AssertionError && e.message.includes('не разрешает второй claim'));
});
