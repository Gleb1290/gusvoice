import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './micActionRules';
import type { MicState } from './micActionRules';

const source = readFileSync(new URL('./nativeMicActions.ts', import.meta.url), 'utf8');
const selfSource = readFileSync(new URL('./voiceSelf.ts', import.meta.url), 'utf8');
const compiled = new Map<string, string>();
function compile(raw: string): string {
  let code = compiled.get(raw);
  if (code === undefined) {
    code = ts.transpileModule(raw, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    compiled.set(raw, code);
  }
  return code;
}

interface Bridge {
  micState?: (json: string) => void;
  micBubbleSet?: (enabled: boolean) => void;
  canDrawOverlays?: () => boolean;
  openOverlaySettings?: () => boolean;
}
interface Audio { pushToTalk: boolean; pttReleaseMs: number; micBubble?: boolean }
interface Voice { channelId: string; channelName: string; selfId?: string | null }
type Live = Record<string, { speaking: boolean }>;
const active: Extract<MicState, { inVoice: true }> = {
  inVoice: true, muted: false, deafened: false, ptt: false, speaking: false, channelName: 'Гостиная 🪿',
  pttReleaseMs: 150,
};
const connected: Voice = { channelId: 'voice', channelName: active.channelName, selfId: 'local-self' };

function setup(options: { android?: boolean; bridge?: Bridge | null; audio?: Partial<Audio>; voice?: Voice | null } = {}, raw = source) {
  let android = options.android ?? true;
  let audio: Audio = { pushToTalk: false, pttReleaseMs: active.pttReleaseMs, ...options.audio };
  const micStates: MicState[] = [];
  const bubbles: boolean[] = [];
  const sounds: [string, string | undefined][] = [];
  const writes: { muted: boolean; deafened: boolean }[] = [];
  const warnings: unknown[][] = [];
  const storeListeners = new Set<() => void>();
  const audioListeners = new Set<(settings: Audio) => void>();
  const counts = { storeSubscribe: 0, audioSubscribe: 0, leave: 0, overlay: 0, reads: 0 };
  const fullBridge: Required<Bridge> = {
    micState: (json) => micStates.push(JSON.parse(json) as MicState),
    micBubbleSet: (enabled) => bubbles.push(enabled),
    canDrawOverlays: () => true,
    openOverlaySettings: () => { counts.overlay++; return true; },
  };
  const win: { GusVoiceNative?: Bridge; __gvMicAction?: (raw: unknown) => void } = {};
  const native = options.bridge === undefined ? fullBridge : options.bridge;
  if (native !== null) win.GusVoiceNative = native;
  const emitStore = () => { for (const fn of storeListeners) fn(); };
  const state = {
    voice: options.voice === undefined ? { ...connected } : options.voice,
    user: { id: 'account-self' } as { id: string } | null,
    selfMuted: false,
    selfDeafened: false,
    liveVoice: {} as Live,
    setSelfVoice: (next: { muted: boolean; deafened: boolean }) => {
      writes.push({ ...next }); state.selfMuted = next.muted; state.selfDeafened = next.deafened; emitStore();
    },
    leaveVoice: () => { counts.leave++; state.voice = null; emitStore(); },
  };
  // Store — закрытый стенд, voiceSelf — настоящий целый модуль. Реальный Zustand/браузер никогда не импортируются.
  const useStore = {
    getState: () => { counts.reads++; return state; },
    subscribe: (fn: () => void) => { counts.storeSubscribe++; storeListeners.add(fn); return () => storeListeners.delete(fn); },
  };
  function load<T>(text: string, deps: Record<string, unknown>): T {
    const module = { exports: {} as T };
    runInNewContext(compile(text), { module, exports: module.exports, window: win,
      console: { warn: (...args: unknown[]) => warnings.push(args) }, require: (id: string) => {
        assert.ok(Object.hasOwn(deps, id), `Неописанный импорт ${id}`);
        return deps[id];
      } });
    return module.exports;
  }
  const voiceSelf = load<typeof import('./voiceSelf')>(selfSource, {
    './store': { useStore }, './sounds': { playSound: (cue: string, channel?: string) => sounds.push([cue, channel]) },
  });
  const api = load<typeof import('./nativeMicActions')>(raw, {
    './audioSettings': {
      getAudioSettings: () => audio,
      subscribeAudioSettings: (fn: (settings: Audio) => void) => {
        counts.audioSubscribe++; audioListeners.add(fn); return () => audioListeners.delete(fn);
      },
    },
    './hotkeys': { isAndroid: () => android },
    './micActionRules': rules,
    './store': { useStore },
    './voiceSelf': voiceSelf,
  });
  return { api, state, win, counts, fullBridge, micStates, bubbles, sounds, writes, warnings, emitStore,
    setAndroid: (next: boolean) => { android = next; },
    setAudio: (next: Partial<Audio>) => { audio = { ...audio, ...next }; for (const fn of audioListeners) fn(audio); },
    act: (action: unknown) => { assert.equal(typeof win.__gvMicAction, 'function'); win.__gvMicAction!(action); },
  };
}

it('R250 первое «вне голоса» не запускает службу, вход отправляется один раз, выход только с inVoice=false', () => {
  const h = setup({ voice: null });
  h.api.pushMicState({ inVoice: false });
  h.api.pushMicState({ inVoice: false });
  assert.deepEqual(h.micStates, []);
  h.api.pushMicState(active);
  h.api.pushMicState({ ...active });
  assert.deepEqual(h.micStates, [active]);
  h.api.pushMicState({ inVoice: false });
  h.api.pushMicState({ inVoice: false });
  assert.deepEqual(h.micStates, [active, { inVoice: false }]);
  h.api.pushMicState(active);
  assert.deepEqual(h.micStates, [active, { inVoice: false }, active], 'после выхода можно снова войти в тот же канал');
});

it('R250 изменение каждого поля состояния доходит до APK, одинаковая копия не отправляется', () => {
  const h = setup();
  const changes: MicState[] = [active, { ...active, muted: true }, { ...active, deafened: true },
    { ...active, ptt: true }, { ...active, speaking: true }, { ...active, channelName: 'Другой канал' },
    { ...active, pttReleaseMs: 0 }, { inVoice: false }];
  for (const state of changes) { h.api.pushMicState(state); h.api.pushMicState({ ...state }); }
  assert.deepEqual(h.micStates, changes);
});

for (const [label, bridge] of [['без моста', null], ['без новых методов', {}]] as const) {
  it(`R250/R251 старый APK ${label}: установка, команды и смена настроек не бросают исключения`, () => {
    const h = setup({ bridge });
    assert.doesNotThrow(() => {
      h.api.installNativeMicActions(); h.api.pushMicState(active);
      h.setAudio({ pushToTalk: true, micBubble: true }); h.emitStore();
      h.api.openOverlaySettings(); h.act('toggle-mute'); h.act('leave');
    });
    assert.equal(h.api.micBubbleSupported(), false);
    assert.equal(h.api.canDrawOverlays(), false);
    assert.equal(h.state.selfMuted, true, 'страница продолжает обрабатывать доступные команды');
    assert.equal(h.counts.leave, 1);
    assert.deepEqual(h.warnings, []);
  });
}

it('R250 установка идемпотентна: один обработчик и ровно по одной подписке на стор и аудио', () => {
  const h = setup();
  h.api.installNativeMicActions();
  const handler = h.win.__gvMicAction;
  h.api.installNativeMicActions(); h.api.installNativeMicActions();
  assert.equal(h.win.__gvMicAction, handler);
  assert.equal(h.counts.storeSubscribe, 1); assert.equal(h.counts.audioSubscribe, 1);
  assert.deepEqual(h.micStates, [active]); assert.deepEqual(h.bubbles, [false]);
  h.act('toggle-mute');
  assert.equal(h.writes.length, 1);
  assert.equal(h.micStates.length, 2);
});

it('R250/R251 вне Android нет установки, подписок, обращений к мосту; поздняя установка Android работает', () => {
  const h = setup({ android: false });
  h.api.installNativeMicActions(); h.api.pushMicState(active); h.api.openOverlaySettings();
  assert.equal(h.win.__gvMicAction, undefined);
  assert.equal(h.counts.storeSubscribe, 0); assert.equal(h.counts.audioSubscribe, 0); assert.equal(h.counts.reads, 0);
  assert.equal(h.api.micBubbleSupported(), false); assert.equal(h.api.canDrawOverlays(), false);
  assert.deepEqual(h.micStates, []); assert.deepEqual(h.bubbles, []); assert.equal(h.counts.overlay, 0);
  h.setAndroid(true); h.api.installNativeMicActions();
  assert.equal(typeof h.win.__gvMicAction, 'function');
  assert.equal(h.counts.storeSubscribe, 1); assert.equal(h.counts.audioSubscribe, 1);
});

function checkPtt(raw = source): void {
  const h = setup({ audio: { pushToTalk: true } }, raw);
  h.api.installNativeMicActions();
  const calls: string[] = [];
  const oldStop = h.api.onMicPtt(() => calls.push('old-down'), () => calls.push('old-up'));
  h.act('ptt-down'); h.act('ptt-up');
  const stop = h.api.onMicPtt(() => calls.push('new-down'), () => calls.push('new-up'));
  oldStop(); oldStop(); // Cleanup старого эффекта может прийти уже после регистрации нового.
  h.act('ptt-down'); h.act('ptt-up');
  assert.deepEqual(calls, ['old-down', 'old-up', 'new-down', 'new-up'], 'старая отписка не снимает новую рацию');
  stop(); stop(); h.act('ptt-down'); h.act('ptt-up');
  assert.deepEqual(calls, ['old-down', 'old-up', 'new-down', 'new-up']);
  assert.deepEqual(h.warnings, []);
}

it('R250 старая отписка рации не удаляет новую регистрацию, своя отписка прекращает оба события', () => checkPtt());

it('R250 нативные мьют и «Не слышу» проходят настоящие переходы voiceSelf, выход вызывает leaveVoice', () => {
  const h = setup(); h.api.installNativeMicActions();
  h.act('toggle-mute');
  assert.deepEqual(h.writes, [{ muted: true, deafened: false }]);
  h.act('toggle-deafen');
  assert.deepEqual(h.writes[1], { muted: true, deafened: true }, 'деафен сохраняет намерение мьюта');
  h.act('toggle-mute');
  assert.deepEqual(h.writes[2], { muted: false, deafened: false }, 'размьют из деафена снимает оба запрета');
  h.act('toggle-deafen'); h.act('toggle-deafen'); h.act('toggle-mute'); h.act('toggle-mute');
  assert.deepEqual(h.sounds, [
    ['mute', 'voice'], ['deafen', 'voice'], ['unmute', 'voice'], ['deafen', 'voice'],
    ['undeafen', 'voice'], ['mute', 'voice'], ['unmute', 'voice'],
  ]);
  h.act('leave');
  assert.equal(h.counts.leave, 1); assert.equal(h.state.voice, null);
  assert.deepEqual(h.micStates.at(-1), { inVoice: false });
  assert.deepEqual(h.warnings, []);
});

it('R250 запоздавшие и неизвестные команды не меняют настройки, а рация работает только в своём режиме', () => {
  const h = setup(); h.api.installNativeMicActions();
  const ptt: string[] = [];
  h.api.onMicPtt(() => ptt.push('down'), () => ptt.push('up'));
  h.act('ptt-down'); h.act('ptt-up'); assert.deepEqual(ptt, []);
  h.setAudio({ pushToTalk: true }); h.act('ptt-down'); h.act('ptt-up'); assert.deepEqual(ptt, ['down', 'up']);
  for (const action of ['unknown', '', 'toggle-mute ', null, undefined, ['leave'], { action: 'leave' }]) h.act(action);
  assert.deepEqual(h.writes, []); assert.equal(h.counts.leave, 0);
  h.state.voice = null; h.emitStore();
  for (const action of ['toggle-mute', 'toggle-deafen', 'leave', 'ptt-down', 'ptt-up']) h.act(action);
  assert.deepEqual(h.writes, []); assert.equal(h.counts.leave, 0); assert.deepEqual(ptt, ['down', 'up']);
  assert.deepEqual(h.warnings, []);
});

it('R250 currentState берёт собственную speaking по voice.selfId, а не по аккаунту и не по чужому участнику', () => {
  const h = setup();
  h.state.liveVoice = { 'local-self': { speaking: false }, 'account-self': { speaking: true }, peer: { speaking: true } };
  h.api.installNativeMicActions(); assert.deepEqual(h.micStates, [active]);
  h.state.liveVoice['local-self'].speaking = true; h.emitStore();
  assert.deepEqual(h.micStates.at(-1), { ...active, speaking: true });
  h.state.liveVoice.peer.speaking = false; h.emitStore(); assert.equal(h.micStates.length, 2);
  h.state.selfMuted = true; h.emitStore();
  assert.deepEqual(h.micStates.at(-1), { ...active, muted: true, speaking: false });
  h.state.selfMuted = false; h.state.selfDeafened = true; h.emitStore();
  assert.deepEqual(h.micStates.at(-1), { ...active, deafened: true, speaking: false });
  assert.deepEqual(h.warnings, []);
});

it('R250 currentState использует user.id без voice.selfId; отсутствие пользователя и записи речи означает тишину', () => {
  const h = setup({ voice: { ...connected, selfId: undefined } });
  h.state.liveVoice = { 'account-self': { speaking: true }, peer: { speaking: true } };
  h.api.installNativeMicActions(); assert.deepEqual(h.micStates, [{ ...active, speaking: true }]);
  h.state.voice!.selfId = null; h.emitStore(); assert.equal(h.micStates.length, 1);
  h.state.user = null; h.emitStore(); assert.deepEqual(h.micStates.at(-1), active);
  h.state.user = { id: 'absent' }; h.emitStore(); assert.equal(h.micStates.length, 2);
  h.state.voice!.channelName = 'Другой канал'; h.emitStore();
  assert.deepEqual(h.micStates.at(-1), { ...active, channelName: 'Другой канал' });
});

it('R250 установка вне голоса молчит, подписка на стор ловит вход и выход, аудиоподписка синхронизирует рацию', () => {
  const h = setup({ voice: null }); h.api.installNativeMicActions();
  assert.deepEqual(h.micStates, []);
  h.emitStore(); h.setAudio({ pushToTalk: true }); assert.deepEqual(h.micStates, []);
  h.state.voice = { ...connected }; h.emitStore();
  assert.deepEqual(h.micStates, [{ ...active, ptt: true }]);
  h.setAudio({ pushToTalk: false }); assert.deepEqual(h.micStates.at(-1), active);
  h.setAudio({ pushToTalk: false }); h.emitStore(); assert.equal(h.micStates.length, 2);
  h.state.voice = null; h.emitStore(); assert.deepEqual(h.micStates.at(-1), { inVoice: false });
});

for (const missing of ['micBubbleSet', 'canDrawOverlays', 'openOverlaySettings'] as const) {
  it(`R251 пузырь не поддерживается при отсутствии именно ${missing}, остальные методы доступны`, () => {
    const h = setup(); h.api.installNativeMicActions();
    assert.equal(h.api.micBubbleSupported(), true);
    const partial: Bridge = { ...h.fullBridge }; delete partial[missing]; h.win.GusVoiceNative = partial;
    assert.equal(h.api.micBubbleSupported(), false);
    h.win.GusVoiceNative = h.fullBridge; assert.equal(h.api.micBubbleSupported(), true);
  });
}

function checkBubble(raw = source): void {
  const h = setup({ voice: null }, raw); h.api.installNativeMicActions();
  assert.deepEqual(h.bubbles, [false], 'начальное выключение пузыря обязательно отправляется');
  h.api.installNativeMicActions(); h.emitStore(); h.setAudio({ pushToTalk: true }); h.setAudio({ micBubble: false });
  assert.deepEqual(h.bubbles, [false], 'повтор выключения пузыря не отправляется');
  h.setAudio({ micBubble: true }); h.setAudio({ micBubble: true }); h.emitStore();
  assert.deepEqual(h.bubbles, [false, true], 'включение отправляется только один раз');
  h.setAudio({ micBubble: false }); h.setAudio({ micBubble: undefined });
  assert.deepEqual(h.bubbles, [false, true, false], 'выключение отправляется через аудиоподписку');
  assert.deepEqual(h.warnings, []);
}

it('R251 пузырь отправляется на старте и через аудиоподписку только при смене значения', () => checkBubble());

it('R251 уже включённый пузырь отправляется при установке сразу, даже вне голоса', () => {
  const h = setup({ voice: null, audio: { micBubble: true } }); h.api.installNativeMicActions();
  assert.deepEqual(h.bubbles, [true]); assert.deepEqual(h.micStates, []);
  h.setAudio({ micBubble: true }); h.emitStore(); assert.deepEqual(h.bubbles, [true]);
});

it('R251 после старого APK появившийся метод получает текущую настройку пузыря', () => {
  // Отсутствие метода не считается доставкой: кэшировать состояние до вызова моста здесь нельзя.
  const h = setup({ bridge: {} }); h.api.installNativeMicActions(); h.setAudio({ micBubble: true });
  h.win.GusVoiceNative = h.fullBridge; h.setAudio({ micBubble: true });
  assert.deepEqual(h.bubbles, [true]); assert.deepEqual(h.warnings, []);
});

it('R251 проверка разрешения принимает только true, настройки открываются единственным вызовом моста', () => {
  const h = setup(); assert.equal(h.api.canDrawOverlays(), true);
  h.api.openOverlaySettings(); assert.equal(h.counts.overlay, 1);
  for (const value of [false, undefined, null, 1, 'true']) {
    h.win.GusVoiceNative = { canDrawOverlays: () => value as boolean };
    assert.equal(h.api.canDrawOverlays(), false);
  }
  h.win.GusVoiceNative = { canDrawOverlays: () => { throw new Error('bridge unavailable'); } };
  assert.equal(h.api.canDrawOverlays(), false);
});

it('R250/R251 исключения настоящих методов моста перехватываются и не ломают следующие действия', () => {
  const h = setup({ bridge: {
    micState: () => { throw new Error('mic bridge'); },
    micBubbleSet: () => { throw new Error('bubble bridge'); },
    canDrawOverlays: () => { throw new Error('permission bridge'); },
    openOverlaySettings: () => { throw new Error('settings bridge'); },
  } });
  assert.doesNotThrow(() => {
    h.api.installNativeMicActions(); h.api.openOverlaySettings();
    h.act('toggle-mute'); h.setAudio({ micBubble: true }); h.act('leave');
  });
  assert.equal(h.api.canDrawOverlays(), false);
  assert.equal(h.counts.leave, 1); assert.equal(h.state.selfMuted, true);
  assert.equal(h.warnings.length, 6);
  assert.deepEqual(h.warnings.map((row) => row[0]), [
    '[native-mic] micState failed:', '[native-mic] micBubbleSet failed:', '[native-mic] openOverlaySettings failed:',
    '[native-mic] micState failed:', '[native-mic] micBubbleSet failed:', '[native-mic] micState failed:',
  ]);
});

function mutate(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'точка мутации единственная');
  return source.replace(from, to);
}

