import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rules from '../botRules';
import type { BotInfo, MyBotsResponse } from '@gusvoice/shared';
import { React, environment, load, sourceOf, bot, uiDependencies, button, click, input, tick, assertion, mutate } from './R297.bot.harness';

const raw = sourceOf('MyBotsSettings');
type Options = { enabled?: boolean; status?: number; empty?: boolean; confirm?: boolean | Promise<boolean>;
  docsUrl?: string; llmsUrl?: string | null; currentBot?: BotInfo };
type Scene = { host: HTMLDivElement; confirmations: Record<string, unknown>[]; calls: { create: unknown[]; rotate: string[]; remove: string[] };
  closed(): number };
async function fixture(check: (f: Scene) => Promise<void>, options: Options = {}, source = raw) {
  await environment(async (host, render) => {
    let closed = 0;
    const calls = { create: [] as unknown[], rotate: [] as string[], remove: [] as string[] }, confirmations: Record<string, unknown>[] = [];
    const response: MyBotsResponse = { bots: options.empty ? [] : [options.currentBot ?? bot], canCreate: true, limit: 10, enabled: options.enabled ?? true };
    const api = { myBots: async () => { if (options.status) throw Object.assign(new Error('тестовый отказ'), { status: options.status }); return response; },
      // JSON-граница HTTP: переносим данные из VM, иначе deepStrictEqual сравнит прототипы разных realm.
      createBot: async (body: unknown) => { calls.create.push(JSON.parse(JSON.stringify(body))); return { bot, token: 'test-created-token' }; },
      regenerateBotToken: async (id: string) => { calls.rotate.push(id); return { bot, token: 'test-rotated-token' }; },
      deleteBot: async (id: string) => { calls.remove.push(id); },
      ...(options.llmsUrl !== undefined ? { botLlmsUrl: () => options.llmsUrl } : {}),
    };
    const deps = uiDependencies({ getState: () => ({ openDmWith: () => assert.fail('здесь не открываем беседу') }) });
    const chrome = deps['../dialogChrome'];
    const { MyBotsSettings } = load<typeof import('./MyBotsSettings')>(source, { ...deps, '../api': { api },
      '../botRules': { ...rules, ...(options.docsUrl !== undefined ? { BOT_DOCS_URL: options.docsUrl } : {}) },
      '../toast': { toast: () => {}, toastError: () => assert.fail('неожиданная ошибка API') },
      '../confirm': { confirmAction: async (request: Record<string, unknown>) => { confirmations.push(request); return await (options.confirm ?? true); } },
    }, { Error });
    function Settings() {
      const ref = chrome.useDialogChrome(() => { closed++; });
      return React.createElement('div', { ref, tabIndex: -1, role: 'dialog', className: 'settings-modal' },
        React.createElement(MyBotsSettings, { onClose: () => { closed++; } }));
    }
    await render(React.createElement(Settings)); await tick();
    await check({ host, calls, confirmations, closed: () => closed });
  });
}
// Выбираем настоящую строку списка по классу: её подпись содержит и имя, и статус, а не только label.
async function openEditor(host: ParentNode) {
  const row = host.querySelector<HTMLButtonElement>('.bot-row'); assert.equal(!!row, true, 'R297-editor-row'); await click(row!);
}
function tokenInput() { return document.querySelector<HTMLInputElement>('.bot-token-modal input[aria-label="Токен бота"]'); }

