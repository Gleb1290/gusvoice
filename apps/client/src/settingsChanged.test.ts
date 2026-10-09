import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedDotOn, GROUP_ITEMS, groupPrints, samePrints, sameValue, type SettingsSnapshot } from './settingsChanged.js';
import type { StreamSettings } from './streamSettings.js';
import { visibleSections } from './settingsNav';
import { readFileSync } from 'node:fs';

it('отправка и двойной клик сохраняют заводские умолчания и отмечают только свою группу во всех слоях настроек', () => {
  // Новая настройка не должна потеряться из снимка, поискового раздела или индикатора изменений.
  const base = snapshot(); const explicit = { ...base, sendMode: 'enter' as const, doubleClick: 'react' as const, quickReaction: '👍' };
  assert.deepEqual(groupPrints(base), groupPrints(explicit));
  for (const [patch, group] of [[{ sendMode: 'ctrl-enter' }, 'set-g-send'], [{ doubleClick: 'reply' }, 'set-g-dblclick'], [{ quickReaction: '🔥' }, 'set-g-dblclick']] as const) {
    const changed = groupPrints({ ...explicit, ...patch });
    assert.deepEqual(Object.keys(changed).filter((k) => changed[k] !== groupPrints(explicit)[k]), [group]);
  }
  const groups = visibleSections({ federation: false, desktop: true, mobile: false }).flatMap((s) => s.groups.map((g) => g.id));
  for (const id of ['set-g-send', 'set-g-dblclick']) assert.ok(groups.includes(id));
  const snap = readFileSync(new URL('./settingsSnapshot.ts', import.meta.url), 'utf8');
  for (const field of ['sendMode', 'doubleClick', 'quickReaction']) assert.match(snap, new RegExp(`${field}:`));
  const modal = readFileSync(new URL('./components/UserSettingsModal.tsx', import.meta.url), 'utf8');
  for (const id of ['set-g-send', 'set-g-dblclick']) assert.ok(modal.includes(id));
});

const stream = (gpuPipeline?: boolean): StreamSettings => ({
  resolution: '1080', fps: 30, mode: 'detail', codec: 'h264', audio: true,
  wgcWindow: true, layers: true, streamPreview: true, ...(gpuPipeline === undefined ? {} : { gpuPipeline }),
});
it('настройка свайпа видна только на телефоне, pin помечает изменённой только свою группу', () => {
  // Ловит неработающую настольную настройку и отсутствие маркера изменённого действия.
  const groups=(mobile:boolean)=>visibleSections({federation:false,desktop:!mobile,mobile}).flatMap(s=>s.groups.map(g=>g.id));
  assert.equal(groups(false).includes('set-g-swipe'),false); assert.equal(groups(true).includes('set-g-swipe'),true);
  const base=snapshot(); const changed=groupPrints({...base,chatSwipe:'pin'});
  assert.deepEqual(Object.keys(changed).filter(k=>changed[k]!==groupPrints(base)[k]),['set-g-swipe']);
});

function groupChanges(group: string, now: SettingsSnapshot, factory: SettingsSnapshot): number {
  return (GROUP_ITEMS[group] ?? []).filter((pick) => !sameValue(pick(now), pick(factory))).length;
}

function streamChanges(now: StreamSettings, factory: StreamSettings): number {
  const items = GROUP_ITEMS['set-g-stream'] ?? [];
  const snapshot = (value: StreamSettings) => ({ stream: value }) as SettingsSnapshot;
  return items.filter((pick) => !sameValue(pick(snapshot(now)), pick(snapshot(factory)))).length;
}

describe('маркер GPU-конвейера показа', () => {
  it('отсутствие и true одинаковы, а false считается ровно одним изменением', () => {
    // Ловит вечную точку «изменено» у старых настроек и потерю осознанного аварийного выключателя.
    assert.equal(streamChanges(stream(), stream(true)), 0);
    assert.equal(streamChanges(stream(true), stream()), 0);
    assert.equal(streamChanges(stream(false), stream()), 1);
  });
});

