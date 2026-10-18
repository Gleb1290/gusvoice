import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './micActionRules';
import type { MicAction, MicEffect, MicState } from './micActionRules';

const source = readFileSync(new URL('./micActionRules.ts', import.meta.url), 'utf8');
const actions: readonly MicAction[] = ['toggle-mute', 'toggle-deafen', 'leave', 'ptt-down', 'ptt-up'];
const active: Extract<MicState, { inVoice: true }> = {
  inVoice: true, muted: false, deafened: false, ptt: false, speaking: false, channelName: 'Гостиная 🪿',
  pttReleaseMs: 150,
};

function load(raw: string): typeof rules {
  // Исполняется весь модуль, не копия формулы; новая зависимость обязана получить явную границу.
  const module = { exports: {} as typeof rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, require: (id: string) => assert.fail(`Неописанный импорт ${id}`) });
  return module.exports;
}

function kill(from: string, to: string, verify: (api: typeof rules) => void, message: string): void {
  verify(load(source)); // Сначала тот же сценарий обязан пройти на исходном модуле.
  assert.equal(source.split(from).length - 1, 1, 'точка мутации единственная');
  const mutant = load(source.replace(from, to)); // Ошибки загрузки не засчитываются за пойманную регрессию.
  assert.throws(() => verify(mutant), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(message));
}

it('R250 пять известных команд принимаются без изменения', () => {
  for (const action of actions) assert.equal(rules.parseMicAction(action), action);
});

it('R250 неизвестные команды, иной регистр, пробелы и нестроковые значения безопасно игнорируются', () => {
  // Не нормализуем строку моста: похожая команда нового APK не должна неожиданно переключить микрофон.
  for (const raw of ['', 'toggle', 'TOGGLE-MUTE', ' toggle-mute', 'leave ', 'ptt-start', null, undefined,
    false, true, 0, 1, ['leave'], { action: 'leave' }, new String('leave')]) {
    assert.equal(rules.parseMicAction(raw), null, String(raw));
  }
});

for (const inVoice of [false, true]) {
  for (const pushToTalk of [false, true]) {
    it(`R250 таблица команд: голос ${inVoice ? 'подключён' : 'отключён'}, рация ${pushToTalk ? 'включена' : 'выключена'}`, () => {
      const expected: readonly MicEffect[] = !inVoice
        ? ['none', 'none', 'none', 'none', 'none']
        : ['toggle-mute', 'toggle-deafen', 'leave', pushToTalk ? 'ptt-start' : 'none', pushToTalk ? 'ptt-end' : 'none'];
      actions.forEach((action, index) => assert.equal(rules.micActionEffect(action, { inVoice, pushToTalk }), expected[index], action));
    });
  }
}

for (const [muted, deafened, expected] of [
  [false, false, true], [true, false, false], [false, true, false], [true, true, false],
] as const) {
  it(`R250 рация ${expected ? 'открывает' : 'не открывает'} микрофон: мьют=${muted}, «Не слышу»=${deafened}`, () => {
    // Мьют обязан блокировать рацию и сам по себе, не только в паре с «Не слышу».
    assert.equal(rules.pttCanOpen(muted, deafened), expected);
  });
}

it('R250 вне голоса состояние не содержит старых имени канала, рации и признака речи', () => {
  for (const flag of [false, true]) {
    assert.deepEqual(rules.micStateOf({ inVoice: false, muted: flag, deafened: flag, ptt: flag,
      selfSpeaking: flag, channelName: 'Старый канал', pttReleaseMs: 150 }), { inVoice: false });
  }
});

for (const muted of [false, true]) {
  for (const deafened of [false, true]) {
    for (const selfSpeaking of [false, true]) {
      it(`R250 своё состояние речи: мьют=${muted}, «Не слышу»=${deafened}, анализатор=${selfSpeaking}`, () => {
        // Остаточный уровень трека после мьюта не должен зажигать нативное «говорю».
        for (const ptt of [false, true]) {
          assert.deepEqual(rules.micStateOf({ inVoice: true, muted, deafened, ptt, selfSpeaking,
            channelName: active.channelName, pttReleaseMs: active.pttReleaseMs }), { inVoice: true, muted, deafened, ptt,
            speaking: selfSpeaking && !muted && !deafened, channelName: active.channelName, pttReleaseMs: active.pttReleaseMs });
        }
      });
    }
  }
}

it('R250 одинаковые состояния не зависят от ссылки на объект, первое состояние всегда новое', () => {
  assert.equal(rules.sameMicState(null, active), false);
  assert.equal(rules.sameMicState(null, { inVoice: false }), false);
  assert.equal(rules.sameMicState(active, { ...active }), true);
  assert.equal(rules.sameMicState({ inVoice: false }, { inVoice: false }), true);
});

const changes: readonly [string, MicState][] = [
  ['выход из голоса', { inVoice: false }],
  ['мьют', { ...active, muted: true }],
  ['«Не слышу»', { ...active, deafened: true }],
  ['рация', { ...active, ptt: true }],
  ['речь', { ...active, speaking: true }],
  ['название канала', { ...active, channelName: 'Другой канал' }],
];
for (const [label, changed] of changes) {
  it(`R250 изменение поля «${label}» не теряется при сравнении состояния`, () => {
    assert.equal(rules.sameMicState(active, changed), false);
    assert.equal(rules.sameMicState(changed, active), false);
  });
}

