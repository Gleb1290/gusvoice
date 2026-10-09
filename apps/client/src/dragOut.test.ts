import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './dragOut';

it('перетаскивание принимает непустую беседу и от 1 до 100 id, мусор и 101-й id не просачиваются', () => {
  assert.equal(rules.parseMsgDrag('not json'), null); assert.equal(rules.parseMsgDrag('[]'), null);
  assert.equal(rules.parseMsgDrag(JSON.stringify({ conv: '', ids: ['x'] })), null);
  assert.equal(rules.parseMsgDrag(JSON.stringify({ conv: 'c', ids: [] })), null);
  assert.equal(rules.parseMsgDrag(JSON.stringify({ conv: 'c', ids: [1] })), null);
  const valid = { conv: 'c', ids: Array.from({ length: 100 }, (_, i) => `m${i}`) };
  assert.equal(rules.parseMsgDrag(JSON.stringify(valid))?.ids.length, 100);
  assert.equal(rules.parseMsgDrag(JSON.stringify({ conv: 'c', ids: [...valid.ids, 'm100'] })), null);
  const mutant = mutantApi('ids.length > DRAG_MSG_MAX', 'false');
  assert.throws(() => assert.equal(mutant.parseMsgDrag(JSON.stringify({ conv: 'c', ids: [...valid.ids, 'm100'] })), null), assert.AssertionError,
    'мутант принимает невозможную пачку из 101 сообщения');
});

