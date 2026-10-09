import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessagePort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { before, after, afterEach, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createServer, type ViteDevServer } from 'vite';
import { createElement, Fragment, act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '@gusvoice/shared';
import type { MessagePane as PaneType } from './MessagePane';
export type Props = ComponentProps<typeof PaneType>;
type UiClock = { runTimers(): void; runFrame(): void; restore(): void };
// Один изолированный worker на тематический файл; helper сам не регистрирует тестов.
export function setupHarness(entrypoint: string) {
    let server: ViteDevServer;
    let Pane: typeof PaneType;
    let ConfirmHost: typeof import('./ConfirmHost').ConfirmHost;
    let TextSelLayer: typeof import('./TextSelection').TextSelLayer;
    let textNodes: typeof import('./TextSelection').textNodes;
    let wordSelAt: typeof import('./TextSelection').wordSelAt;
    let allTextSel: typeof import('./TextSelection').allTextSel;
    let root: Root | null = null;
    let host: HTMLDivElement;
    const rendered: string[] = [];
    const nodeTimeout = globalThis.setTimeout;
    const nodeClearTimeout = globalThis.clearTimeout;
    let uiClock: UiClock | undefined;
    let maxChildRss = 0;
    async function bounded<T>(label: string, work: () => Promise<T>, ms = 10000): Promise<T> {
        if (process.env.GUSVOICE_PANE_MUTANT)
            process.stderr.write(`[pane] ${label}\n`);
        let timer: ReturnType<typeof setTimeout>;
        try {
            return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
                    timer = nodeTimeout(() => reject(new Error(`Таймаут харнесса: ${label} (${ms} мс)`)), ms);
                })]);
        }
        finally {
            nodeClearTimeout(timer!);
        }
    }
    function unmount() {
        // Синхронный act не ждёт фоновых задач приложения при уборке неудачного сценария.
        const current = root;
        root = null;
        try {
            if (current)
                act(() => current.unmount());
        }
        finally {
            host?.remove();
            uiClock?.restore();
        }
    }
    function controlUiClock(): UiClock {
        assert.equal(uiClock, undefined, 'ручные часы не устанавливаются поверх предыдущих');
        // Только после импорта/монтирования: Vite и watchdog сохраняют настоящие таймеры.
        // HappyDOM реализует RAF через setImmediate, который может пройти ВНУТРИ async act,
        // до commit закрытия ConfirmHost. Кадр браузера здесь запускает сам сценарий ПОСЛЕ act.
        const frames = new Map<number, FrameRequestCallback>();
        const timers = new Map<number, () => void>();
        // Не пересекаемся с положительными browser timer IDs ненулевых задержек.
        let nextId = -1;
        let frameTime = 0;
        let restored = false;
        const saved: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = [];
        const request: typeof window.requestAnimationFrame = (callback) => {
            const id = nextId--; frames.set(id, callback); return id;
        };
        const cancel: typeof window.cancelAnimationFrame = (id) => { frames.delete(id); };
        for (const target of [globalThis, window]) {
            const originalSet = target.setTimeout.bind(target);
            const originalClear = target.clearTimeout.bind(target);
            const set = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
                if (typeof handler === 'function' && (ms ?? 0) === 0) {
                    const id = nextId--; timers.set(id, () => handler(...args)); return id;
                }
                // Ненулевые задержки, в том числе flush/анимации меню, не замораживаем.
                return originalSet(handler as () => void, ms, ...args) as unknown as number;
            };
            const clear = (id: unknown) => {
                if (typeof id === 'number' && timers.delete(id)) return;
                originalClear(id as never);
            };
            for (const [key, value] of Object.entries({ requestAnimationFrame: request, cancelAnimationFrame: cancel, setTimeout: set, clearTimeout: clear })) {
                saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
                Object.defineProperty(target, key, { configurable: true, writable: true, value });
            }
        }
        const clock = {
            runTimers() {
                // Один turn; новый таймер из callback относится уже к следующему turn.
                for (const [id, callback] of [...timers]) {
                    if (!timers.delete(id)) continue;
                    callback();
                }
            },
            runFrame() {
                frameTime += 16;
                // Новые RAF не попадают в этот кадр; отмена соседа внутри кадра учитывается.
                for (const [id, callback] of [...frames]) {
                    if (!frames.delete(id)) continue;
                    callback(frameTime);
                }
            },
            restore() {
                if (restored) return;
                restored = true;
                frames.clear(); timers.clear();
                for (const { target, key, descriptor } of saved.reverse()) {
                    if (descriptor) Object.defineProperty(target, key, descriptor);
                    else Reflect.deleteProperty(target, key);
                }
                uiClock = undefined;
            },
        };
        uiClock = clock;
        return clock;
    }
    async function runUiTimers() {
        assert.ok(uiClock, 'ручные часы установлены');
        await act(async () => { uiClock!.runTimers(); });
    }
    async function runUiFrame() {
        assert.ok(uiClock, 'ручные часы установлены');
        await act(async () => { uiClock!.runFrame(); });
    }
    const activeHandles = () => (process as unknown as {
        _getActiveHandles(): object[];
    })._getActiveHandles();
    const originalHandles = new Set(activeHandles());
    let originalUa: string;
    let originalMatchMedia: typeof window.matchMedia;
    let resetStore: (() => void) | undefined;
    const delay = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const now = Date.now();
    const msg = (id: string, author = 'me', ago = 0, sortKey = 10): Message & {
        sortKey?: number;
    } => ({ id, channelId: 'c', content: id, sortKey,
        author: { id: author, username: author, displayName: author, avatarUrl: null }, createdAt: new Date(now - ago).toISOString(), editedAt: null,
        attachments: [], reactions: [], replyTo: null } as Message);
    const base: Props = { title: 'Беседа', placeholder: 'Написать', messages: [], meId: 'me', bubbles: true, feedId: 'c',
        onSend: async () => { }, onEdit: async () => { }, onDelete: async () => { } };
    before(async () => {
        // Таймеры HappyDOM убираются его abort/unregister; native watchdog не подменяем.
        GlobalRegistrator.register({ url: 'http://localhost/' });
        localStorage.setItem('gv_dm_bubbles', '0');
        localStorage.removeItem('gv_dbl_action');
        localStorage.removeItem('gv_quick_reaction');
        originalUa = navigator.userAgent;
        originalMatchMedia = window.matchMedia;
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => new Response(null, { status: 503 }) });
        class ClosedSocket {
            readyState = 3;
            close() { }
            send() { }
            addEventListener() { }
            removeEventListener() { }
        }
        Object.assign(globalThis, { WebSocket: ClosedSocket });
        Object.assign(globalThis, { __testRowRendered: (id: string) => rendered.push(id) });
        if (!process.env.GUSVOICE_PANE_MUTANT) {
            const textMutation = process.env.GUSVOICE_TEXTSEL_MUTANT;
            server = await paneServer(textMutation ? (source) => mutateTextSelectionSource(source, textMutation) : undefined, textMutation ? 'TextSelection' : 'MessagePane');
            const module = await server.ssrLoadModule('/src/components/MessagePane.tsx');
            Pane = module.MessagePane;
            ConfirmHost = (await server.ssrLoadModule('/src/components/ConfirmHost.tsx')).ConfirmHost;
            const textSelection = await server.ssrLoadModule('/src/components/TextSelection.tsx');
            TextSelLayer = textSelection.TextSelLayer;
            textNodes = textSelection.textNodes;
            wordSelAt = textSelection.wordSelAt;
            allTextSel = textSelection.allTextSel;
        }
    });
    function mutateTextSelectionSource(source: string, name: string) {
        const mutation = {
            'мутант включает текст закрытого спойлера': (s: string) => s.replace(', .spoiler:not(.open)', ''),
            'мутант расширяет промах выбора слова до 80 пикселей': (s: string) => s.replace('const SLOP = 8;', 'const SLOP = 80;'),
            'мутант пропускает touchstart из слоя к строке': (s: string) => s.replace('      // До строки касание не доходит: ни долгого нажатия, ни свайпа, ни двойного тапа. Прокрутка — своя, браузерная.\n      e.stopPropagation();', '      // mutant: касание доходит до строки'),
            'R110 allTextSel выбирает всё тело с краевыми пробелами, пустое тело не выбирает': (s: string) => s.replace('start: 0, end: text.length', 'start: 0, end: wordBounds(text, 2)[1]'),
        }[name];
        assert.ok(mutation, `для мутанта «${name}» задано преобразование исходника`);
        const changed = mutation(source);
        assert.notEqual(changed, source, `мутант «${name}» изменил целевой контракт`);
        return changed;
    }
    async function paneServer(change?: (source: string) => string, target = 'MessagePane', tinyEmojiFixture = false) {
        return createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false,
            cacheDir: mkdtempSync(join(tmpdir(), 'gusvoice-pane-test-')), optimizeDeps: { noDiscovery: true, include: [] },
            plugins: [
                { name: 'test-row-render-counter', enforce: 'pre', transform(code, id) {
                        if (!id.replaceAll('\\', '/').endsWith(`/components/${target}.tsx`))
                            return;
                        code = code.replace(/\r\n/g, '\n');
                        if (change) {
                            const changed = change(code);
                            assert.notEqual(changed, code);
                            code = changed;
                        }
                        if (target !== 'MessagePane')
                            return code;
                        const marker = '}: MessageRowProps) {';
                        assert.ok(code.includes(marker), 'найдена строка инструментирования MessageRow');
                        return code.replace(marker, marker + '\n(globalThis as any).__testRowRendered(m.id);');
                    } },
                { name: 'tiny-emoji-data-for-dock-fixture', enforce: 'pre', transform(_code, id) {
                        if (!tinyEmojiFixture || !id.replaceAll('\\', '/').endsWith('/emojiData.ts'))
                            return;
                        // В этом тесте важны настоящие Picker/MessagePane/handlers, не полнота каталога из 1914 строк.
                        // Берём реальные записи emojibase, чтобы не раздувать HappyDOM тысячами ячеек.
                        return `export const EMOJI_GROUPS: string[] = ["Смайлы", "Люди и жесты"];
  export const EMOJI_DATA = [["😀","широко улыбается",0,["лицо"],["grinning"]],["👍","большой палец вверх",1,["лайк"],["thumbsup"]]];`;
                    } },
                { name: 'forward-before-text-mutant', enforce: 'pre', transform(code, id) {
                        if (!id.includes('/components/MessagePane.tsx?codex-forward-order-mutant'))
                            return;
                        code = code.replace(/\r\n/g, '\n');
                        const from = 'if (keys.length > 0) await outboxSettled(to, keys);';
                        assert.ok(code.includes(from), 'найден настоящий барьер завершения очереди перед пересылкой');
                        return code.replace(from, 'if (false) await outboxSettled(to, keys);');
                    } },
            ],
            esbuild: { jsx: 'automatic' }, resolve: { alias: { '@gusvoice/shared': fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url)) } },
            server: { middlewareMode: true, hmr: false, watch: null, ws: false }, appType: 'custom', logLevel: 'error' });
    }
    async function mountTextSelLayer(props: ComponentProps<typeof TextSelLayer>) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(TextSelLayer, props)); await flush(); });
    }
    function textSurface(value = '  hello world  ') {
        const feed = document.createElement('div');
        feed.className = 'messages';
        const body = document.createElement('div');
        body.className = 'message-body';
        body.textContent = value;
        feed.append(body);
        document.body.append(feed);
        feed.getBoundingClientRect = () => new DOMRect(0, 80, 400, 500);
        body.getBoundingClientRect = () => new DOMRect(20, 120, 160, 20);
        return { feed, body, node: body.firstChild as Text };
    }
    function mockTextRangeRects(node: Text) {
        // Range может унаследовать методы с realm-specific prototype; подменяем каждый экземпляр от document.createRange.
        const oldCreateRange = Object.getOwnPropertyDescriptor(document, 'createRange');
        const createRange = document.createRange.bind(document);
        Object.defineProperty(document, 'createRange', { configurable: true, value: () => {
                const range = createRange();
                Object.defineProperty(range, 'getBoundingClientRect', { configurable: true, value: function (this: Range) {
                        if (this.startContainer === node && this.endContainer === node && this.endOffset === this.startOffset + 1)
                            return new DOMRect(20 + this.startOffset * 10, 120, 10, 18);
                        return new DOMRect(20, 120, node.data.length * 10, 18);
                    } });
                Object.defineProperty(range, 'getClientRects', { configurable: true, value: () => [new DOMRect(20, 120, 80, 18)] });
                return range;
            } });
        return () => {
            if (oldCreateRange)
                Object.defineProperty(document, 'createRange', oldCreateRange);
            else
                Reflect.deleteProperty(document, 'createRange');
        };
    }
    async function textSelMutantTest(name: string, scenario: () => Promise<void> | void, expectedFailure?: string) {
        it(name, async () => {
            if (process.env.GUSVOICE_TEXTSEL_MUTANT === name) {
                await assert.rejects(async () => { await scenario(); }, (e: unknown) => e instanceof assert.AssertionError && (!expectedFailure || e.message.includes(expectedFailure)));
                return;
            }
            await scenario();
            const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_TEXTSEL_MUTANT: name };
            delete env.GUSVOICE_PANE_MUTANT;
            delete env.NODE_TEST_CONTEXT;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const output = await isolatedProcess(['--import', 'tsx', '--test-reporter', 'tap', '--test-name-pattern', `^${escaped}$`, fileURLToPath(entrypoint)], env, name);
            assert.match(output, /# pass 1(?:\r?\n|$)/, 'дочерний процесс выполнил ровно этот проверочный сценарий');
        });
    }
    afterEach(async () => {
        try {
            unmount();
        }
        finally {
            try {
                resetStore?.();
            }
            finally {
                resetStore = undefined;
                rendered.length = 0;
                localStorage.setItem('gv_dm_bubbles', '0');
                localStorage.removeItem('gv_dbl_action');
                localStorage.removeItem('gv_quick_reaction');
                Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUa });
                window.matchMedia = originalMatchMedia;
                Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
            }
        }
    });
    after(async () => {
        try {
            try {
                await bounded('happyDOM.abort', () => (window as unknown as {
                    happyDOM: {
                        abort(): Promise<void>;
                    };
                }).happyDOM.abort());
            }
            finally {
                try {
                    await bounded('основной Vite.close', async () => { await server?.close(); });
                }
                finally {
                    await bounded('GlobalRegistrator.unregister', () => GlobalRegistrator.unregister());
                }
            }
        }
        finally {
            // Scheduler загружается при уже существующем DOM и держит MessagePort даже после unmount.
            // Только новые порты этого worker: каналы самого node:test не трогаем.
            for (const handle of activeHandles())
                if (!originalHandles.has(handle) && handle instanceof MessagePort)
                    handle.unref();
            if (process.env.GUSVOICE_PANE_MEMORY === '1') {
                // Это максимум RSS одного процесса, а не сумма одновременно живущих workers.
                process.stdout.write(`# MessagePane peak RSS per process KiB: ${Math.max(process.resourceUsage().maxRSS, maxChildRss)}\n`);
            }
        }
    });
    async function mount(p: Partial<Props> = {}, component = Pane) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(component, { ...base, ...p })); await delay(); });
        return host;
    }
    async function mountWithConfirm(p: Partial<Props>, component = Pane, confirm = ConfirmHost) {
        await mount(p, component);
        await act(async () => {
            root!.render(createElement(Fragment, null, createElement(component, { ...base, ...p }), createElement(confirm)));
            await delay();
        });
        return host;
    }
    async function rerender(p: Partial<Props>, component = Pane) { await act(async () => { root!.render(createElement(component, { ...base, ...p })); await delay(); }); }
    function out(content = 'failed') { return { key: 'k', content, files: [], replyToId: null, status: 'failed' as const, error: 'сеть', createdAt: now }; }
    function mobile() {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'GusVoice Android' });
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    }
    function desktop() {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUa });
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
    function round12() { localStorage.setItem('gv_dm_bubbles', '1'); }
    function pin(id: string, authorId = 'me', forBoth = true) {
        return { message: { id, authorId, text: `Текст ${id}`, attachments: 0, sortKey: Number(id.replace(/\D/g, '')) || 1,
                createdAt: new Date(now).toISOString() }, forBoth, pinnedBy: authorId, pinnedAt: new Date(now).toISOString() } as never;
    }
    function pointerLayout(coarse: boolean, width: number) {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
            const result = original(query);
            Object.defineProperty(result, 'matches', { configurable: true, value: query.includes('pointer: coarse') ? coarse : query.includes('max-width: 760px') ? width <= 760 : query.includes('max-width: 620px') ? width <= 620 : result.matches });
            return result;
        };
        return () => { window.matchMedia = original; };
    }
    function touch(target: Element, type: string, x = 0, y = 0) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
        target.dispatchEvent(event);
        return event;
    }
    const queue = (items = [out()]) => ({ items, enqueue: () => { }, retry: () => { }, discard: () => { } });
    async function flush() { await act(async () => { await delay(40); }); }
    async function waitForFocus(field: HTMLElement) {
        // Возврат фокуса запланирован через RAF: длительность предыдущего flush не является контрактом.
        const deadline = Date.now() + 2000;
        while (document.activeElement !== field && Date.now() < deadline) {
            await act(async () => { await delay(10); });
        }
        // Assert остаётся в сценарии: мутант обязан упасть на конкретном ожидании фокуса, не на таймауте.
    }
    async function rejectMutant(change: (s: string) => string, check: (component: typeof Pane, confirm?: typeof ConfirmHost, answer?: () => void, runtime?: ViteDevServer) => Promise<void>, expectedFailure?: string) {
        let extra: ViteDevServer | undefined;
        try {
            if (!process.env.GUSVOICE_PANE_MUTANT) {
                const { useConfirmDialog } = await server.ssrLoadModule('/src/confirm.ts') as typeof import('../confirm');
                await bounded('оригинальный сценарий', () => check(Pane, ConfirmHost, () => useConfirmDialog.getState().answer(true), server));
                return;
            }
            extra = await bounded('создание Vite мутанта', () => paneServer(change));
            const { MessagePane } = await bounded('импорт мутанта', () => extra!.ssrLoadModule('/src/components/MessagePane.tsx'));
            const { ConfirmHost: mutantConfirm } = await bounded('импорт окна мутанта', () => extra!.ssrLoadModule('/src/components/ConfirmHost.tsx'));
            const { useConfirmDialog: mutantConfirmDialog } = await bounded('импорт подтверждения мутанта', () => extra!.ssrLoadModule('/src/confirm.ts'));
            assert.equal(typeof MessagePane, 'function', 'импортирована функция MessagePane-мутанта');
            assert.equal(typeof mutantConfirm, 'function', 'импортирована ConfirmHost из той же Vite-сборки, что и мутант MessagePane');
            // Таймаут — Error, не AssertionError: зависание не выдаётся за пойманную регрессию.
            await assert.rejects(() => bounded('сценарий мутанта', () => check(MessagePane, mutantConfirm, () => mutantConfirmDialog.getState().answer(true), extra)), (error: unknown) => error instanceof assert.AssertionError && (!expectedFailure || error.message.includes(expectedFailure)));
        }
        finally {
            try {
                unmount();
            }
            finally {
                if (extra)
                    await bounded('Vite мутанта.close', () => extra!.close());
            }
        }
    }
    function mutantTest(name: string, scenario: () => Promise<void>) {
        it(name, async () => {
            if (process.env.GUSVOICE_PANE_MUTANT === name)
                return scenario();
            // Тот же сценарий сначала обязан пройти на оригинале; в child грузится ТОЛЬКО мутант.
            await scenario();
            // Генерация ошибки assert в Node 20 может заблокировать event loop; внутренний таймер не спасёт.
            // Каждый мутант получает свежий процесс; внешний watchdog видит и такое зависание.
            const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_PANE_MUTANT: name };
            delete env.NODE_TEST_CONTEXT;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Без --test: node:test работает в этом процессе, без ещё одного дочернего worker.
            const output = await isolatedProcess(['--import', 'tsx', '--test-reporter', 'tap', '--test-name-pattern', `^${escaped}$`, fileURLToPath(entrypoint)], env, name);
            assert.match(output, /# pass 1(?:\r?\n|$)/, 'в child действительно выполнен один сценарий, а не пропущено всё');
        });
    }
    async function isolatedProcess(args: string[], env: NodeJS.ProcessEnv, label: string, ms = 45000) {
        const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        try {
            const code = await bounded(`процесс «${label}»`, () => finished, ms).catch((error: Error) => {
                throw new Error(`${error.message}\n${output}`, { cause: error });
            });
            assert.equal(code, 0, output);
            for (const match of output.matchAll(/MessagePane peak RSS per process KiB: (\d+)/g))
                maxChildRss = Math.max(maxChildRss, Number(match[1]));
            return output;
        }
        finally {
            if (child.exitCode === null)
                child.kill('SIGKILL');
            await bounded('завершение процесса мутанта', () => finished, 5000);
        }
    }
    return {
        get server() { return server; },
        get Pane() { return Pane; },
        get ConfirmHost() { return ConfirmHost; },
        get TextSelLayer() { return TextSelLayer; },
        get textNodes() { return textNodes; },
        get wordSelAt() { return wordSelAt; },
        get allTextSel() { return allTextSel; },
        get root() { return root; },
        set root(value: typeof root) { root = value; },
        get host() { return host; },
        set host(value: typeof host) { host = value; },
        get rendered() { return rendered; },
        get unmount() { return unmount; },
        get resetStore() { return resetStore; },
        set resetStore(value: typeof resetStore) { resetStore = value; },
        get delay() { return delay; },
        get now() { return now; },
        get msg() { return msg; },
        get base() { return base; },
        get paneServer() { return paneServer; },
        get mountTextSelLayer() { return mountTextSelLayer; },
        get textSurface() { return textSurface; },
        get mockTextRangeRects() { return mockTextRangeRects; },
        get textSelMutantTest() { return textSelMutantTest; },
        get mount() { return mount; },
        get mountWithConfirm() { return mountWithConfirm; },
        get rerender() { return rerender; },
        get out() { return out; },
        get mobile() { return mobile; },
        get desktop() { return desktop; },
        get round12() { return round12; },
        get pin() { return pin; },
        get pointerLayout() { return pointerLayout; },
        get touch() { return touch; },
        get queue() { return queue; },
        get flush() { return flush; },
        controlUiClock,
        runUiTimers,
        runUiFrame,
        waitForFocus,
        get rejectMutant() { return rejectMutant; },
        get mutantTest() { return mutantTest; },
        get isolatedProcess() { return isolatedProcess; },
    };
}
