import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { testVmImports } from '../testVmImports';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { React, environment, icon, mutate } from './R171.phoneHarness';
import { Toggle } from './Toggle';

const source = readFileSync(new URL('./UserSettingsModal.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const P = 'R368/desktop/check/';

function budget() {
  const counts = new Map<string, number>();
  let exhausted: Error | undefined;
  return {
    step(kind: string) {
      const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count);
      if (count > 200) {
        exhausted ??= new Error(`R368/desktop/budget/${kind}`);
        throw exhausted;
      }
    },
    check() { if (exhausted) throw exhausted; },
  };
}

function clock(guard: ReturnType<typeof budget>) {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    window: {
      setTimeout(callback: () => void, ms = 0) {
        guard.step('schedule');
        if (!Number.isFinite(ms) || ms < 0) throw new Error('R368/desktop/setup/finite-timeout');
        const id = next++; pending.set(id, { at: now + ms, callback }); return id;
      },
      clearTimeout(id: number) { guard.step('clear'); pending.delete(id); },
    },
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('R368/desktop/setup/finite-tick');
      const end = now + ms;
      for (let i = 0; i <= 200; i++) {
        guard.step('clock');
        const ready = [...pending].filter(([, item]) => item.at <= end)
          .sort(([left, a], [right, b]) => a.at - b.at || left - right)[0];
        if (!ready) { now = end; return; }
        const [id, item] = ready; pending.delete(id); now = item.at; item.callback();
      }
      throw new Error('R368/desktop/budget/clock-loop');
    },
    count() { return pending.size; },
    clear() { pending.clear(); },
  };
}