function mutantApi(from: string, to: string, injected: Record<string, unknown> = {}): typeof rules {
  const source = readFileSync(new URL('./dragOut.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URL, ...injected });
  return module.exports as typeof rules;
}

it('выбранные перетаскиваются в порядке ленты, но невыбранная строка не становится выбором', () => {
  assert.deepEqual(rules.dragIds('b', ['c', 'a', 'b'], ['a', 'b', 'c'], true), ['a', 'b', 'c']);
  assert.equal(rules.dragIds('x', ['a'], ['a', 'x'], true), null);
  assert.deepEqual(rules.dragIds('x', [], [], false), ['x']);
  assert.equal(rules.grabsMessage({ text: false, link: false, image: false, own: false }), true);
  for (const patch of [{ text: true }, { link: true }, { image: true }, { own: true }])
    assert.equal(rules.grabsMessage({ text: false, link: false, image: false, own: false, ...patch }), false);
});

it('DownloadURL чистит разделители имени, принимает только абсолютный http(s) после base и ставит безопасный MIME', () => {
  assert.equal(rules.downloadUrlValue('broken', 'a:/b\nc', '/f', 'https://gusvoice.test/base'), 'application/octet-stream:a_b_c:https://gusvoice.test/f');
  assert.equal(rules.downloadUrlValue('image/png', 'photo.png', 'https://cdn.test/a', 'https://gusvoice.test'), 'image/png:photo.png:https://cdn.test/a');
  assert.equal(rules.downloadUrlValue('image/png', 'x', 'javascript:alert(1)', 'https://gusvoice.test'), null);
  assert.equal(rules.downloadUrlValue('image/png', 'x', 'data:text/plain,a', 'https://gusvoice.test'), null);
  const mutant = mutantApi("abs.protocol !== 'http:' && abs.protocol !== 'https:'", "false");
  assert.throws(() => assert.equal(mutant.downloadUrlValue('text/plain', 'x', 'javascript:alert(1)', 'https://host.test'), null), assert.AssertionError,
    'мутант выставляет javascript: в DataTransfer');
});

it('бросок на строку беседы доставляет ровно свой payload и отписывается при размонтировании', () => {
  // Потерянное событие делает drop бесшумным, а забытый unsubscribe держит закрытую ленту в памяти.
  const listeners = new Map<string, Set<(event: { type: string; detail: unknown }) => void>>();
  const fakeWindow = {
    addEventListener(type: string, listener: (event: { type: string; detail: unknown }) => void) {
      let set = listeners.get(type); if (!set) listeners.set(type, set = new Set()); set.add(listener);
    },
    removeEventListener(type: string, listener: (event: { type: string; detail: unknown }) => void) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event: { type: string; detail: unknown }) { for (const listener of listeners.get(event.type) ?? []) listener(event); return true; },
  };
  class FakeCustomEvent {
    constructor(readonly type: string, readonly init: { detail: unknown }) {}
    get detail() { return this.init.detail; }
  }
  const check = (api: typeof rules) => {
    const got: unknown[][] = [];
    const off = api.onForwardDrop((payload, to) => got.push([payload, to]));
    api.requestForwardDrop({ conv: 'source', ids: ['m1', 'm2'] }, 'target');
    assert.deepEqual(got, [[{ conv: 'source', ids: ['m1', 'm2'] }, 'target']]);
    off();
    api.requestForwardDrop({ conv: 'source', ids: ['m3'] }, 'target');
    assert.equal(got.length, 1);
  };
  const injected = { window: fakeWindow, CustomEvent: FakeCustomEvent };
  check(mutantApi('const FORWARD_DROP =', 'const FORWARD_DROP =', injected));
  assert.throws(() => check(mutantApi('if (d?.payload) fn(d.payload, d.to);', 'if (false) fn(d.payload, d.to);', injected)), assert.AssertionError,
    'мутант глотает drop-событие и не открывает пересылку');
});

it('лента открывает пересылку только если все перетаскиваемые id есть в её сообщениях', () => {
  // Смешанный payload не должен частично переслать свои строки и пропустить посторонний id.
  const source = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('onForwardDrop((p, to) => {');
  const end = source.indexOf('\n      }),', start);
  assert.ok(start >= 0 && end > start, 'найден действующий обработчик drop из MessagePane');
  const bodyStart = start + 'onForwardDrop((p, to) => {'.length;
  const body = source.slice(bodyStart, end);
  const helperStart = source.indexOf('function startFwdDraft(');
  const helperEnd = source.indexOf('\n  /** Поставить сообщение в очередь отправки;', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'найдена реальная функция создания черновика пересылки');
  const helper = source.slice(helperStart, helperEnd);
  const check = (callbackBody: string) => {
    const opened: string[] = [];
    const drafts: { to: string; value: { from: string; messages: { id: string }[]; hideSender: boolean; hideCaptions: boolean } }[] = [];
    const picked: unknown[] = [];
    const module = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(`${helper}\nmodule.exports = (p, to) => {${callbackBody}};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const batch = { open: (to: string) => opened.push(to) };
    const messages = [{ id: 'own-1' }, { id: 'own-2' }];
    const noPicks: unknown[] = [];
    runInNewContext(code, { module, exports: module.exports, batchOn: batch, feedId: 'source', messages,
      NO_PICKS: noPicks, setPicked: (value: unknown) => picked.push(value),
      useStore: { getState: () => ({ setFwdDraft: (to: string, value: (typeof drafts)[number]['value']) => drafts.push({ to, value }) }) },
      requestAnimationFrame: (fn: () => void) => { fn(); return 0; } });
    const handler = module.exports as unknown as (p: { ids: string[] }, to: string) => void;
    handler({ ids: ['own-1', 'foreign'] }, 'target');
    assert.equal(opened.length, 0, 'чужой id не открывает даже частичный черновик');
    assert.equal(drafts.length, 0, 'чужой id не записывает пересылку в стор');
    handler({ ids: ['own-1', 'own-2'] }, 'target');
    assert.deepEqual(opened, ['target']);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].to, 'target');
    assert.equal(drafts[0].value.from, 'source');
    assert.equal(drafts[0].value.messages.map((message) => message.id).join(','), 'own-1,own-2');
    assert.equal(drafts[0].value.hideSender, false);
    assert.equal(drafts[0].value.hideCaptions, false);
    assert.equal(picked.length, 1);
  };
  check(body);
  const guard = 'if (!batchOn || !p.ids.every((id) => messages.some((x) => x.id === id))) return;';
  assert.ok(body.includes(guard), 'проверка batch и принадлежности id найдена');
  assert.throws(() => check(body.replace(guard, '')), assert.AssertionError,
    'мутант открывает пересылку на id из чужой беседы');
});