it('R297 404 показывает неподдерживаемый сервер, 403 остаётся ошибкой загрузки', async () => {
  await fixture(async f => {
    assert.equal(f.host.textContent?.includes('не поддерживает ботов'), true);
    assert.equal(f.host.querySelectorAll('.error').length, 0); assert.equal(f.host.querySelectorAll('.sec-actions button').length, 0);
  }, { status: 404 });
  await fixture(async f => {
    assert.equal(f.host.textContent?.includes('не поддерживает ботов'), false);
    assert.equal(f.host.querySelector('[role="alert"]')?.textContent, 'тестовый отказ');
  }, { status: 403 });
});
async function offProbe(source = raw) {
  await fixture(async f => {
    assert.equal(f.host.querySelectorAll('.sec-actions button').length, 0, 'R297-off-create');
    assert.equal(f.host.querySelector('.bot-block')?.textContent, rules.BOTS_OFF_TEXT);
    assert.equal(f.host.textContent?.includes('Сейчас не работает'), true);
  }, { enabled: false }, source);
}
it('R297 выключенные боты скрывают создание и объясняют состояние существующего', () => offProbe());
it('R297 включённые боты оставляют кнопку создания и рабочий редактор', async () => {
  await fixture(async f => { assert.equal(button(f.host, 'Создать бота').disabled, false); await openEditor(f.host);
    assert.equal(f.host.querySelectorAll('.bot-editor').length, 1); });
});
it('R297 создание показывает токен ровно один раз: после закрытия и повторного открытия карточки его нет', async () => {
  await fixture(async f => {
    await click(button(f.host, 'Создать бота'));
    const username = f.host.querySelector<HTMLInputElement>('input[placeholder="watch_bot"]'); assert.equal(!!username, true);
    await input(username!, 'test_bot');
    const form = f.host.querySelector('form'); assert.equal(!!form, true);
    await React.act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await tick();
    assert.deepEqual(f.calls.create, [{ username: 'test_bot' }]);
    assert.equal(tokenInput()?.value, 'test-created-token');
    assert.equal(document.querySelector('.bot-token-modal')?.textContent?.includes('один раз'), true);
    assert.equal(/ключ/i.test(f.host.textContent ?? ''), false);
    await click(button(document.querySelector('.bot-token-modal')!, 'Готово'));
    assert.equal(!!tokenInput(), false);
    await click(f.host.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')!); await openEditor(f.host);
    assert.equal(!!tokenInput(), false); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.rotate.length, 0);
  }, { empty: true });
});