for (const [supported, pushToTalk, micBubble, expected] of [
  [false, false, false, false], [false, false, true, false],
  [false, true, false, false], [false, true, true, false],
  [true, false, false, false], [true, false, true, false],
  [true, true, false, true], [true, true, true, false],
] as const) {
  it(`R251 подсказка ${expected ? 'нужна' : 'не нужна'}: поддержка=${supported}, рация=${pushToTalk}, пузырь=${micBubble}`, () => {
    assert.equal(rules.needsMicBubbleHint({ supported, pushToTalk, micBubble }), expected);
  });
}

for (const [on, canDraw, expected] of [
  [false, false, 'disable'], [false, true, 'disable'], [true, false, 'ask'], [true, true, 'enable'],
] as const) {
  it(`R251 переключение пузыря: включить=${on}, разрешение=${canDraw} → ${expected}`, () => {
    assert.equal(rules.micBubbleToggle(on, canDraw), expected);
  });
}

it('R250 контрфакт без проверки голоса меняет настройки после выхода и отвергается', () => {
  // Уведомление снимается не одновременно с выходом: запоздавший тап не меняет сохранённый мьют.
  kill("if (!ctx.inVoice) return 'none';", '', (api) => {
    assert.equal(api.micActionEffect('toggle-mute', { inVoice: false, pushToTalk: true }), 'none', 'после выхода нет эффекта');
  }, 'после выхода нет эффекта');
});

it('R250 контрфакт без запрета мьюта не проходит сценарий зажатой рации', () => {
  kill('return !muted && !deafened;', 'return !deafened;', (api) => {
    assert.equal(api.pttCanOpen(true, false), false, 'мьют сильнее рации');
    assert.equal(api.pttCanOpen(false, false), true);
  }, 'мьют сильнее рации');
});

it('R251 контрфакт без поддержки показывает бесполезную подсказку на старом APK и отвергается', () => {
  kill('return i.supported && i.pushToTalk && !i.micBubble;', 'return i.pushToTalk && !i.micBubble;', (api) => {
    assert.equal(api.needsMicBubbleHint({ supported: false, pushToTalk: true, micBubble: false }), false, 'старому APK не советуют недоступный пузырь');
    assert.equal(api.needsMicBubbleHint({ supported: true, pushToTalk: true, micBubble: false }), true);
  }, 'старому APK не советуют недоступный пузырь');
});

it('R251 контрфакт ask → enable не проходит включение без системного разрешения', () => {
  kill("return canDraw ? 'enable' : 'ask';", "return canDraw ? 'enable' : 'enable';", (api) => {
    assert.equal(api.micBubbleToggle(true, false), 'ask', 'сначала нужно запросить разрешение');
    assert.equal(api.micBubbleToggle(true, true), 'enable');
  }, 'сначала нужно запросить разрешение');
});

for (const [label, value, expected] of [
  ['ноль отпускает сразу', 0, 0],
  ['меньше половины миллисекунды', 0.49, 0],
  ['ровно половина миллисекунды', 0.5, 1],
  ['доля ниже следующей половины', 149.49, 149],
  ['доля ровно на следующей половине', 149.5, 150],
  ['целая задержка', 150, 150],
  ['отрицательная половина не даёт минус ноль', -0.5, 0],
  ['отрицательная задержка', -150, 0],
  ['NaN в сохранённых настройках', Number.NaN, 0],
] as const) {
  // Класс ошибки: Android получает отрицательный/NaN таймер или другую задержку на границе округления.
  it(`R252 задержка отпускания нормализуется: ${label}`, () => {
    assert.deepEqual(rules.micStateOf({ ...active, selfSpeaking: false, pttReleaseMs: value }),
      { ...active, pttReleaseMs: expected });
  });
}

// Класс ошибки: смена только задержки отсекается дедупом, и пузырь продолжает использовать старый хвост.
it('R252 новая задержка отличается от прежней в обоих направлениях сравнения состояния', () => {
  const immediate = { ...active, pttReleaseMs: 0 };
  assert.equal(rules.sameMicState(active, immediate), false);
  assert.equal(rules.sameMicState(immediate, active), false);
  assert.equal(rules.sameMicState(immediate, { ...immediate }), true);
});

for (const [label, replacement, value, expected] of [
  ['без ограничения отрицательного значения', 'Math.round(i.pttReleaseMs) || 0', -150, 0],
  ['без замены NaN нулём', 'Math.max(0, Math.round(i.pttReleaseMs))', Number.NaN, 0],
  ['округление вниз вместо ближайшего целого', 'Math.max(0, Math.floor(i.pttReleaseMs) || 0)', 0.5, 1],
] as const) {
  // Класс ошибки: проверка нормализации должна ловить каждый из трёх независимых дефектов формулы.
  it(`R252 контрфакт задержки: ${label}`, () => {
    kill('Math.max(0, Math.round(i.pttReleaseMs) || 0)', replacement, api => {
      const result = api.micStateOf({ ...active, selfSpeaking: false, pttReleaseMs: value });
      assert.ok(result.inVoice);
      assert.equal(result.pttReleaseMs, expected, 'R252 задержка нормализуется до отправки нативу');
    }, 'R252 задержка нормализуется до отправки нативу');
  });
}
