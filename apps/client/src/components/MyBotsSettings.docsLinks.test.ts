import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as botRules from '../botRules';
import { React, environment, load, reactProps, sourceOf } from './R171.phoneHarness';

const source = sourceOf('MyBotsSettings');
const docs = 'https://docs.example.org/bots';
const llms = 'https://api.example.org/v1/bots/llms.txt';
const P = 'R361/docs/check/';
const unused = () => { throw new Error('R361/docs/setup/неожиданная граница'); };

async function check(raw: string, index: number) {
  await environment(async (host, render) => {
    let renders = 0, calls = 0;
    const opened: string[] = [];
    // Целый production-модуль; добавлен лишь test-access к приватному компоненту без хуков.
    const mod = load<{ __docs: () => React.ReactNode }>(new URL('./MyBotsSettings.tsx', import.meta.url), raw + '\nexport { BotDocsLinks as __docs };', {
      '@gusvoice/shared': shared, '../botRules': { ...botRules, BOT_DOCS_URL: docs },
      '../api': { api: { botLlmsUrl: () => llms } },
      '../linkGuard': { openLink(url: string) {
        if (++calls > 10) throw new Error('R361/docs/budget/openLink');
        opened.push(url);
      } },
      '../androidBack': { pushBackHandler: unused }, '../confirm': { confirmAction: unused },
      '../dialogChrome': { useDialogChrome: unused }, '../store': { useStore: unused },
      '../toast': { toast: unused, toastError: unused }, './Avatar': { Avatar: unused },
      './Icon': { Icon: unused }, './Toggle': { Toggle: unused },
    });
    function Docs() {
      if (++renders > 10) throw new Error('R361/docs/budget/render');
      return mod.__docs();
    }
    await render(React.createElement(Docs));
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.bot-docs a')];
    assert.equal(links.length, 2, P + 'обе-ссылки');
    const link = links[index], href = [docs, llms][index];
    assert.equal(link.getAttribute('href'), href, P + 'настоящий-href');
    assert.equal(link.getAttribute('target'), '_blank', P + 'контекстное-меню-веба');
    assert.equal(link.textContent?.trim(), ['Как написать своего бота', 'Справка для нейронки'][index], P + 'подпись');
    assert.deepEqual(opened, [], P + 'рендер-не-открывает');
    let prevented = 0;
    // Доставка настоящему React onClick, без браузерного default-action/создания окна в happy-dom.
    await React.act(async () => { reactProps(link).onClick({ preventDefault() { prevented++; } }); });
    assert.equal(prevented, 1, P + 'переход-отменён');
    assert.deepEqual(opened, [href], P + 'один-openLink-с-href');
    assert.equal(link.getAttribute('href'), href, P + 'href-сохранён-после-клика');
    assert.equal(link.getAttribute('target'), '_blank', P + 'target-сохранён-после-клика');
  });
}

for (const [index, title] of ['Как написать своего бота', 'Справка для нейронки'].entries()) {
  it(`R361 «${title}»: клик отменяет переход и открывает свой href через openLink`, async () => {
    // target=_blank сам по себе не работает в WebView2, но остаётся нужен контекстному меню веба.
    await check(source, index);
    for (const [from, to] of [
      ['function openDoc(e: React.MouseEvent, url: string) {\n  e.preventDefault();', 'function openDoc(e: React.MouseEvent, url: string) {'],
      ['  openLink(url);', "  openLink('https://wrong.example.org/');"],
    ]) {
      await counterfact(async () => {
        assert.equal(source.split(from).length - 1, 1, 'R361/docs/setup/единственный-якорь');
        await assert.rejects(check(source.replace(from, to), index),
          e => e instanceof assert.AssertionError && e.message.startsWith(P),
          'мутант нарушает адресное поведение, не загрузку или бюджет');
      });
      await check(source, index);
    }
  });
}
