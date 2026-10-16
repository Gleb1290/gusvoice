import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as safety from './linkSafety';
import * as previewRules from './linkPreviewRules';
import * as dangerousRules from './dangerousLinkRules';

const source = readFileSync(new URL('./linkGuard.tsx', import.meta.url), 'utf8');
type Guard = typeof import('./linkGuard');
type Node = ReactElement<Record<string, unknown>>;

// Загружаем весь настоящий модуль, а не извлечённый обработчик. Только окружение
// подменено: чистые правила ссылки настоящие, портал прозрачен, useState хранит состояние клика.
function load(text = source) {
  let state = false;
  const opened: unknown[][] = [];
  const storageReads: string[] = [];
  const storageWrites: string[] = [];
  const dependencies: Record<string, unknown> = {
    react: { useState: () => [state, (next: boolean) => { state = next; }] },
    'react/jsx-runtime': jsxRuntime,
    'react-dom': { createPortal: (child: unknown) => child },
    './config': { config: { apiUrl: 'https://api.voice.example' } },
    './hotkeys': { isDesktop: () => false },
    './desktopWindow': { openExternal: async () => { assert.fail('веб не запускает desktop API'); } },
    './linkSafety': safety,
    './dangerousLinkRules': dangerousRules,
    './dangerousLink': { DangerousMessageLink: () => { assert.fail('обычный сценарий не входит в опасную ссылку'); } },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, URL,
    location: { host: 'voice.example' }, document: { body: {} },
    window: { open: (...args: unknown[]) => { opened.push(args); } },
    localStorage: {
      getItem: (key: string) => { storageReads.push(key); return JSON.stringify({ off: true, trusted: ['xn--pple-43d.com'] }); },
      setItem: (key: string) => { storageWrites.push(key); },
    },
    require: (id: string) => { assert.ok(id in dependencies, `неожиданный импорт ${id}`); return dependencies[id]; },
  });
  const guard = module.exports as Guard;
  const render = (url: string) => guard.MessageLink({ url });
  return { guard, render, opened, storageReads, storageWrites };
}

function nodes(tree: ReactNode): Node[] {
  const result: Node[] = [];
  Children.forEach(tree, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (typeof child.type === 'function') {
      result.push(...nodes((child.type as (props: unknown) => ReactNode)(child.props)));
    } else {
      result.push(child);
      result.push(...nodes(child.props.children as ReactNode));
    }
  });
  return result;
}
function clickLink(h: ReturnType<typeof load>, url: string) {
  const anchor = nodes(h.render(url)).find(n => n.type === 'a');
  assert.ok(anchor, 'настоящий MessageLink рисует ссылку');
  let prevented = false;
  (anchor.props.onClick as (event: unknown) => void)({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'браузерный переход контролирует обработчик');
  return nodes(h.render(url));
}
const modal = (tree: Node[]) => tree.find(n => n.props.className === 'modal link-confirm');
function press(tree: Node[], label: string) {
  const button = tree.find(n => n.type === 'button' && n.props.children === label);
  assert.ok(button, `есть действие ${label}`);
  (button.props.onClick as () => void)();
}
function ordinary(h: ReturnType<typeof load>) {
  const url = 'https://outside.example/page?x=1';
  assert.equal(h.guard.shouldWarnAboutLink(url), false);
  assert.equal(modal(clickLink(h, url)), undefined, 'обычная чужая ссылка не рисует окно');
  assert.deepEqual(h.opened, [[url, '_blank', 'noopener,noreferrer']], 'открывается сразу и ровно один раз');
}
function suspicious(h: ReturnType<typeof load>) {
  const url = 'https://xn--pple-43d.com/login';
  assert.equal(h.guard.shouldWarnAboutLink(url), true);
  const tree = clickLink(h, url);
  assert.ok(modal(tree), 'подозрительная чужая ссылка требует подтверждения');
  assert.deepEqual(h.opened, [], 'до решения пользователя перехода нет');
  assert.equal(tree.some(n => n.type === 'input'), false, 'галочек доверия или отключения предупреждения нет');
  assert.equal(tree.find(n => n.props.className === 'lc-mark')?.props.children, 'а', 'подсвечена кириллическая а, не punycode');
  assert.ok(tree.some(n => n.props.className === 'lc-hint'), 'подсветка сопровождается объяснением');
  press(tree, 'Отмена');
  assert.equal(modal(nodes(h.render(url))), undefined, 'отмена закрывает окно');
  assert.deepEqual(h.opened, [], 'отмена не открывает ссылку');
  press(clickLink(h, url), 'Открыть');
  assert.deepEqual(h.opened, [[url, '_blank', 'noopener,noreferrer']], 'подтверждение открывает исходный URL ровно один раз');
  assert.equal(modal(nodes(h.render(url))), undefined, 'подтверждение закрывает окно');
}
function own(h: ReturnType<typeof load>) {
  for (const prefix of ['', 'api.', 'presence.', 'lk.']) {
    const url = `https://user:pw@${prefix}voice.example/path`;
    assert.equal(safety.isSuspiciousUrl(url), true, 'логин/пароль делает fixture действительно подозрительной');
    assert.equal(h.guard.shouldWarnAboutLink(url), false, 'свой хост исключён из предупреждений');
    assert.equal(modal(clickLink(h, url)), undefined);
  }
  assert.equal(h.opened.length, 4, 'каждый адрес собственного инстанса сразу открыт');
}

it('обычная чужая ссылка открывается сразу без окна', () => ordinary(load()));
it('подозрительная ссылка показывает Unicode и подсветку: отмена безопасна, подтверждение открывает', () => suspicious(load()));
it('свой инстанс и api/presence/lk не спрашивают даже при логине и пароле в адресе', () => own(load()));
it('старое off:true и доверенный домен не отключают предупреждение и не читаются', () => {
  const h = load(); suspicious(h);
  assert.deepEqual(h.storageReads, [], 'устаревший ключ больше не влияет на безопасность');
  assert.deepEqual(h.storageWrites, [], 'подтверждение не сохраняет доверие');
});
it('при логине без смешения алфавитов выделен домен, а не придумана подсветка', () => {
  const h = load(); const tree = clickLink(h, 'https://user@evil.com');
  assert.ok(modal(tree));
  assert.equal(tree.find(n => n.props.className === 'lc-bold')?.props.children, 'evil.com');
  assert.equal(tree.some(n => n.props.className === 'lc-mark' || n.props.className === 'lc-hint'), false);
});

async function preview(h: ReturnType<typeof load>, url: string) {
  const text = readFileSync(new URL('./components/LinkPreview.tsx', import.meta.url), 'utf8');
  const state: unknown[] = [];
  let cursor = 0;
  let firstRender = true;
  const effects: Array<() => unknown> = [];
  const requested: string[] = [];
  const dependencies: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state)) state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [state[index], (next: unknown) => { state[index] = next; }];
      },
      useEffect: (effect: () => unknown) => { if (firstRender) effects.push(effect); },
    },
    'react/jsx-runtime': jsxRuntime,
    '../api': { api: { linkPreview: (target: string) => {
      requested.push(target);
      return Promise.resolve({ url: target, title: 'Настоящее превью', description: 'Описание', siteName: 'Сайт' });
    } } },
    '../linkGuard': h.guard,
    '../linkPreviewRules': previewRules,
    './Icon': { Icon: () => null },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, URL,
    localStorage: { getItem: () => null },
    require: (id: string) => { assert.ok(id in dependencies, `неожиданный импорт превью ${id}`); return dependencies[id]; },
  });
  const card = (module.exports as typeof import('./components/LinkPreview')).LinkPreviewCard;
  const render = () => { cursor = 0; const tree = nodes(card({ url })); firstRender = false; return tree; };
  assert.deepEqual(render(), [], 'до ответа API карточка действительно не готова');
  for (const effect of effects) effect();
  // Цепочка настоящего компонента: then/catch/finally/run.then. Никакого
  // инъецирования готового data в хук: карточка появляется только после ответа API.
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  assert.deepEqual(requested, [url], 'данные запрошены через настоящий эффект карточки');
  const click = () => {
    const button = render().find(n => n.props.className === 'lp-card');
    assert.ok(button, 'настоящий LinkPreviewCard показал ответ API');
    (button.props.onClick as () => void)();
    return render();
  };
  return { click, render };
}

