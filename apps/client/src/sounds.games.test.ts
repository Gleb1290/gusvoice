import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { SoundEvent } from './sounds';

type Sounds = typeof import('./sounds');
type Edit = { from: string; to: string };
const source = readFileSync(new URL('./sounds.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const events = [
  ['diceRoll', 'Бросок кубиков', 0.35], ['duelWin', 'Победа в дуэли', 0.5], ['duelInvite', 'Вызов на дуэль', 0.3],
  ['wheelJackpot', 'Сундук колеса сорван', 0.55], ['greedyBurn', 'Сгорание в «Жадном гусе»', 0.35],
  ['rpsReveal', 'Раскрытие рук в КНБ', 0.3], ['predictionResult', 'Выигрыш ставки на событие', 0.45],
  ['gamesLaunch', 'Запуск игр на сервере', 0.55],
] as const;
function declaration(name: string) {
  const file = ts.createSourceFile('sounds.ts', source, ts.ScriptTarget.Latest, true);
  const found = file.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .find(d => ts.isIdentifier(d.name) && d.name.text === name);
  assert.ok(found?.initializer, `R341 sound setup: ${name} найден`); return { file, value: found.initializer };
}
paired('R343 регистрация горна сохраняет последний файл только своего события', f => {
  configure(f.api, 'gamesLaunch', true, true);
  f.api.registerBuiltinSound('gamesLaunch', '/synthetic-horn-old.ogg');
  f.api.registerBuiltinSound('gamesLaunch', '/synthetic-horn.ogg');
  f.api.registerBuiltinSound('tip', '/synthetic-tip.ogg');
  f.api.playSound('gamesLaunch');
  assert.deepEqual(f.plays, [{ url: '/synthetic-horn.ogg', volume: 0.55 }], 'R341 звук: файл зарегистрирован по event, повтор заменил старый');
}, [{ from: 'BUILTIN[event] = url;', to: 'void url;' }, { from: 'BUILTIN[event] = url;', to: "BUILTIN['gamesLaunch'] = url;" }]);
paired('R343 горн подчиняется mute и остаётся ниже паков канала и сервера', f => {
  f.api.registerBuiltinSound('gamesLaunch', '/synthetic-horn.ogg');
  configure(f.api, 'gamesLaunch', false, true); f.api.playSound('gamesLaunch');
  configure(f.api, 'gamesLaunch', true, false); f.api.playSound('gamesLaunch');
  assert.equal(f.plays.length, 0, 'R341 звук: регистрация не обходит два выключателя');
  configure(f.api, 'gamesLaunch', true, true);
  f.api.setCustomSounds({ gamesLaunch: '/synthetic-server.ogg' });
  f.api.setChannelSounds({ channel: { gamesLaunch: '/synthetic-channel.ogg' } });
  f.api.playSound('gamesLaunch', 'channel');
  f.api.setChannelSounds(undefined); f.api.playSound('gamesLaunch', 'channel');
  f.api.setCustomSounds(undefined); f.api.playSound('gamesLaunch', 'channel');
  assert.deepEqual(f.plays.map(p => p.url), ['/synthetic-channel.ogg', '/synthetic-server.ogg', '/synthetic-horn.ogg'],
    'R341 звук: канал → сервер → вшитый горн');
  assert.equal(f.plays.every(p => p.volume === 0.55), true, 'R341 звук: потолок одинаков для всех источников');
}, [{ from: 'const custom = (channelId ? channelSounds[channelId]?.[event] : undefined) || customSounds[event];',
  to: 'const custom = BUILTIN[event] || (channelId ? channelSounds[channelId]?.[event] : undefined) || customSounds[event];' },
  { from: 'if (!settings.enabled || !settings.events[event]) return;', to: 'if (!settings.enabled) return;' }]);
function field(name: string, key: string) {
  const { file, value } = declaration(name); assert.ok(ts.isObjectLiteralExpression(value));
  const prop = value.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(file).replace(/['"]/g, '') === key);
  assert.ok(prop, `R341 sound setup: поле ${name}.${key}`); return prop.initializer;
}
function editNode(node: ts.Node, replacement: string): Edit { return { from: source.slice(node.getStart(), node.end), to: replacement }; }
function load(edit?: Edit) {
  let raw = source;
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'R341 sound setup: адресный якорь полного модуля'); raw = raw.replace(edit.from, edit.to); }
  const plays: Array<{ url: string; volume: number }> = [];
  class Audio {
    volume = 0; currentTime = 0; preload = '';
    constructor(private url: string) {}
    async play() { plays.push({ url: this.url, volume: this.volume }); }
  }
  const module = { exports: {} as Sounds };
  // Настоящий playSound, настройки и caps; только HTMLAudio/общий контекст и storage — IO.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Audio, window: {}, localStorage: { getItem: () => JSON.stringify({ enabled: true, volume: 0.8, events: { join: false } }), setItem() {} },
      require(id: string) { assert.equal(id, './voiceKeepAlive', 'R341 sound setup: закрытый импорт'); return { sharedAudioContext: () => null }; } });
  return { api: module.exports, plays, source: raw };
}
type Fixture = ReturnType<typeof load>;
function paired(title: string, check: (f: Fixture) => void, edits: Edit[]) {
  it(`R341 игровые звуки: ${title}`, () => {
    check(load());
    for (const edit of edits) {
      counterfact(() => { assert.throws(() => check(load(edit)), e => e instanceof assert.AssertionError && e.message.startsWith('R341 звук:')); });
      check(load());
    }
  });
}
function configure(api: Sounds, event: SoundEvent, enabled: boolean, eventEnabled: boolean, volume = 1) {
  const prev = api.getSoundSettings(); api.setSoundSettings({ ...prev, enabled, volume, events: { ...prev.events, [event]: eventEnabled } });
}
const playGate = 'if (!settings.enabled || !settings.events[event]) return;';
for (const [event, label, cap] of events) {
  const all = declaration('ALL_EVENTS').value; assert.ok(ts.isArrayLiteralExpression(all));
  const eventNode = all.elements.find(n => ts.isStringLiteral(n) && n.text === event); assert.ok(eventNode);
  const allText = source.slice(all.getStart(), all.end);
  const withoutEvent: Edit = { from: allText, to: allText.slice(0, eventNode.getStart() - all.getStart())
    + "'synthetic-unknown-event'" + allText.slice(eventNode.end - all.getStart()) };
  // Поле cap само по себе не уникально (0.3/0.5 повторяются), адресуем property целиком.
  const capNode = field('VOLUME_CAP', event).parent;
  const cue = field('CUES', event);
  paired(`${event} имеет подпись, синтез, default true и включён в старом профиле`, f => {
    assert.equal(f.api.SOUND_EVENT_LABELS[event], label, 'R341 звук: точная подпись нового события');
    assert.equal(f.api.SOUND_DEFAULTS.events[event], true, 'R341 звук: событие включено по умолчанию');
    assert.equal(f.api.getSoundSettings().events[event], true, 'R341 звук: старый профиль наследует новый включённый ключ');
    assert.equal(f.api.getSoundSettings().events.join, false, 'R341 звук: старый пользовательский выбор сохранён');
  }, [withoutEvent, { from: `${event}: '${label}',`, to: `${event}: 'Другой звук',` }]);

  paired(`${event} соблюдает master/event mute и собственный потолок даже в пользовательском паке`, f => {
    f.api.setCustomSounds({ [event]: '/synthetic-game-cue.wav' });
    configure(f.api, event, false, true); f.api.playSound(event);
    configure(f.api, event, true, false); f.api.playSound(event);
    assert.deepEqual(f.plays, [], 'R341 звук: оба выключателя действительно молчат');
    configure(f.api, event, true, true); f.api.playSound(event);
    assert.deepEqual(f.plays, [{ url: '/synthetic-game-cue.wav', volume: cap }], 'R341 звук: мастер прижат потолком события');
    configure(f.api, event, true, true, 0.1); f.api.playSound(event);
    assert.equal((f.plays as Array<{ volume: number }>).at(-1)!.volume, 0.1, 'R341 звук: тихий мастер не поднимается до потолка');
  }, [editNode(capNode, `${event}: 1`), { from: playGate, to: 'if (!settings.events[event]) return;' },
    { from: playGate, to: 'if (!settings.enabled) return;' }]);

  paired(`${event} не теряет настоящий синтезированный запасной сигнал`, f => {
    // Отдельный AST guard читает именно переданный целый модуль, а не копию таблицы в тесте.
    const tree = ts.createSourceFile('sounds.ts', f.source, ts.ScriptTarget.Latest, true);
    const cues = tree.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
      .find(d => ts.isIdentifier(d.name) && d.name.text === 'CUES')?.initializer;
    assert.ok(cues && ts.isObjectLiteralExpression(cues), 'R341 звук: таблица синтеза существует');
    const member = cues.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(tree) === event);
    assert.ok(member && ts.isArrowFunction(member.initializer) && ts.isBlock(member.initializer.body)
      && member.initializer.body.statements.length > 0, 'R341 звук: у события есть непустой реальный CUE');
  }, [editNode(cue, '() => {}')]);
}
