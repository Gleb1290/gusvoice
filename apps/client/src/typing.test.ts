import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { TYPING_ACTIONS, typingActionRank, type TypingAction } from '@gusvoice/shared';

it('голос переходит в отправку сразу, слабые сигналы её не продлевают, срок ровно шесть секунд', () => {
  // Равный ранг должен менять подпись, а устаревший TTL не должен создавать мигание.
  const source = readFileSync(new URL('./typing.ts', import.meta.url), 'utf8');
  let now = 0;
  const load = (text: string) => {
    const module = { exports: {} };
    class FakeDate extends Date { static now() { return now; } }
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, Date: FakeDate, setInterval: () => 1, clearInterval: () => {}, require: () => ({ useSyncExternalStore: (_: unknown, get: () => unknown) => get() }) });
    return module.exports as { noteTyping: (c: string, u: string, a: TypingAction) => void; useTypingAction: (c: string, u: string) => TypingAction; typingActionLabel: (a: TypingAction) => string; TYPING_SEND_MS: number };
  };
  const check = (api: ReturnType<typeof load>) => {
    now = 0; api.noteTyping('c', 'u', 'voice'); api.noteTyping('c', 'u', 'voice_upload');
    assert.equal(api.useTypingAction('c', 'u'), 'voice_upload');
    assert.equal(api.typingActionLabel('voice_upload'), 'отправляет голосовое');
    now = 5900; api.noteTyping('c', 'u', 'file'); api.noteTyping('c', 'u', 'typing');
    assert.equal(api.useTypingAction('c', 'u'), 'voice_upload');
    now = 6100; assert.equal(api.useTypingAction('c', 'u'), 'typing');
    assert.equal(api.TYPING_SEND_MS, 4000);
    for (const a of TYPING_ACTIONS) for (const b of TYPING_ACTIONS) {
      const key = `${a}:${b}`;
      api.noteTyping(key, 'pair', a); api.noteTyping(key, 'pair', b);
      assert.equal(api.useTypingAction(key, 'pair'), typingActionRank(b) >= typingActionRank(a) ? b : a, `паритет рангов shared/client: ${key}`);
    }
  };
  check(load(source));
  for (const [a, b] of [['TTL_MS = 6000', 'TTL_MS = 5000'], ['TYPING_SEND_MS = 4000', 'TYPING_SEND_MS = 2500'], ['voice_upload: 3', 'voice_upload: 2']] as const) {
    assert.ok(source.includes(a)); assert.throws(() => check(load(source.replace(a, b))), assert.AssertionError);
  }
});

it('сообщение гасит печать только своего автора, а gateway вызывает dropTyping в обоих живых путях', () => {
  // После отправки «печатает…» должно исчезнуть сразу у этого автора, но не у второго участника той же беседы.
  const source = readFileSync(new URL('./typing.ts', import.meta.url), 'utf8');
  let now = 100_000;
  const load = (text: string) => {
    const module = { exports: {} as Record<string, unknown> };
    class FakeDate extends Date { static now() { return now; } }
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module,
      exports: module.exports,
      require(id: string) { assert.equal(id, 'react', 'ожидаем только React useSyncExternalStore'); return { useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }; },
      setInterval: () => 1,
      clearInterval: () => {},
      Date: FakeDate,
    });
    return module.exports as {
      noteTyping: (key: string, user: string, action?: TypingAction) => void;
      dropTyping: (key: string, user: string) => void;
      useTyping: (key: string) => string[];
      useTypingAction: (key: string, user: string) => TypingAction;
      typingActionLabel: (action: TypingAction) => string;
    };
  };
  const typing = load(source);
  typing.noteTyping('c', 'alice'); typing.noteTyping('c', 'bob');
  typing.dropTyping('c', 'alice');
  assert.deepEqual(Array.from(typing.useTyping('c')), ['bob'], 'сообщение alice не сбрасывает bob');
  typing.dropTyping('c', 'missing');
  assert.deepEqual(Array.from(typing.useTyping('c')), ['bob'], 'неизвестный автор не меняет список');
  typing.dropTyping('c', 'bob');
  assert.deepEqual(Array.from(typing.useTyping('c')), [], 'после сообщения автора печать погашена');

  const mutantSource = source.replace('if (!m || !m.delete(userId)) return;', 'if (!m) return;');
  assert.notEqual(mutantSource, source, 'реальный модуль удаляет userId из typing map');
  const mutant = load(mutantSource);
  mutant.noteTyping('c', 'alice');
  mutant.dropTyping('c', 'alice');
  assert.throws(() => assert.deepEqual(Array.from(mutant.useTyping('c')), [], 'после сообщения автора печать погашена'), assert.AssertionError,
    'мутант без удаления автора должен провалить контракт dropTyping');

  const sockets = readFileSync(fileURLToPath(new URL('./sockets.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const message = /case 'message\.create':\s*\{[\s\S]*?dropTyping\(msg\.channelId, msg\.message\.author\.id\)/;
  const conv = /case 'conv\.change':\s*\{[\s\S]*?if \(msg\.created && m\) dropTyping\(convId, m\.author\.id\)/;
  assert.match(sockets, message, 'канал сбрасывает печать автора сообщения');
  assert.match(sockets, conv, 'новая беседа сбрасывает печать только при created с живым сообщением');
});

it('сильный typing action не продлевается слабым, равный и более сильный обновляют его', () => {
  // Запись голоса должна пережить частые обычные события, но не получить от них новую пятисекундную жизнь.
  const source = readFileSync(new URL('./typing.ts', import.meta.url), 'utf8');
  let now = 200_000;
  const load = (text: string) => {
    const module = { exports: {} as Record<string, unknown> };
    class FakeDate extends Date { static now() { return now; } }
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports,
      require(id: string) { assert.equal(id, 'react', 'typing state имеет только React hook dependency'); return { useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }; },
      setInterval: () => 1, clearInterval: () => {}, Date: FakeDate,
    });
    return module.exports as {
      noteTyping: (key: string, user: string, action?: TypingAction) => void;
      dropTyping: (key: string, user: string) => void;
      useTypingAction: (key: string, user: string) => TypingAction;
      typingActionLabel: (action: TypingAction) => string;
    };
  };
  const state = load(source);
  state.noteTyping('room', 'alice', 'voice');
  now += 2_500;
  state.noteTyping('room', 'alice', 'typing');
  assert.equal(state.useTypingAction('room', 'alice'), 'voice', 'слабый сигнал не вытесняет запись');
  now += 3_501;
  assert.equal(state.useTypingAction('room', 'alice'), 'typing', 'слабый сигнал не продлевает срок записи');
  state.noteTyping('room', 'alice', 'file');
  state.noteTyping('room', 'alice', 'photo');
  assert.equal(state.useTypingAction('room', 'alice'), 'photo', 'равный ранг обновляет вид загрузки');
  state.noteTyping('room', 'alice', 'voice');
  assert.equal(state.useTypingAction('room', 'alice'), 'voice', 'более сильный сигнал заменяет загрузку');
  state.dropTyping('room', 'alice');
  assert.equal(state.useTypingAction('room', 'alice'), 'typing', 'удалённый автор возвращается к обычному состоянию');
  for (const [action, label] of Object.entries({ typing: 'печатает', sticker: 'выбирает стикер', voice: 'записывает голосовое', photo: 'отправляет фото', video: 'отправляет видео', file: 'отправляет файл' })) {
    assert.equal(state.typingActionLabel(action as TypingAction), label, `подпись для ${action}`);
  }
  assert.ok(typingActionRank('voice') > typingActionRank('file'), 'shared contract voice rank is higher than upload');
});

