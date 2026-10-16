import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as attach from '../attachRules';
import * as inbox from '../shareInbox';

const source = readFileSync(new URL('./KeyboardContentIncoming.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Options = { bridge?: boolean; view?: 'dm' | 'server'; noFeed?: boolean; raw?: unknown; oversize?: boolean; actualOversize?: boolean; failRead?: boolean; dynamicLimit?: boolean; deferRead?: boolean; deferPeek?: boolean };
type Incoming = { convId: string; files: File[]; text: string };
before(() => { GlobalRegistrator.register({ url: 'https://keyboard.example.test' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; await GlobalRegistrator.unregister(); });
async function fixture(options: Options, work: (f: {
  incoming: Incoming[]; calls: string[]; toasts: string[][]; trigger(): Promise<void>; finishRead(): Promise<void>; finishPeek(): Promise<void>; unmount(): Promise<void>;
}) => Promise<void>, raw = source) {
  const w = window as unknown as { __gvKeyboardContent?: () => void }, previous = w.__gvKeyboardContent;
  delete w.__gvKeyboardContent;
  attach.setDmFileLimit(options.dynamicLimit ? ['bigfile1'] : [], options.dynamicLimit ? attach.ATTACH_MAX_BYTES + 100 : null);
  const incoming: Incoming[] = [], calls: string[] = [], toasts: string[][] = [];
  let finishRead: (() => void) | undefined;
  let finishPeek: (() => void) | undefined;
  const size = options.oversize ? attach.ATTACH_MAX_BYTES + 1 : 3;
  const state = { view: options.view ?? 'dm', currentDmId: options.noFeed && options.view !== 'server' ? null : 'open-dm',
    currentChannelId: options.noFeed && options.view === 'server' ? null : 'open-channel',
    setSharedIn: (value: Incoming) => incoming.push(value) };
  const native = {
    nativeMediaAvailable: () => options.bridge !== false,
    async sharedPeekNative() {
      calls.push('peek');
      if (options.deferPeek) await new Promise<void>(resolve => { finishPeek = resolve; });
      return Object.hasOwn(options, 'raw') ? options.raw : { token: 'keyboard-token', files: [{ name: 'image.gif', mime: 'image/gif', size }] };
    },
    async sharedFilesNative(token: string) {
      calls.push(`read:${token}`); if (options.failRead) throw new Error('keyboard IO failed');
      if (options.deferRead) await new Promise<void>(resolve => { finishRead = resolve; });
      const file = new File(['gif'], 'image.gif', { type: 'image/gif' });
      Object.defineProperty(file, 'size', { value: options.actualOversize ? attach.ATTACH_MAX_BYTES + 1 : size });
      return { files: [file], skipped: [], dropped: 0 };
    },
    async sharedDropNative(token: string) { calls.push(`drop:${token}`); },
  };
  const dependencies: Record<string, unknown> = {
    react: React, '../attachRules': attach, '../shareInbox': inbox, '../nativeMedia': native,
    '../store': { useStore: { getState: () => state } }, '../toast': { toast: (...args: string[]) => toasts.push(args) },
  };
  const module = { exports: {} as typeof import('./KeyboardContentIncoming') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, window, require(id: string) { assert.ok(Object.hasOwn(dependencies, id), `объявленный импорт целого KeyboardContentIncoming: ${id}`); return dependencies[id]; },
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); let mounted = true;
  const unmount = async () => { if (!mounted) return; mounted = false; await React.act(async () => root.unmount()); };
  try {
    await React.act(async () => root.render(React.createElement(module.exports.KeyboardContentIncoming)));
    assert.equal(host.childElementCount, 0, 'вход клавиатуры не открывает собственного окна');
    await work({ incoming, calls, toasts, unmount,
      async finishPeek() { assert.ok(finishPeek, 'ответ peek ещё ожидает физического IO'); await React.act(async () => { finishPeek!(); for (let i = 0; i < 8; i++) await Promise.resolve(); }); },
      async finishRead() { assert.ok(finishRead, 'поток файла ещё ожидает физического IO'); await React.act(async () => { finishRead!(); for (let i = 0; i < 8; i++) await Promise.resolve(); }); },
      async trigger() { assert.ok(w.__gvKeyboardContent, 'мост установил callback клавиатуры'); await React.act(async () => { w.__gvKeyboardContent!(); for (let i = 0; i < 8; i++) await Promise.resolve(); }); },
    });
  } finally {
    await unmount(); host.remove(); attach.setDmFileLimit([], null);
    if (previous) w.__gvKeyboardContent = previous; else delete w.__gvKeyboardContent;
  }
}
it('R218 браузер без медиа-моста не получает callback клавиатуры и не читает входящие файлы', async () => {
  await fixture({ bridge: false }, async f => {
    assert.equal((window as unknown as { __gvKeyboardContent?: unknown }).__gvKeyboardContent, undefined);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.incoming, []);
  });
});
it('R218 размонтирование снимает собственный callback, но не стирает более новый обработчик', async () => {
  const w = window as unknown as { __gvKeyboardContent?: () => void };
  await fixture({}, async f => { assert.equal(typeof w.__gvKeyboardContent, 'function'); await f.unmount(); assert.equal(w.__gvKeyboardContent, undefined); });
  await fixture({}, async f => { const newer = () => {}; w.__gvKeyboardContent = newer; await f.unmount(); assert.equal(w.__gvKeyboardContent, newer); });
});
async function delivered(view: 'dm' | 'server', raw = source) {
  await fixture({ view }, async f => {
    await f.trigger();
    assert.equal(f.incoming[0]?.convId, view === 'dm' ? 'open-dm' : 'open-channel', 'R218-keyboard-feed: клавиатура прикрепляет в открытую ленту, а не оставшуюся соседнюю');
    assert.equal(f.incoming.length, 1); assert.equal(f.incoming[0]!.text, '');
    assert.equal(f.incoming[0]!.files[0]!.name, 'image.gif'); assert.equal(await f.incoming[0]!.files[0]!.text(), 'gif');
    assert.deepEqual(f.calls, ['peek', 'read:keyboard-token', 'drop:keyboard-token']); assert.deepEqual(f.toasts, []);
  }, raw);
}
it('R218 файл клавиатуры попадает в открытую ЛС с сохранёнными байтами и удалённой меткой', () => delivered('dm'));
it('R218 файл клавиатуры попадает в открытый канал, а не в старую открытую ЛС', () => delivered('server'));
it('R218 без открытой ленты приходит подсказка, файл не читается и не прикрепляется, метка удаляется', async () => {
  for (const view of ['dm', 'server'] as const) await fixture({ noFeed: true, view }, async f => {
    await f.trigger(); assert.deepEqual(f.incoming, []); assert.deepEqual(f.calls, ['peek', 'drop:keyboard-token']);
    assert.deepEqual(f.toasts, [['info', 'Откройте беседу, чтобы вставить картинку']]);
  });
});
it('R218 файл сверх предела канала помечается skipped до чтения потока, отказ объясняется', async () => {
  await fixture({ view: 'server', oversize: true }, async f => {
    await f.trigger(); assert.deepEqual(f.incoming, []); assert.deepEqual(f.calls, ['peek', 'drop:keyboard-token']);
    assert.equal(f.toasts[0]?.[0], 'warn'); assert.match(f.toasts[0]?.[1] ?? '', /image\.gif/);
  });
});
it('R218 ЛС использует больший предел объявленного сервера, тот же файл принимается', async () => {
  await fixture({ view: 'dm', oversize: true, dynamicLimit: true }, async f => {
    await f.trigger(); assert.equal(f.incoming.length, 1); assert.equal(f.incoming[0]!.files[0]!.size, attach.ATTACH_MAX_BYTES + 1);
    assert.deepEqual(f.toasts, []); assert.deepEqual(f.calls, ['peek', 'read:keyboard-token', 'drop:keyboard-token']);
  });
});
it('R218 реальный файл сверх предела отвергается и при маленьком размере в нативном manifest', async () => {
  await fixture({ actualOversize: true }, async f => {
    await f.trigger(); assert.deepEqual(f.incoming, []);
    assert.deepEqual(f.calls, ['peek', 'read:keyboard-token', 'drop:keyboard-token']);
    assert.equal(f.toasts[0]?.[0], 'warn'); assert.match(f.toasts[0]?.[1] ?? '', /image\.gif/);
  });
});
async function failure(raw = source) {
  await fixture({ failRead: true }, async f => {
    await f.trigger(); assert.deepEqual(f.incoming, []);
    assert.equal(f.calls.at(-1), 'drop:keyboard-token', 'R218-keyboard-drop: метка стирается и после ошибки чтения');
    assert.deepEqual(f.toasts, [['error', 'Не удалось взять картинку из клавиатуры']]);
  }, raw);
}
it('R218 ошибка чтения не оставляет нативную метку и не создаёт пустого вложения', () => failure());
it('R218 неразобранный пакет с известной меткой тоже удаляется без чтения потока', async () => {
  await fixture({ raw: { token: 'empty-token', files: [] } }, async f => {
    await f.trigger(); assert.deepEqual(f.calls, ['peek', 'drop:empty-token']); assert.deepEqual(f.incoming, []); assert.deepEqual(f.toasts, []);
  });
});
it('R218 размонтирование во время чтения файла не прикрепляет его, но освобождает уже известную метку ровно раз', async () => {
  await fixture({ deferRead: true }, async f => {
    await f.trigger(); assert.deepEqual(f.calls, ['peek', 'read:keyboard-token']);
    await f.unmount(); await f.finishRead();
    assert.deepEqual(f.incoming, []); assert.deepEqual(f.toasts, []);
    assert.deepEqual(f.calls, ['peek', 'read:keyboard-token', 'drop:keyboard-token']);
  });
});
async function latePeek(raw = source) {
  await fixture({ deferPeek: true }, async f => {
    await f.trigger(); assert.deepEqual(f.calls, ['peek']);
    await f.unmount(); await f.finishPeek();
    assert.equal(f.calls.filter(call => call === 'drop:keyboard-token').length, 1, 'R221-late-peek: поздно полученная метка освобождается ровно раз');
    assert.deepEqual(f.calls, ['peek', 'drop:keyboard-token'], 'после снятия не читаются байты файла');
    assert.deepEqual(f.incoming, []); assert.deepEqual(f.toasts, []);
  }, raw);
}
it('R221 поздний peek после размонтирования освобождает файл без вложения и уведомления', () => latePeek());
it('R221 контрфакт проверяет alive раньше метки и возвращает подтверждённую утечку', async () => {
  await latePeek(source);
  const assignment = "token = raw && typeof raw === 'object' ? String((raw as { token?: unknown }).token ?? '') : '';";
  const from = `${assignment}\n        if (!alive) return;`;
  assert.equal(source.split(from).length - 1, 1, 'единственный порядок сохранения метки первого await');
  await assert.rejects(latePeek(source.replace(from, `if (!alive) return;\n        ${assignment}`)), e => e instanceof assert.AssertionError
    && e.message.startsWith('R221-late-peek:') && e.operator === 'strictEqual' && e.actual === 0 && e.expected === 1);
});
for (const [label, from, to, scenario, prefix, actual, expected] of [
  ['перепутаны канал и ЛС', "st.view === 'dm' ? st.currentDmId : st.currentChannelId", "st.view === 'dm' ? st.currentChannelId : st.currentDmId", (raw: string) => delivered('dm', raw), 'R218-keyboard-feed:', 'open-channel', 'open-dm'],
  ['ошибка забывает метку', 'if (token) void sharedDropNative(token);', 'if (false) void sharedDropNative(token);', failure, 'R218-keyboard-drop:', 'read:keyboard-token', 'drop:keyboard-token'],
] as const) it(`R218 контрфакт входа клавиатуры: ${label}`, async () => {
  await scenario(source); assert.equal(source.split(from).length - 1, 1);
  await assert.rejects(scenario(source.replace(from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
