import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Api = typeof import('./nativeCallAudio');

type Mutation = 'dedupe' | 'unknown-kind' | 'route' | 'wired-sheet' | 'no-sheet' | 'leaked-callback' | 'comm-order' | 'comm-loose' | 'comm-unguarded';

function fixture(options: {
  android?: boolean;
  methods?: Partial<Record<'start' | 'stop' | 'select' | 'state' | 'comm', boolean>>;
  throws?: boolean;
  commPref?: string | null;
  storage?: 'absent' | 'throws';
  mutation?: Mutation;
} = {}) {
  const calls: string[] = [];
  const bridge: Record<string, (...args: unknown[]) => unknown> = {};
  if (options.methods?.start !== false) bridge.callAudioStart = (video) => { calls.push(`start:${video}`); if (options.throws) throw Error('Java bridge failure'); };
  if (options.methods?.stop !== false) bridge.callAudioStop = () => { calls.push('stop'); if (options.throws) throw Error('Java bridge failure'); };
  if (options.methods?.select !== false) bridge.callAudioSelect = (kind) => { calls.push(`select:${kind}`); if (options.throws) throw Error('Java bridge failure'); };
  if (options.methods?.state !== false) bridge.callAudioState = () => { calls.push('state'); if (options.throws) throw Error('Java bridge failure'); return '{"route":"speaker","devices":[{"kind":"speaker"},{"kind":"earpiece"}]}'; };
  if (options.methods?.comm) bridge.callAudioSetCommMode = (on) => { calls.push(`comm:${on}`); if (options.throws) throw Error('Java bridge failure'); };
  const nativeWindow: Record<string, unknown> = { GusVoiceNative: bridge };
  let source = readFileSync(new URL('./nativeCallAudio.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (options.mutation) {
    const targets: Record<Mutation, [string, string]> = {
      dedupe: ['if (!d || !isKind(d.kind) || devices.some((x) => x.kind === d.kind)) continue;', 'if (!d || !isKind(d.kind)) continue;'],
      'unknown-kind': ['if (!d || !isKind(d.kind) || devices.some((x) => x.kind === d.kind)) continue;', 'if (!d || (typeof d.kind !== \'string\') || devices.some((x) => x.kind === d.kind)) continue;'],
      route: ['if (!isKind(o.route) || !Array.isArray(o.devices)) return null;', 'if (!Array.isArray(o.devices)) return null;'],
      'wired-sheet': ["if (has('bluetooth') && has('earpiece')) return { sheet: true };", "if (has('bluetooth') && (has('earpiece') || has('wired'))) return { sheet: true };"],
      'no-sheet': ["if (has('bluetooth') && has('earpiece')) return { sheet: true };", "if (has('bluetooth') && has('earpiece')) return null;"],
      'leaked-callback': ['if (listeners.size === 0) delete w.__gvCallAudioChanged;', 'if (listeners.size < 0) delete w.__gvCallAudioChanged;'],
      'comm-order': ["if (b && typeof b.callAudioSetCommMode === 'function') b.callAudioSetCommMode(commModeWanted());\n    b?.callAudioStart(video);",
        "b?.callAudioStart(video);\n    if (b && typeof b.callAudioSetCommMode === 'function') b.callAudioSetCommMode(commModeWanted());"],
      'comm-loose': ["localStorage.getItem('gv.callAudio.commMode') === '1'", "localStorage.getItem('gv.callAudio.commMode') !== '0'"],
      'comm-unguarded': ["if (b && typeof b.callAudioSetCommMode === 'function')", 'if (b)'],
    };
    const [before, after] = targets[options.mutation];
    assert.equal(source.split(before).length - 1, 1, `единственный якорь ${options.mutation}`);
    source = source.replace(before, after);
  }
  const compiled = (text: string) => ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const appModule = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled(source), {
    module: appModule, exports: appModule.exports,
    require(id: string) { assert.equal(id, './hotkeys'); return { isAndroid: () => options.android !== false }; },
    window: nativeWindow, navigator: { userAgent: options.android === false ? 'Mozilla/5.0 (Windows NT 10.0)' : 'Mozilla/5.0 (Linux; Android 15)' },
    console: { warn() {} },
    ...(options.storage === 'absent' ? {} : { localStorage: { getItem(key: string) {
      assert.equal(key, 'gv.callAudio.commMode'); if (options.storage === 'throws') throw Error('storage blocked'); return options.commPref ?? null;
    } } }),
  });
  return { api: appModule.exports as unknown as Api, calls, window: nativeWindow };
}

