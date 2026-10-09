import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, it } from 'node:test';
import { spawn } from 'node:child_process';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import type { ContextMenu as ContextMenuType } from './ContextMenu';
import type { MenuItem as MenuItemType } from './ContextMenu';

let server: ViteDevServer;
let ContextMenu: typeof ContextMenuType;
let MenuItem: typeof MenuItemType;
let root: Root;
let host: HTMLDivElement;
let closes = 0;
const MUTANTS = {
  'удалён eventPhase guard': (source: string) => source.replace(
    '      if (itemClick.current && itemClick.current !== e && itemClick.current.eventPhase !== Event.NONE) return;',
    '      // mutant: nested click is no longer exempt'),
  'условие guard всегда истинно': (source: string) => source.replace(
    'itemClick.current.eventPhase !== Event.NONE', 'true'),
  'возвращён фильтр isTrusted': (source: string) => source.replace(
    '      if (itemClick.current && itemClick.current !== e && itemClick.current.eventPhase !== Event.NONE) return;',
    '      if (!e.isTrusted) return;'),
} as const;
const MUTANT_ASSERTIONS: Record<keyof typeof MUTANTS, string> = {
  'удалён eventPhase guard': 'вложенный click действительно дошёл до кнопки ровно один раз',
  'условие guard всегда истинно': 'последующий независимый промах подавлен',
  'возвращён фильтр isTrusted': 'последующий независимый промах подавлен',
};

async function createMenuServer(mutant?: keyof typeof MUTANTS) {
  return createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-context-menu-test-')),
    plugins: [
      { name: 'context-menu-regression-mutant', enforce: 'pre', transform(source, id) {
        if (!id.replaceAll('\\', '/').endsWith('/components/ContextMenu.tsx')) return;
        source = source.replace(/\r\n/g, '\n');
        if (!mutant) return;
        const changed = MUTANTS[mutant](source);
        assert.notEqual(changed, source, `исходник ContextMenu действительно мутирован: ${mutant}`);
        return changed;
      } },
      { name: 'test-env-empty-config', enforce: 'pre', transform(source, id) {
        if (!id.replaceAll('\\', '/').endsWith('/src/config.ts')) return;
        return source.replaceAll('import.meta.env.', '({}).');
      } },
    ],
    optimizeDeps: { noDiscovery: true, include: [] }, define: { 'import.meta.env': '{}' },
    esbuild: { jsx: 'automatic' }, resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
}

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  server = await createMenuServer(process.env.GUSVOICE_CONTEXT_MUTANT as keyof typeof MUTANTS | undefined);
  const module = await server.ssrLoadModule('/src/components/ContextMenu.tsx');
  ContextMenu = module.ContextMenu; MenuItem = module.MenuItem;
});

async function mount(mode: 'anchor' | 'spotlight', fireNested: (target: HTMLElement, event: MouseEvent) => void) {
  closes = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const external = document.createElement('div'); external.className = 'external'; document.body.append(external);
  const button = document.createElement('button'); button.textContent = 'Вне меню'; external.append(button);
  const file = document.createElement('input'); file.type = 'file'; external.append(file);
  for (const target of [button, file]) target.addEventListener('click', (event) => fireNested(target, event as MouseEvent));
  const onClose = () => { closes++; };
  const children = createElement(MenuItem, { label: 'Выполнить', onClick: () => { button.click(); file.click(); } });
  await act(async () => { root.render(mode === 'anchor'
    ? createElement(ContextMenu, { anchor: new DOMRect(10, 10, 40, 30), onClose, children })
    : createElement(ContextMenu, { pos: { x: 10, y: 10 }, spotlight: { top: 10, bottom: 40 }, onClose, children })); });
  return { button, file, external };
}

async function verify(mode: 'anchor' | 'spotlight') {
  const seen = new Map<HTMLElement, MouseEvent[]>();
  const { button, file, external } = await mount(mode, (target, event) => {
    const events = seen.get(target) ?? []; events.push(event); seen.set(target, events);
  });
  let outsideHandled = 0;
  let separateOutside: HTMLDivElement | undefined;
  external.addEventListener('click', () => { outsideHandled++; });
  try {
    const item = document.querySelector<HTMLButtonElement>('.ctx-item'); assert.ok(item);
    await act(async () => { item.click(); });
    assert.equal(seen.get(button)?.length, 1, 'вложенный click действительно дошёл до кнопки ровно один раз');
    assert.equal(seen.get(button)?.[0]?.defaultPrevented, false, 'вложенный click кнопки не отменён');
    assert.equal(seen.get(file)?.length, 1, 'вложенный click действительно дошёл до file input ровно один раз');
    assert.equal(seen.get(file)?.[0]?.defaultPrevented, false, 'вложенный click file input не отменён');
    assert.equal(closes, 0, 'вложенные клики не закрывают меню');
    outsideHandled = 0;
    const outside = new MouseEvent('click', { bubbles: true, cancelable: true });
    separateOutside = document.createElement('div'); document.body.append(separateOutside);
    separateOutside.addEventListener('click', () => { outsideHandled++; });
    await act(async () => { separateOutside!.dispatchEvent(outside); });
    assert.equal(outside.defaultPrevented, true, 'последующий независимый промах подавлен');
    assert.equal(closes, 1, 'последующий независимый промах закрывает меню ровно один раз');
    assert.equal(outsideHandled, 0, 'независимый промах остановлен до внешнего обработчика');
  } finally {
    await act(async () => root.unmount()); host.remove(); external.remove(); separateOutside?.remove();
  }
}

it('якорное меню пропускает синхронные активации наружу, но поглощает следующий промах', async () => verify('anchor'));
it('меню с spotlight пропускает синхронные активации наружу, но поглощает следующий промах', async () => verify('spotlight'));

for (const mutant of Object.keys(MUTANTS) as Array<keyof typeof MUTANTS>) {
  it(`исходниковый мутант ContextMenu: ${mutant}`, async () => {
    if (process.env.GUSVOICE_CONTEXT_MUTANT === mutant) {
      let scenarioFailure: unknown;
      try { await verify('anchor'); } catch (error) { scenarioFailure = error; }
      assert.ok(scenarioFailure instanceof assert.AssertionError, `сценарий обнаружил мутант ${mutant}`);
      assert.ok(scenarioFailure.message.startsWith(MUTANT_ASSERTIONS[mutant]),
        `мутант ${mutant} обнаружен ожидаемым поведенческим контрфактом: ${scenarioFailure.message}`);
      return;
    }
    await verify('anchor');
    const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_CONTEXT_MUTANT: mutant };
    delete env.NODE_TEST_CONTEXT;
    const pattern = `^исходниковый мутант ContextMenu: ${mutant}$`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern', pattern, fileURLToPath(import.meta.url)],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; }); child.stderr.on('data', (chunk: string) => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(status, 0, `сценарий должен обнаружить мутант ожидаемой ошибкой: ${mutant}\n${output}`);
    assert.match(output, /# pass 1(?:\r?\n|$)/, 'дочерний сценарий завершился успешно только потому, что проверка поймала регрессию');
  });
}

after(async () => { await server?.close(); GlobalRegistrator.unregister(); });