for (const action of ['rotate', 'remove'] as const) for (const approved of [false, true]) {
  it(`R297 ${action === 'rotate' ? 'перевыпуск' : 'удаление'}: danger ждёт решения, ${approved ? 'подтверждение выполняет' : 'отмена не выполняет'} API`, async () => {
    let resolve!: (answer: boolean) => void;
    const pending = new Promise<boolean>(r => { resolve = r; });
    try {
      await fixture(async f => {
        await openEditor(f.host);
        await click(button(f.host, action === 'rotate' ? 'Перевыпустить токен' : 'Удалить бота'));
        assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].tone, 'danger');
        assert.equal(f.calls[action].length, 0, 'R297-action-await');
        assert.equal(String(f.confirmations[0].body).includes('токен'), true);
        assert.equal(/ключ/i.test(JSON.stringify(f.confirmations[0])), false);
        resolve(approved); await tick();
        assert.deepEqual(f.calls[action], approved ? [bot.id] : []);
        if (action === 'rotate') {
          assert.equal(tokenInput()?.value ?? null, approved ? 'test-rotated-token' : null);
          if (approved) {
            await click(button(document.querySelector('.bot-token-modal')!, 'Готово'));
            await click(f.host.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')!); await openEditor(f.host);
            assert.equal(!!tokenInput(), false, 'закрытый перевыпущенный токен не возвращается');
          }
        } else assert.equal(f.host.querySelectorAll('.bot-editor').length, approved ? 0 : 1);
      }, { confirm: pending });
    } finally { resolve(false); }
  });
}
async function escapeProbe(source = raw) {
  await fixture(async f => {
    await openEditor(f.host); await click(button(f.host, 'Перевыпустить токен'));
    const modal = document.querySelector<HTMLElement>('.bot-token-modal'); assert.equal(!!modal, true);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await React.act(async () => { modal!.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true, 'R297-token-escape');
    assert.equal(document.querySelectorAll('.bot-token-modal').length, 0);
    assert.equal(f.closed(), 0); assert.equal(f.host.querySelectorAll('.bot-editor').length, 1);
    // Контрфакт не-Escape: соседняя клавиша не закрывает окно, следующий Escape настроек уже работает.
    await React.act(async () => { f.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(f.closed(), 1);
  }, {}, source);
}
it('R297 Esc окна токена поглощается, настройки под ним остаются открыты', () => escapeProbe());
it('R297 другая клавиша не закрывает окно токена', async () => {
  await fixture(async f => { await openEditor(f.host); await click(button(f.host, 'Перевыпустить токен'));
    await React.act(async () => { document.querySelector('.bot-token-modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    assert.equal(document.querySelectorAll('.bot-token-modal').length, 1); assert.equal(f.closed(), 0);
  });
});
it('R297 контрфакт: Esc токена без preventDefault закрывает также настройки', async () => {
  await escapeProbe();
  await assert.rejects(() => escapeProbe(mutate(raw, 'e.preventDefault();\n          onClose();', 'onClose();')),
    assertion('R297-token-escape', false, true));
});
it('R297 контрфакт: объяснение запрета заменено кнопкой создания', async () => {
  await offProbe();
  await assert.rejects(() => offProbe(mutate(raw, '(block ? (', '(false ? (')),
    assertion('R297-off-create', 1, 0));
});

function docsProbe(host: ParentNode, docs: string | null, llms: string | null) {
  const links = [...host.querySelectorAll<HTMLAnchorElement>('.bot-docs a')];
  assert.equal(links.length, Number(!!docs) + Number(!!llms), 'R300-docs-link-count');
  for (const [label, url] of [['Как написать своего бота', docs], ['Справка для нейронки', llms]] as const) {
    const link = links.find(x => x.textContent === label);
    assert.equal(!!link, !!url, `R300-docs-visible-${label}`);
    if (!url) continue;
    assert.equal(link!.getAttribute('href'), url, `R300-docs-href-${label}`);
    assert.equal(link!.target, '_blank');
    assert.equal(link!.rel, 'noreferrer');
  }
  if (llms) assert.equal(links.find(x => x.textContent === 'Справка для нейронки')!.title.includes('Вставьте этот файл'), true);
}
it('R300 инструкция для человека и llms своего инстанса доступны в списке и карточке', async () => {
  const llms = 'https://guest.example.test/api/bot/v1/llms.txt';
  await fixture(async f => {
    docsProbe(f.host, rules.BOT_DOCS_URL, llms);
    await openEditor(f.host); docsProbe(f.host, rules.BOT_DOCS_URL, llms);
  }, { llmsUrl: llms });
});
it('R300 без botLlmsUrl старый API оставляет только инструкцию для человека', async () => {
  await fixture(async f => { docsProbe(f.host, rules.BOT_DOCS_URL, null); await openEditor(f.host); docsProbe(f.host, rules.BOT_DOCS_URL, null); });
});
it('R300 пустая ссылка человека не скрывает llms, отсутствие обеих убирает блок документации', async () => {
  await fixture(async f => {
    docsProbe(f.host, null, '/api/bot/v1/llms.txt'); await openEditor(f.host); docsProbe(f.host, null, '/api/bot/v1/llms.txt');
  }, { docsUrl: '', llmsUrl: '/api/bot/v1/llms.txt' });
  await fixture(async f => {
    assert.equal(f.host.querySelectorAll('.bot-docs').length, 0); await openEditor(f.host);
    assert.equal(f.host.querySelectorAll('.bot-docs').length, 0);
  }, { docsUrl: '', llmsUrl: null });
});
it('R300 карточка доставки выводит полный адрес подсказкой, статус и понятную ошибку', async () => {
  const url = `https://bot.example.test/${'long-path/'.repeat(8)}events`;
  await fixture(async f => {
    await openEditor(f.host);
    const values = [...f.host.querySelectorAll<HTMLElement>('.bot-delivery dd')];
    assert.equal(values.length, 3);
    assert.equal(values[0].title, url); assert.equal(values[0].textContent, rules.middleEllipsis(url));
    assert.equal(values[1].classList.contains('warn'), true);
    assert.equal(values[1].textContent, 'Есть сбои — сервер повторяет доставку');
    assert.equal(values[2].textContent, 'адрес бота ответил кодом 502');
  }, { currentBot: { ...bot, webhook: { url, disabledAt: null, failures: 1, lastError: 'ответ 502' } } });
});
it('R300 контрфакт: ссылка нейронке потеряна, но инструкция человеку осталась', async () => {
  const llms = 'https://guest.example.test/api/bot/v1/llms.txt';
  const probe = (source = raw) => fixture(async f => { docsProbe(f.host, rules.BOT_DOCS_URL, llms); }, { llmsUrl: llms }, source);
  await probe();
  await assert.rejects(() => probe(mutate(raw, '{llms && (', '{false && (')), assertion('R300-docs-link-count', 1, 2));
});