function json(value: unknown): string { return JSON.stringify(value); }

function assertMutantKilled(actual: unknown, expected: unknown, message: string) {
  assert.throws(() => assert.equal(actual, expected, message), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(message) && error.operator === 'strictEqual'
    && Object.is(error.actual, actual) && Object.is(error.expected, expected), 'адресный host AssertionError с известными actual/expected');
}

describe('nativeCallAudio: проверка состояния и управление выводом Android', () => {
  it('валидный ответ сохраняет порядок устройств и имя только как непустую строку', () => {
    const { api } = fixture();
    assert.equal(json(api.parseCallAudioState('{"route":"speaker","devices":[{"kind":"bluetooth","name":"Наушники"},{"kind":"earpiece","name":""},{"kind":"wired","name":7}]}')),
      '{"route":"speaker","devices":[{"kind":"bluetooth","name":"Наушники"},{"kind":"earpiece"},{"kind":"wired"}]}');
  });

  it('пустой ответ, битый JSON, неизвестный маршрут и неверный список устройств отклоняются, а обычный ответ принимается', () => {
    // Мост может вернуть пустую строку на старом APK или частично несовместимый ответ; ошибка разбора не должна прятать рабочий маршрут.
    const { api } = fixture();
    for (const input of ['', '{', '{"route":"car","devices":[]}', '{"route":"speaker","devices":{}}']) {
      assert.equal(api.parseCallAudioState(input), null, `invalid native state must be rejected: ${input}`);
    }
    assert.notEqual(api.parseCallAudioState('{"route":"speaker","devices":[{"kind":"speaker"}]}'), null,
      'a valid state must remain accepted alongside malformed states');
  });

  it('неизвестный вид и повтор устройства отбрасываются; оба соответствующих мутанта ловятся', () => {
    const input = '{"route":"speaker","devices":[{"kind":"speaker"},{"kind":"speaker","name":"duplicate"},{"kind":"car"},{"kind":"earpiece"}]}';
    const expected = '{"route":"speaker","devices":[{"kind":"speaker"},{"kind":"earpiece"}]}';
    const { api } = fixture();
    assert.equal(json(api.parseCallAudioState(input)), expected);
    const duplicateMutant = fixture({ mutation: 'dedupe' }).api.parseCallAudioState(input);
    assertMutantKilled(json(duplicateMutant), expected, 'duplicate kinds are removed');
    const kindMutant = fixture({ mutation: 'unknown-kind' }).api.parseCallAudioState(input);
    assertMutantKilled(json(kindMutant), expected, 'unknown kinds are removed');
  });

  it('неизвестный route отклоняется — иначе UI может показать действие для несуществующего маршрута', () => {
    const input = '{"route":"car","devices":[]}';
    assert.equal(fixture().api.parseCallAudioState(input), null);
    const mutantValue = fixture({ mutation: 'route' }).api.parseCallAudioState(input);
    assertMutantKilled(json(mutantValue), 'null', 'unknown route is rejected');
  });

  it('переключатель выбирает динамик или доступную альтернативу для каждого набора устройств', () => {
    const { api } = fixture();
    const cases: Array<[Parameters<Api['speakerPress']>[0], unknown]> = [
      [{ route: 'earpiece', devices: [{ kind: 'earpiece' }, { kind: 'speaker' }] }, { to: 'speaker' }],
      [{ route: 'speaker', devices: [{ kind: 'earpiece' }, { kind: 'speaker' }] }, { to: 'earpiece' }],
      [{ route: 'speaker', devices: [{ kind: 'speaker' }, { kind: 'wired' }] }, { to: 'wired' }],
      [{ route: 'earpiece', devices: [{ kind: 'speaker' }, { kind: 'bluetooth' }] }, { to: 'speaker' }],
      [{ route: 'speaker', devices: [{ kind: 'speaker' }, { kind: 'bluetooth' }] }, { to: 'bluetooth' }],
    ];
    for (const [state, expected] of cases) assert.equal(json(api.speakerPress(state)), json(expected));
    assert.equal(api.speakerPress({ route: 'speaker', devices: [{ kind: 'speaker' }] }), null,
      'one available route cannot be toggled and therefore has no speaker action');
  });

  it('Bluetooth вместе с разговорным динамиком открывает лист при любом текущем маршруте', () => {
    const { api } = fixture();
    for (const route of ['earpiece', 'speaker', 'bluetooth'] as const) {
      const state = { route, devices: [{ kind: 'earpiece' as const }, { kind: 'speaker' as const }, { kind: 'bluetooth' as const }] };
      assert.equal(json(api.speakerPress(state)), '{"sheet":true}');
    }
    const mutant = fixture({ mutation: 'no-sheet' }).api.speakerPress({
      route: 'speaker', devices: [{ kind: 'earpiece' }, { kind: 'speaker' }, { kind: 'bluetooth' }],
    });
    assertMutantKilled(json(mutant), '{"sheet":true}', 'Bluetooth route sheet remains reachable');
  });

  it('проводная гарнитура без earpiece не открывает Bluetooth-лист, а переключается на проводную', () => {
    const state = { route: 'speaker' as const, devices: [{ kind: 'speaker' as const }, { kind: 'wired' as const }, { kind: 'bluetooth' as const }] };
    assert.equal(json(fixture().api.speakerPress(state)), '{"to":"wired"}');
    const mutant = fixture({ mutation: 'wired-sheet' }).api.speakerPress(state);
    assertMutantKilled(json(mutant), '{"to":"wired"}', 'wired presence alone does not open the picker');
  });

  it('мост доступен только на Android и только с каждым обязательным методом', () => {
    assert.equal(fixture().api.callAudioSupported(), true);
    assert.equal(fixture({ android: false }).api.callAudioSupported(), false);
    for (const method of ['start', 'select', 'state'] as const) {
      assert.equal(fixture({ methods: { [method]: false } }).api.callAudioSupported(), false,
        `bridge without ${method} must be unsupported`);
    }
  });

  it('пять публичных операций переживают исключение Java-моста, а вне Android вообще не вызывают его', () => {
    const throwing = fixture({ throws: true });
    assert.doesNotThrow(() => throwing.api.callAudioSupported());
    assert.equal(throwing.api.readCallAudio(), null);
    assert.doesNotThrow(() => throwing.api.startCallAudio(true));
    assert.doesNotThrow(() => throwing.api.stopCallAudio());
    assert.doesNotThrow(() => throwing.api.selectCallRoute('speaker'));
    assert.deepEqual(throwing.calls, ['state', 'start:true', 'stop', 'select:speaker']);

    const desktop = fixture({ android: false });
    assert.equal(desktop.api.callAudioSupported(), false);
    assert.equal(desktop.api.readCallAudio(), null);
    desktop.api.startCallAudio(false);
    desktop.api.stopCallAudio();
    desktop.api.selectCallRoute('speaker');
    assert.deepEqual(desktop.calls, [], 'browser/desktop must never call the Android bridge');
  });

  it('последняя отписка удаляет нативный callback, а мутант оставляет его', () => {
    // Первый ушедший экран не вправе отключить оставшийся; последняя отписка не оставляет глобальный callback.
    const f = fixture();
    const seen: string[] = [];
    const off = f.api.onCallAudioChanged(() => seen.push('первый'));
    const offLast = f.api.onCallAudioChanged(() => seen.push('последний'));
    assert.equal(typeof f.window.__gvCallAudioChanged, 'function');
    (f.window.__gvCallAudioChanged as () => void)(); assert.deepEqual(seen, ['первый', 'последний']);
    off();
    assert.equal(typeof f.window.__gvCallAudioChanged, 'function', 'оставшаяся подписка сохраняет callback');
    (f.window.__gvCallAudioChanged as () => void)(); assert.deepEqual(seen, ['первый', 'последний', 'последний']);
    offLast();
    assert.equal('__gvCallAudioChanged' in f.window, false);
    const mutant = fixture({ mutation: 'leaked-callback' }); mutant.api.onCallAudioChanged(() => {})();
    assertMutantKilled('__gvCallAudioChanged' in mutant.window, false, 'no subscriber means no native callback');
  });
});