it('карточка превью обычной ссылки открывает исходный адрес сразу без окна', async () => {
  const h = load(); const url = 'https://outside.example/preview?x=1';
  const card = await preview(h, url);
  assert.equal(modal(card.click()), undefined);
  assert.deepEqual(h.opened, [[url, '_blank', 'noopener,noreferrer']]);
});

it('карточка превью подозрительной ссылки: отмена не открывает, подтверждение открывает и закрывает окно', async () => {
  const h = load(); const url = 'https://xn--pple-43d.com/preview';
  const card = await preview(h, url); const tree = card.click();
  assert.ok(modal(tree), 'превью не обходит общий guard');
  assert.deepEqual(h.opened, []);
  assert.equal(tree.some(n => n.type === 'input'), false, 'у превью также нет старых галочек');
  press(tree, 'Отмена');
  assert.equal(modal(card.render()), undefined);
  assert.deepEqual(h.opened, [], 'отмена не вызывает переход');
  press(card.click(), 'Открыть');
  assert.deepEqual(h.opened, [[url, '_blank', 'noopener,noreferrer']], 'открыт исходный URL один раз');
  assert.equal(modal(card.render()), undefined, 'подтверждение закрывает портал');
});

const guardStart = 'export function shouldWarnAboutLink(url: string): boolean {';
for (const [name, change, check] of [
  ['всегда предупреждать', (s: string) => s.replace(guardStart, `${guardStart}\n return true;`), ordinary],
  ['никогда не предупреждать', (s: string) => s.replace(guardStart, `${guardStart}\n return false;`), suspicious],
  ['не проверять свой хост', (s: string) => s.replace('if (isOwnHost(u)) return false;', ''), own],
  ['вернуть чтение gv_link_warn', (s: string) => s.replace(guardStart, `${guardStart}\n if (JSON.parse(localStorage.getItem('gv_link_warn') || '{}').off) return false;`), suspicious],
] as const) {
  it(`R143 контрфакт «${name}» отвергается тем же поведенческим сценарием`, () => {
    check(load()); // Сначала original: ошибка загрузчика не считается пойманной регрессией.
    const changed = change(source);
    assert.notEqual(changed, source, 'найден участок мутации');
    const mutant = load(changed); // Мутант также обязан успешно загрузить весь модуль.
    assert.throws(() => check(mutant), assert.AssertionError);
  });
}