it('R250 контрфакт без проверки владельца отписки теряет новую регистрацию и отвергается', () => {
  checkPtt();
  const mutant = mutate('if (ptt === mine) ptt = null;', 'ptt = null;');
  assert.throws(() => checkPtt(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('старая отписка не снимает новую рацию'));
});

it('R251 контрфакт без дедупликации пузыря ловится через реальную подписку настроек', () => {
  checkBubble();
  const mutant = mutate('if (lastBubble === enabled) return;', '');
  assert.throws(() => checkBubble(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('повтор выключения пузыря не отправляется'));
});

it('R251 контрфакт без отправки пузыря на старте не прячется за будущим изменением настроек', () => {
  checkBubble();
  const mutant = mutate('  pushMicBubble(getAudioSettings().micBubble === true);', '');
  assert.throws(() => checkBubble(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith('начальное выключение пузыря обязательно отправляется'));
});

function checkInitialRelease(raw = source): void {
  for (const pushToTalk of [false, true]) {
    const h = setup({ audio: { pushToTalk, pttReleaseMs: 273.6 } }, raw);
    h.api.installNativeMicActions();
    assert.deepEqual(h.micStates, [{ ...active, ptt: pushToTalk, pttReleaseMs: 274 }],
      'R252 начальная задержка берётся из аудионастроек');
    assert.deepEqual(h.warnings, []);
  }
}

// Класс ошибки: натив получает константу/NaN вместо сохранённой задержки, в том числе до включения режима рации.
it('R252 начальная задержка из аудионастроек доходит до APK округлённой при обоих режимах микрофона', () => checkInitialRelease());

function checkReleaseSync(raw = source): void {
  const h = setup({ audio: { pushToTalk: true } }, raw);
  h.api.installNativeMicActions();
  const initial = { ...active, ptt: true };
  assert.deepEqual(h.micStates, [initial]);
  h.setAudio({ pttReleaseMs: 240 });
  const changed = { ...initial, pttReleaseMs: 240 };
  assert.deepEqual(h.micStates, [initial, changed], 'R252 смена только задержки отправляется через аудиоподписку');
  h.setAudio({ pttReleaseMs: 240 }); h.setAudio({ pttReleaseMs: 240.49 }); h.emitStore();
  assert.deepEqual(h.micStates, [initial, changed], 'равная нормализованная задержка не создаёт повтор');
  h.setAudio({ pttReleaseMs: 0 });
  const immediate = { ...initial, pttReleaseMs: 0 };
  assert.deepEqual(h.micStates, [initial, changed, immediate], 'нулевая задержка заменяет прежний хвост');
  h.setAudio({ pttReleaseMs: -30 }); h.setAudio({ pttReleaseMs: Number.NaN });
  assert.deepEqual(h.micStates, [initial, changed, immediate], 'отрицательное и NaN отправляются как ноль без повтора');
  assert.deepEqual(h.warnings, []);
}

// Класс ошибки: настройка изменилась в открытом голосе, а пузырь продолжает закрывать микрофон с прежней задержкой.
it('R252 смена только задержки синхронизируется сразу, а равное округлённое значение не отправляется повторно', () => checkReleaseSync());

// Класс ошибки: смена задержки вне голоса поднимает службу или оставляет старый хвост при следующем входе.
it('R252 задержка вне голоса не отправляет лишних полей, а следующий вход получает последнее значение', () => {
  const h = setup({ voice: null }); h.api.installNativeMicActions();
  h.setAudio({ pttReleaseMs: 360.6 }); assert.deepEqual(h.micStates, []);
  h.state.voice = { ...connected }; h.emitStore();
  const entered = { ...active, pttReleaseMs: 361 };
  assert.deepEqual(h.micStates, [entered]);
  h.state.voice = null; h.emitStore(); h.setAudio({ pttReleaseMs: 0 });
  assert.deepEqual(h.micStates, [entered, { inVoice: false }]);
  h.state.voice = { ...connected }; h.emitStore();
  assert.deepEqual(h.micStates, [entered, { inVoice: false }, { ...active, pttReleaseMs: 0 }]);
});

// Класс ошибки: хардкод задержки в currentState должен обнаруживаться поведением настоящего модуля моста.
it('R252 контрфакт постоянной задержки вместо текущих настроек обнаруживается на старте', () => {
  checkInitialRelease();
  const mutant = mutate('pttReleaseMs: getAudioSettings().pttReleaseMs,', 'pttReleaseMs: 150,');
  assert.throws(() => checkInitialRelease(mutant), error =>
    error instanceof assert.AssertionError && error.message.startsWith('R252 начальная задержка берётся из аудионастроек'));
});

// Класс ошибки: потеря sync в аудиоподписке должна краснить смену задержки, даже если начальная отправка прошла.
it('R252 контрфакт без синхронизации аудио обнаруживается при смене одной задержки', () => {
  checkReleaseSync();
  const mutant = mutate('    sync();', '');
  assert.throws(() => checkReleaseSync(mutant), error =>
    error instanceof assert.AssertionError && error.message.startsWith('R252 смена только задержки отправляется через аудиоподписку'));
});