it('R216 разговорный режим включается только точной единицей, пустое и мусор не получают MODE_IN_COMMUNICATION', () => {
  for (const commPref of [null, '', '0', 'true', '01', ' 1 ', 'false', 'trash']) assert.equal(fixture({ commPref }).api.commModeWanted(), false);
  assert.equal(fixture({ commPref: '1' }).api.commModeWanted(), true);
  for (const storage of ['absent', 'throws'] as const) assert.equal(fixture({ storage, commPref: '1' }).api.commModeWanted(), false);
});
function commOrder(mutation?: Mutation) {
  const f = fixture({ methods: { comm: true }, commPref: '1', mutation }); f.api.startCallAudio(true);
  assert.equal(f.calls[0], 'comm:true', 'R216-comm-order: режим задаётся до захвата вывода');
  assert.deepEqual(f.calls, ['comm:true', 'start:true']);
}
it('R216 start передаёт разговорный режим до старта и не путает его флаг с video', () => {
  commOrder();
  for (const [commPref, video, expected] of [['0', true, false], ['1', false, true], [null, false, false]] as const) {
    const f = fixture({ methods: { comm: true }, commPref }); f.api.startCallAudio(video); assert.deepEqual(f.calls, [`comm:${expected}`, `start:${video}`]);
  }
  const desktop = fixture({ android: false, methods: { comm: true }, commPref: '1' }); desktop.api.startCallAudio(true); assert.deepEqual(desktop.calls, []);
});
function oldApk(mutation?: Mutation) {
  const f = fixture({ mutation }); assert.doesNotThrow(() => f.api.startCallAudio(false));
  assert.equal(f.calls[0], 'start:false', 'R216-old-apk: отсутствие нового метода не мешает старому start');
}
it('R216 старый APK без метода режима и не-функциональное поле всё ещё запускают звонок', () => {
  oldApk(); const f = fixture();
  (f.window.GusVoiceNative as Record<string, unknown>).callAudioSetCommMode = 'old APK';
  assert.doesNotThrow(() => f.api.startCallAudio(true)); assert.deepEqual(f.calls, ['start:true']);
});
it('R216 ошибка чтения настройки передаёт false до start, ошибка нового метода не пробрасывается', () => {
  const f = fixture({ methods: { comm: true }, storage: 'throws', commPref: '1' }); f.api.startCallAudio(false); assert.deepEqual(f.calls, ['comm:false', 'start:false']);
  const throwing = fixture({ methods: { comm: true }, throws: true }); assert.doesNotThrow(() => throwing.api.startCallAudio(false)); assert.deepEqual(throwing.calls, ['comm:false']);
});
it('R216 контрфакт MODE_IN_COMMUNICATION опаздывает за стартом звонка', () => {
  commOrder(); assert.throws(() => commOrder('comm-order'), e => e instanceof assert.AssertionError && e.message.startsWith('R216-comm-order:')
    && e.operator === 'strictEqual' && e.actual === 'start:true' && e.expected === 'comm:true');
});
it('R216 контрфакт считает отсутствие явного нуля разрешением разговорного режима', () => {
  const check = (mutation?: Mutation) => assert.equal(fixture({ commPref: null, mutation }).api.commModeWanted(), false, 'R216-comm-optin: нужен явный opt-in');
  check(); assert.throws(() => check('comm-loose'), e => e instanceof assert.AssertionError && e.message.startsWith('R216-comm-optin:')
    && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
it('R216 контрфакт без typeof блокирует start на старом APK, а не просто бросает в тестовый загрузчик', () => {
  oldApk(); assert.throws(() => oldApk('comm-unguarded'), e => e instanceof assert.AssertionError && e.message.startsWith('R216-old-apk:')
    && e.operator === 'strictEqual' && e.actual === undefined && e.expected === 'start:false');
});
