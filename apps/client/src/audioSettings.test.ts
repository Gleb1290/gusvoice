import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { AUDIO_DEFAULTS, getAudioSettings } from './audioSettings.js';
import type { AudioSettings } from './audioSettings.js';
import { clampVadThreshold, VAD_THRESHOLD_MIN } from './micProcessorRules.js';

it('старый сохранённый ноль мигрирует в порог 1 % при чтении настроек', () => {
  // Ловит сохранение выключенного гейта у существующих пользователей после смены дефолта.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === 'gv_audio' ? JSON.stringify({ vadThreshold: 0 }) : null },
  });
  try {
    assert.equal(AUDIO_DEFAULTS.vadThreshold, VAD_THRESHOLD_MIN);
    assert.equal(getAudioSettings().vadThreshold, VAD_THRESHOLD_MIN);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

const settingsSource = readFileSync(new URL('./audioSettings.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function isolatedSettings(mobile: boolean, initial?: string, source = settingsSource) {
  const saved = new Map<string, string>(initial === undefined ? [] : [['gv_audio', initial]]);
  const deps: Record<string, unknown> = {
    './hotkeys': { isMobile: () => mobile },
    './micProcessorRules': { clampVadThreshold, VAD_THRESHOLD_MIN },
  };
  const module = { exports: {} as typeof import('./audioSettings') };
  // Отдельный кеш настоящего модуля для каждого запуска приложения/сохранённого формата.
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `описана граница ${id}`); return deps[id]; },
  });
  return { settings: module.exports, saved };
}

function bubbleDefault(source = settingsSource) {
  for (const mobile of [false, true]) {
    for (const stored of [undefined, '{}', '{"pushToTalk":true}', '{bad']) {
      const { settings } = isolatedSettings(mobile, stored, source);
      assert.equal(settings.AUDIO_DEFAULTS.micBubble, false, 'R251 bubble-default: новая установка не включает окно поверх приложений');
      assert.equal(settings.getAudioSettings().micBubble, false, 'R251 bubble-legacy: старый формат или битый JSON не включает пузырь');
      if (stored === '{"pushToTalk":true}') assert.equal(settings.getAudioSettings().pushToTalk, true, 'миграция сохраняет выбор рации');
    }
  }
}
// Класс ошибки: обновление приложения само включает Android-overlay у старого пользователя или новой установки.
it('R251 пузырь выключен по умолчанию на ПК и телефоне, старые настройки без поля остаются выключенными', () => bubbleDefault());

// Класс ошибки: явно включённый пузырь теряется после перезапуска, а выключение не сохраняется.
it('R251 явное включение и выключение пузыря переживают сохранение и новый экземпляр модуля', () => {
  for (const mobile of [false, true]) {
    const f = isolatedSettings(mobile);
    for (const enabled of [true, false]) {
      f.settings.setAudioSettings({ ...f.settings.getAudioSettings(), micBubble: enabled });
      const saved = f.saved.get('gv_audio'); assert.ok(saved);
      assert.equal(JSON.parse(saved).micBubble, enabled);
      assert.equal(isolatedSettings(mobile, saved).settings.getAudioSettings().micBubble, enabled);
    }
  }
});

// Класс ошибки: необязательное поле становится обязательным в типе или старый литерал включает пузырь после записи.
it('R251 старый литерал AudioSettings без micBubble по-прежнему допустим и загружается как выключенный', () => {
  const f = isolatedSettings(false);
  const { micBubble: _optionalBubble, ...legacy } = f.settings.AUDIO_DEFAULTS;
  const compatible: AudioSettings = legacy; // tsc защищает совместимость старых литералов.
  f.settings.setAudioSettings(compatible);
  const saved = f.saved.get('gv_audio'); assert.ok(saved);
  assert.equal(Object.hasOwn(JSON.parse(saved), 'micBubble'), false);
  assert.equal(isolatedSettings(false, saved).settings.getAudioSettings().micBubble, false);
});

// Класс ошибки: случайная смена дефолта включает overlay у всех без пользовательского выбора.
it('R251 контрфакт включённого по умолчанию пузыря обнаруживается на чистой установке', () => {
  bubbleDefault();
  const anchor = '  micBubble: false,';
  assert.equal(settingsSource.split(anchor).length - 1, 1);
  assert.throws(() => bubbleDefault(settingsSource.replace(anchor, '  micBubble: true,')),
    error => error instanceof assert.AssertionError && error.message.startsWith('R251 bubble-default:'));
});