it('реальный typing store ловит мутации приоритета, равного ранга и сохранения action', () => {
  // Удаление любого из этих условий даёт мигающую/ложную подпись при одновременной печати и загрузке.
  const source = readFileSync(new URL('./typing.ts', import.meta.url), 'utf8');
  const load = (text: string) => {
    const module = { exports: {} as Record<string, unknown> };
    let now = 300_000;
    class FakeDate extends Date { static now() { return now; } }
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports,
      require: () => ({ useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }),
      setInterval: () => 1, clearInterval: () => {}, Date: FakeDate,
    });
    return module.exports as { noteTyping: (key: string, user: string, action?: TypingAction) => void; useTypingAction: (key: string, user: string) => TypingAction };
  };
  const expectFailure = (mutant: string, arrange: (s: ReturnType<typeof load>) => void, expected: TypingAction, message: string) => {
    assert.notEqual(mutant, source, `${message}: mutation must apply`);
    const s = load(mutant);
    arrange(s);
    assert.throws(() => assert.equal(s.useTypingAction('r', 'u'), expected, message), assert.AssertionError, message);
  };
  expectFailure(source.replace('RANK[next] < RANK[cur.action]', 'false'), (s) => { s.noteTyping('r', 'u', 'voice'); s.noteTyping('r', 'u', 'typing'); }, 'voice', 'слабый набор вытеснил бы голос');
  expectFailure(source.replace('RANK[next] < RANK[cur.action]', 'RANK[next] <= RANK[cur.action]'), (s) => { s.noteTyping('r', 'u', 'file'); s.noteTyping('r', 'u', 'photo'); }, 'photo', 'равная загрузка должна обновлять подпись');
  expectFailure(source.replace("m.set(userId, { exp: now + TTL_MS, action: next });", "m.set(userId, { exp: now + TTL_MS, action: 'typing' });"), (s) => s.noteTyping('r', 'u', 'video'), 'video', 'сохранённый сигнал должен сохранять action');
});

it('gateway и composer связывают типы typing и пропускают legacy-сигнал без поля', () => {
  // Wire guards дополняют чистый state test: иначе оба конца могут независимо выглядеть правильно, но не говорить друг с другом.
  const sockets = readFileSync(fileURLToPath(new URL('./sockets.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  assert.match(sockets, /case 'typing':\s*if \(msg\.userId && msg\.userId !== store\.user\?\.id\) noteTyping\(msg\.channelId \?\? msg\.dmId \?\? '', msg\.userId, parseTypingAction\(msg\.action\)\)/, 'socket parser forwards validated action and defaults unknown values');
  assert.match(sockets, /const msg: GatewayClientMessage = \{ t: 'typing', \.\.\.target, \.\.\.typingActionField\(action\) \}/, 'outbound legacy typing omits optional field');
  const pane = readFileSync(fileURLToPath(new URL('./components/MessagePane.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  assert.match(pane, /lastTypingSent = useRef<Partial<Record<TypingAction, number>>>\(\{\}\)/, 'throttle is kept separately for each action');
  assert.match(pane, /signalActionRef\.current\('voice'\)/, 'recording sends voice action');
  assert.match(pane, /uploadTypingAction\(o\.files\.map\(\(f\) => f\.type\)\)/, 'uploads choose action from MIME set');
  assert.match(pane, /signalAction\('typing'\)/, 'ordinary composer input remains the legacy typing action');
});