async function panel(raw: string, check: (tools: {
  host: HTMLDivElement; button(): HTMLButtonElement; requests(): number;
  answer(): Promise<void>; advance(ms: number): Promise<void>; timers(): number;
}) => Promise<void>) {
  const guard = budget(), time = clock(guard);
  const unexpected: string[] = [], requests: Array<() => void> = [];
  let answered = 0;
  await environment(async (host, render) => {
    // Настоящие React hooks/DOM. Stable dispatch и конечный бюджет не дают мутанту копить рендеры.
    const react = { ...React, useState(initial: unknown) {
      guard.step('hook');
      const [state, setState] = React.useState(initial);
      const dispatch = React.useCallback((value: unknown) => { guard.step('update'); setState(value); }, [setState]);
      return [state, dispatch];
    } };
    const dependencies: Record<string, unknown> = {
      react, 'react/jsx-runtime': await import('react/jsx-runtime'), '@gusvoice/shared': shared,
      '../config': { config: {}, RELEASES_URL: 'https://project.example.org/releases' },
      '../desktopWindow': {
        getCloseBehavior: () => { guard.step('behavior'); return 'tray'; },
        autostartGet: () => Promise.resolve(null),
        appVersion: () => { guard.step('version'); return Promise.resolve('1.2.3'); },
        gpuAccelGet: () => { guard.step('gpu'); return Promise.resolve(true); },
      },
      '../downloads': { getDownloadDir: () => { guard.step('download-dir'); return null; } },
      '../updater': { manualUpdateCheck: () => {
        guard.step('request');
        return new Promise<void>(resolve => requests.push(resolve));
      } },
      './Icon': { Icon: icon }, './Toggle': { Toggle },
    };
    const imports = testVmImports(new URL('./UserSettingsModal.tsx', import.meta.url), dependencies);
    const module = { exports: {} as { __DesktopTab: React.ComponentType } };
    // ЦЕЛЫЙ модуль с единственным тестовым экспортом локального DesktopTab, не eval вырезанного обработчика.
    runInNewContext(ts.transpileModule(raw + '\nexport { DesktopTab as __DesktopTab };', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { module, exports: module.exports, window: time.window, document, navigator, console,
      require: (id: string) => {
        guard.step('import');
        return new Proxy(imports(id) as object, { get(target, key) {
          try { return Reflect.get(target, key); }
          catch (error) {
            guard.step('unexpected'); unexpected.push(`${id}.${String(key)}`); throw error;
          }
        } });
      },
    }, { timeout: 500 });
    const button = () => {
      const items = [...host.querySelectorAll<HTMLButtonElement>('#set-g-updates ~ button.settings-action')];
      assert.equal(items.length, 1, 'R368/desktop/setup/настоящая-кнопка-обновления');
      return items[0];
    };
    try {
      await render(React.createElement(module.exports.__DesktopTab));
      guard.check();
      await check({ host, button, requests: () => requests.length, timers: time.count,
        async answer() {
          const resolve = requests[answered++];
          assert.equal(typeof resolve, 'function', 'R368/desktop/setup/ожидающий-ответ');
          await React.act(async () => { guard.step('answer'); resolve(); for (let i = 0; i < 5; i++) await Promise.resolve(); });
          guard.check();
        },
        async advance(ms) { await React.act(async () => time.advance(ms)); guard.check(); },
      });
      guard.check();
    } finally {
      // Даже если адресная проверка мутанта упала, незавершённый fake request и часы не переживают сценарий.
      time.clear();
      await React.act(async () => { for (const resolve of requests.slice(answered)) resolve(); });
      time.clear(); guard.check();
      assert.deepEqual(unexpected, [], 'R368/desktop/setup/закрытые-границы');
    }
  });
}

async function click(button: HTMLButtonElement) {
  // DOM click, а не прямой вызов props: disabled обязан блокировать повторные нажатия.
  await React.act(async () => { button.click(); await Promise.resolve(); });
}

it('R368 Десктоп: пока ответ не пришёл, повторный клик и прошедшие пять секунд не начинают вторую проверку', async () => {
  await panel(source, async ({ button, requests, timers, advance, answer }) => {
    assert.equal(button().disabled, false, P + 'изначально-активна');
    assert.equal(button().textContent?.trim(), 'Проверить обновления', P + 'исходная-подпись');
    await click(button());
    assert.equal(requests(), 1, P + 'один-запрос');
    assert.equal(button().disabled, true, P + 'ожидающая-неактивна');
    assert.equal(button().textContent?.trim(), 'Проверяю…', P + 'ожидающая-подпись');
    assert.equal(timers(), 0, P + 'пауза-ещё-не-началась');
    await advance(5_000); await click(button());
    assert.equal(requests(), 1, P + 'повтор-пока-нет-ответа-не-отправлен');
    assert.equal(button().disabled, true, P + 'время-не-снимает-проверку');
    await answer();
    assert.equal(button().textContent?.trim(), 'Проверить обновления', P + 'после-ответа-прежняя-подпись');
  });
});

async function cooldown(raw: string) {
  await panel(raw, async ({ button, requests, answer, advance, timers }) => {
    await click(button()); await answer();
    assert.equal(button().disabled, true, P + 'ответ-держит-кнопку-неактивной');
    assert.equal(button().textContent?.trim(), 'Проверить обновления', P + 'пауза-не-меняет-подпись');
    assert.equal(timers(), 1, P + 'один-таймер-паузы');
    await advance(4_999); await click(button());
    assert.equal(button().disabled, true, P + '4999-ещё-неактивна');
    assert.equal(requests(), 1, P + 'клик-в-паузе-не-отправлен');
    await advance(1);
    assert.equal(button().disabled, false, P + '5000-уже-активна');
    assert.equal(button().textContent?.trim(), 'Проверить обновления', P + 'после-паузы-прежняя-подпись');
    assert.equal(timers(), 0, P + 'таймер-снят-после-срабатывания');
    await click(button());
    assert.equal(requests(), 2, P + 'новый-клик-снова-работает');
    await answer();
    assert.equal(button().disabled, true, P + 'второй-ответ-начинает-новую-паузу');
    await advance(5_000);
    assert.equal(button().disabled, false, P + 'вторая-пауза-тоже-конечна');
  });
}

it('R368 Десктоп: пауза длится ровно пять секунд после ответа; потерянный checkedRecently ловится адресно', async () => {
  await cooldown(source);
  await counterfact(async () => {
    const mutant = mutate(source, '            setCheckedRecently(true);', '            void 0;');
    await assert.rejects(cooldown(mutant), error => error instanceof assert.AssertionError
      && error.message.startsWith(P + 'ответ-держит-кнопку-неактивной')
      && error.actual === false && error.expected === true,
    'мутант убит отсутствием disabled после ответа, не setup/бюджетом');
  });
  await cooldown(source);
});