describe('маркеры курсора и оптимизированного режима', () => {
  it('отсутствующий и включённый курсор равны default, а false считается изменением', () => {
    // Ловит вечную точку у старой записи и незаметное выключение курсора без точки «изменено».
    const base = snapshot();
    const enabled = snapshot();
    enabled.stream.cursor = true;
    const disabled = snapshot();
    disabled.stream.cursor = false;
    assert.equal(groupChanges('set-g-stream-cursor', base, enabled), 0);
    assert.equal(groupChanges('set-g-stream-cursor', enabled, base), 0);
    assert.equal(groupChanges('set-g-stream-cursor', disabled, base), 1);
  });

  it('оптимизированный режим меняет только свою группу', () => {
    // Ловит привязку точки производительности к соседней группе аватаров.
    const before = groupPrints(snapshot());
    const changed = snapshot();
    changed.liteMode = true;
    const after = groupPrints(changed);
    assert.deepEqual(Object.keys(after).filter((key) => before[key] !== after[key]), ['set-g-lite']);
  });
});

const snapshot = (): SettingsSnapshot => ({
  audio: {
    inputDeviceId: '', outputDeviceId: '', cameraDeviceId: '', inputGain: 1, vadThreshold: 0.1,
    noiseFilter: true, echoCancellation: true, autoGainControl: true, pushToTalk: false,
    pttKey: '', pttReleaseMs: 0,
  },
  camera: { width: 1280, height: 720, frameRate: 30 },
  hotkeys: { mute: '', deafen: '', screenShare: '', overlayToggle: '', diagMark: '' },
  stream: stream(),
  overlay: {
    enabled: false, mode: 'voice', apps: [], content: 'speakers', posMode: 'corner', corner: 'top-right',
    marginX: 0, marginY: 0, customX: 0, customY: 0, opacity: 1, onlyInVoice: true,
  },
  toast: {
    enabled: true, tips: true, pokes: true, posMode: 'corner', corner: 'top-right', marginX: 0,
    marginY: 0, customX: 0, customY: 0, opacity: 1, scale: 1, onlyInVoice: false,
  },
  sounds: { enabled: true, volume: 1, events: {} },
  theme: 'dark', uiScale: 'md', sidebarWidth: 280, animatedAvatars: true, linkPreviews: true,
  osNotify: 'all', coinNotify: 'all', closeBehavior: 'ask', downloadDir: null,
} as unknown as SettingsSnapshot);

describe('увиденные изменения настроек', () => {
  it('точка горит только у отличия с ещё не виденным отпечатком', () => {
    // Ловит вечную точку после просмотра и точку у полностью заводской группы.
    assert.equal(changedDotOn({ changed: 0, total: 2 }, undefined, 'a'), false);
    assert.equal(changedDotOn({ changed: 1, total: 2 }, undefined, 'a'), true);
    assert.equal(changedDotOn({ changed: 1, total: 2 }, 'a', 'a'), false);
    assert.equal(changedDotOn({ changed: 1, total: 2 }, 'a', 'b'), true);
  });

  it('смена значения меняет отпечаток только своей группы', () => {
    // Ловит погашение или зажигание несвязанных точек после одной настройки масштаба.
    const before = groupPrints(snapshot());
    const changed = snapshot();
    changed.uiScale = 'lg';
    const after = groupPrints(changed);
    assert.deepEqual(Object.keys(after).filter((key) => before[key] !== after[key]), ['set-g-scale']);
  });

  it('наборы отпечатков сравниваются симметрично, включая лишний ключ', () => {
    // Ловит пропуск новой группы, присутствующей только с одной стороны сравнения.
    assert.equal(samePrints({ a: '1' }, { a: '1' }), true);
    assert.equal(samePrints({ a: '1' }, { a: '2' }), false);
    assert.equal(samePrints({ a: '1' }, { a: '1', b: '2' }), false);
    assert.equal(samePrints({ a: '1', b: '2' }, { a: '1' }), false);
  });
});
