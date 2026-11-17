import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { Simulate } from 'react-dom/test-utils';
import type { SoundEvent } from '../sounds';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

// R377: реальные настройки и настоящая панель, только storage/аудиовывод/пользователь — внешние границы.
const source = sourceOf('SoundSettingsPanel');
const soundsSource = readFileSync(new URL('../sounds.ts', import.meta.url), 'utf8');
const gameEvents: SoundEvent[] = ['wheelTick', 'wheelWin', 'diceRoll', 'duelWin', 'duelLose', 'duelInvite',
  'wheelJackpot', 'greedyBurn', 'rpsReveal', 'predictionResult', 'gamesLaunch', 'predictionOpen', 'predictionClosed'];
function sounds(context: unknown = null) {
  return load<typeof import('../sounds')>(new URL('../sounds.ts', import.meta.url), soundsSource, { './voiceKeepAlive': { sharedAudioContext: () => context } }, {
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => { throw new Error('Сеть в тесте настроек звука запрещена'); },
  });
}
function panel(api: ReturnType<typeof sounds>, superAdmin?: boolean) {
  const state = { user: { superAdmin } };
  const previews: SoundEvent[] = [];
  const { SoundSettingsPanel } = load<typeof import('./SoundSettingsPanel')>(new URL('./SoundSettingsPanel.tsx', import.meta.url), source, {
    react: React, '../sounds': { ...api, playSound: (event: SoundEvent) => previews.push(event) },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) }, './Icon': { Icon: () => null },
  });
  return { state, previews, element: () => React.createElement(SoundSettingsPanel) };
}
const labels = (host: ParentNode) => [...host.querySelectorAll('.sound-row label')].map(row => row.textContent?.trim());

it('обычный пользователь не видит игровые звуки, но сохраняет все обычные настройки уведомлений', async () => {
  await environment(async (host, render) => {
    const api = sounds();
    assert.ok(api.GAME_SOUND_EVENTS.has('duelLose'), 'новое поражение тоже относится к скрытым игровым событиям');
    const expected = Object.entries(api.SOUND_EVENT_LABELS).filter(([event]) => !gameEvents.includes(event as SoundEvent)).map(([, label]) => label);
    assert.ok(expected.length > 0);
    for (const privilege of [undefined, false]) {
      await render(panel(api, privilege).element());
      assert.deepEqual(labels(host), expected, 'исключены все игровые строки, не вся панель');
      await render(null);
    }
  });
});

it('суперадмин видит и пробует все игровые звуки, потеря привилегии убирает строки без сброса настроек', async () => {
  await environment(async (host, render) => {
    const api = sounds(), p = panel(api, true);
    await render(p.element());
    assert.deepEqual(labels(host), Object.values(api.SOUND_EVENT_LABELS));
    for (const event of gameEvents) {
      const row = [...host.querySelectorAll('.sound-row')].find(row => row.querySelector('label')?.textContent?.trim() === api.SOUND_EVENT_LABELS[event]);
      const button = row?.querySelector<HTMLButtonElement>('button'); assert.ok(button); assert.equal(button.disabled, false);
      await React.act(async () => button.click());
    }
    assert.deepEqual(p.previews, gameEvents, 'каждая видимая проба передаёт собственное событие');
    const loseRow = [...host.querySelectorAll('.sound-row')].find(row => row.querySelector('label')?.textContent?.trim() === api.SOUND_EVENT_LABELS.duelLose);
    const checkbox = loseRow?.querySelector<HTMLInputElement>('input'); assert.ok(checkbox);
    await React.act(async () => Simulate.change(checkbox, { target: { checked: false } as unknown as EventTarget }));
    assert.equal(api.getSoundSettings().events.duelLose, false, 'собственный выключатель меняет настоящие настройки');
    p.state.user.superAdmin = false; await render(p.element());
    assert.deepEqual(labels(host), Object.entries(api.SOUND_EVENT_LABELS).filter(([event]) => !gameEvents.includes(event as SoundEvent)).map(([, label]) => label));
    assert.equal(api.getSoundSettings().events.duelLose, false, 'скрытие строки не сбрасывает пользовательский выключатель');
  });
});

it('новое поражение включено по умолчанию, синтезирует две нисходящие ноты и уважает mute и громкость', async () => {
  await environment(async () => {
    const notes: Array<{ freq: number; start: number }> = [], masters: Array<{ value: number }> = [];
    const context = { state: 'running', currentTime: 10, destination: {},
      createGain() { const gain = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
        masters.push(gain); return { gain, connect(target: unknown) { return target; } }; },
      createOscillator() { const note = { freq: 0, start: 0 }; notes.push(note); return { type: '',
        frequency: { setValueAtTime(value: number) { note.freq = value; }, exponentialRampToValueAtTime() {} },
        connect(target: unknown) { return target; }, start(value: number) { note.start = value; }, stop() {} }; },
    };
    const api = sounds(context);
    assert.equal(api.SOUND_EVENT_LABELS.duelLose, 'Поражение в дуэли');
    assert.equal(api.getSoundSettings().events.duelLose, true);
    const settings = api.getSoundSettings();
    api.setSoundSettings({ ...settings, volume: 1 }); api.playSound('duelLose');
    assert.deepEqual(notes.map(n => n.freq), [392, 329.63], 'играется G4 → E4, а не немое событие');
    assert.ok(notes[1].start > notes[0].start, 'вторая нота начинается позже первой');
    assert.equal(masters[0].value, 0.35, 'поражение тише полной громкости');
    notes.length = 0; masters.length = 0;
    api.setSoundSettings({ ...settings, enabled: false }); api.playSound('duelLose');
    api.setSoundSettings({ ...settings, events: { ...settings.events, duelLose: false } }); api.playSound('duelLose');
    assert.equal(notes.length, 0, 'оба выключателя действительно глушат синтез');
    api.setSoundSettings({ ...settings, volume: 0.1 }); api.playSound('duelLose');
    assert.equal(notes.length, 2); assert.equal(masters[0].value, 0.1, 'тихий мастер не повышается до потолка');
  });
});
