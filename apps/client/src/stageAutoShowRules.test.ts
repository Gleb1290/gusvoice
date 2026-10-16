import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  canAutoShowStage,
  nextStageVideoSeen,
  stageHasVideo,
  STAGE_AUTO_SHOW_DELAY_MS,
  type StageVideoRef,
} from './stageAutoShowRules.js';

const active: StageVideoRef = { publication: { isMuted: false } };
const muted: StageVideoRef = { publication: { isMuted: true } };
const enabled = { hideNoVideo: true, channelId: 'voice-1', connected: true, hasVideo: false, sawVideo: true };
type Rules = typeof import('./stageAutoShowRules.js');

// Мутанты исполняют весь настоящий модуль, без извлечения выражений из исходника.
function loadRules(raw: string): Rules {
  const module = { exports: {} };
  const compiled = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module, exports: module.exports }, { timeout: 1000 });
  return module.exports as Rules;
}

function mutateRules(source: string, anchor: string, replacement: string): Rules {
  assert.equal(source.split(anchor).length - 1, 1, 'ровно один точный якорь мутации');
  return loadRules(source.replace(anchor, replacement));
}

function emptyKeepsHidden(rules: Rules) {
  assert.equal(rules.canAutoShowStage({ ...enabled, sawVideo: false }), false,
    'видео ещё не было — автовозврат запрещён');
  assert.equal(rules.canAutoShowStage(enabled), true, 'закончившееся видео разрешает автовозврат');
}

function channelClearsSeen(rules: Rules) {
  const seen = rules.nextStageVideoSeen({ key: 'voice-1', saw: true }, { ...enabled, channelId: 'voice-2' });
  assert.equal(seen.key, 'voice-2');
  assert.equal(seen.saw, false, 'новый пустой канал не наследует просмотренное видео');
  assert.equal(rules.canAutoShowStage({ ...enabled, channelId: seen.key, sawVideo: seen.saw }), false);
}

function disablingClearsSeen(rules: Rules) {
  const off = rules.nextStageVideoSeen({ key: 'voice-1', saw: true }, {
    ...enabled, hideNoVideo: false, hasVideo: true,
  });
  assert.equal(off.saw, false, 'выключение стирает память даже при оставшемся видео');
  assert.equal(off.key, null);
  const again = rules.nextStageVideoSeen(off, enabled);
  assert.equal(again.key, 'voice-1');
  assert.equal(again.saw, false);
  assert.equal(rules.canAutoShowStage({ ...enabled, sawVideo: again.saw }), false);
}

describe('R167 — наличие видео перед автовозвратом участников', () => {
  it('пустые показы и камеры означают отсутствие видео', () => {
    assert.equal(stageHasVideo([], []), false);
  });

  it('одна камера без показов удерживает настройку скрытия участников', () => {
    assert.equal(stageHasVideo([], [active]), true);
    assert.equal(canAutoShowStage({ ...enabled, hasVideo: stageHasVideo([], [active]) }), false);
  });

  it('один показ без камер тоже считается видео', () => {
    assert.equal(stageHasVideo([active], []), true);
  });

  it('показ спутника #screen не исчезает из проверки видео', () => {
    // LiveKit отдаёт отдельного участника показа: фильтр обычных людей здесь недопустим.
    const satellite = { ...active, participant: { identity: 'friend#screen' } };
    assert.equal(stageHasVideo([satellite], []), true);
  });

  it('заглушённые показы и камеры не держат скрытие, незаглушённые держат', () => {
    assert.equal(stageHasVideo([muted], []), false);
    assert.equal(stageHasVideo([], [muted]), false);
    assert.equal(stageHasVideo([muted], [muted]), false);
    assert.equal(stageHasVideo([active], [active]), true);
  });

  it('активное видео после заглушённого находится в каждой из двух коллекций', () => {
    assert.equal(stageHasVideo([muted, active], [muted]), true);
    assert.equal(stageHasVideo([muted], [muted, active]), true);
  });

  it('отсутствующий флаг isMuted не приравнивается к заглушённой публикации', () => {
    for (const ref of [{}, { publication: {} }]) {
      assert.equal(stageHasVideo([ref], []), true);
      assert.equal(stageHasVideo([], [ref]), true);
    }
  });
});

describe('R167–R168 — разрешение автовозврата участников', () => {
  it('в подключённом канале после конца видео включённая настройка может сама выключиться', () => {
    assert.equal(canAutoShowStage(enabled), true);
  });

  it('каждое отсутствующее условие отдельно запрещает автовыключение', () => {
    const cases = [
      { label: 'настройка уже выключена', input: { ...enabled, hideNoVideo: false } },
      { label: 'канал не выбран', input: { ...enabled, channelId: null } },
      { label: 'идентификатор канала пуст', input: { ...enabled, channelId: '' } },
      { label: 'комната ещё не подключена', input: { ...enabled, connected: false } },
      { label: 'видео осталось', input: { ...enabled, hasVideo: true } },
      { label: 'видео с момента включения ещё не было', input: { ...enabled, sawVideo: false } },
    ];
    assert.equal(canAutoShowStage(enabled), true, 'все условия выполнены — автовозврат разрешён');
    for (const { label, input } of cases) assert.equal(canAutoShowStage(input), false, label);
  });

  it('порог непрерывного отсутствия видео составляет три секунды', () => {
    assert.equal(STAGE_AUTO_SHOW_DELAY_MS, 3000);
  });

  it('мутант «считать только показы» обнаруживается камерой без демонстраций', () => {
    const source = readFileSync(new URL('./stageAutoShowRules.ts', import.meta.url), 'utf8');
    const anchor = ' || cameras.some(track => !track.publication?.isMuted)';
    assert.equal(source.split(anchor).length - 1, 1, 'ровно один точный якорь мутации');

    function cameraKeepsHidden(rules: typeof import('./stageAutoShowRules.js')) {
      const hasVideo = rules.stageHasVideo([], [active]);
      assert.equal(rules.canAutoShowStage({ ...enabled, hasVideo }), false,
        'камера без показов запрещает автовыключение');
    }

    const original = loadRules(source);
    cameraKeepsHidden(original);
    const mutant = loadRules(source.replace(anchor, ''));
    // Парный контрфакт: мутант оставляет показ рабочим, ломается именно ветка камер.
    assert.equal(original.stageHasVideo([active], []), true);
    assert.equal(mutant.stageHasVideo([active], []), true);
    assert.throws(() => cameraKeepsHidden(mutant), /камера без показов запрещает автовыключение/);
  });
});

describe('R168 — память видео в текущем включении настройки', () => {
  const rules: Rules = { canAutoShowStage, nextStageVideoSeen, stageHasVideo, STAGE_AUTO_SHOW_DELAY_MS };

  it('включение в пустом канале и повторный пересчёт не разрешают автовозврат', () => {
    let seen = nextStageVideoSeen({ key: null, saw: false }, enabled);
    assert.deepEqual(seen, { key: 'voice-1', saw: false });
    for (let i = 0; i < 3; i++) {
      seen = nextStageVideoSeen(seen, enabled);
      assert.deepEqual(seen, { key: 'voice-1', saw: false });
      assert.equal(canAutoShowStage({ ...enabled, sawVideo: seen.saw }), false);
    }
    emptyKeepsHidden(rules);
  });

  it('появившееся видео запоминается, а после его исчезновения разрешён автовозврат', () => {
    const prev = { key: 'voice-1', saw: false };
    const during = nextStageVideoSeen(prev, { ...enabled, hasVideo: true });
    assert.deepEqual(prev, { key: 'voice-1', saw: false }, 'чистое правило не меняет прошлое состояние');
    assert.deepEqual(during, { key: 'voice-1', saw: true });
    assert.equal(canAutoShowStage({ ...enabled, hasVideo: true, sawVideo: during.saw }), false);
    const after = nextStageVideoSeen(during, enabled);
    assert.deepEqual(after, { key: 'voice-1', saw: true });
    assert.equal(canAutoShowStage({ ...enabled, sawVideo: after.saw }), true);
    assert.deepEqual(nextStageVideoSeen(after, enabled), after, 'память не исчезает на следующем пересчёте');
  });

  it('выключение очищает память и повторное включение в пустом канале держится', () => {
    disablingClearsSeen(rules);
  });

  it('смена канала и выход из канала сбрасывают память предыдущего видео', () => {
    channelClearsSeen(rules);
    const left = nextStageVideoSeen({ key: 'voice-1', saw: true }, {
      ...enabled, channelId: null, hasVideo: true,
    });
    assert.deepEqual(left, { key: null, saw: false }, 'видео без выбранного канала не запоминается');
    const returned = nextStageVideoSeen(left, enabled);
    assert.deepEqual(returned, { key: 'voice-1', saw: false });
    assert.equal(canAutoShowStage({ ...enabled, sawVideo: returned.saw }), false);
  });

  it('видео, уже идущее в новом канале, запоминается заново после сброса ключа', () => {
    const seen = nextStageVideoSeen({ key: 'voice-1', saw: true }, {
      ...enabled, channelId: 'voice-2', hasVideo: true,
    });
    assert.deepEqual(seen, { key: 'voice-2', saw: true });
    assert.equal(canAutoShowStage({ ...enabled, channelId: seen.key, hasVideo: true, sawVideo: seen.saw }), false);
    const ended = nextStageVideoSeen(seen, { ...enabled, channelId: 'voice-2' });
    assert.equal(canAutoShowStage({ ...enabled, channelId: ended.key, sawVideo: ended.saw }), true);
  });

  it('мутант без sawVideo преждевременно разрешает автовозврат в пустом канале', () => {
    const source = readFileSync(new URL('./stageAutoShowRules.ts', import.meta.url), 'utf8');
    emptyKeepsHidden(loadRules(source));
    const mutant = mutateRules(source, ' && input.sawVideo;', ';');
    assert.throws(() => emptyKeepsHidden(mutant), /видео ещё не было — автовозврат запрещён/);
    assert.equal(mutant.canAutoShowStage(enabled), true, 'положительный путь сохранился');
  });

  it('мутант без сброса при смене канала наследует чужое закончившееся видео', () => {
    const source = readFileSync(new URL('./stageAutoShowRules.ts', import.meta.url), 'utf8');
    channelClearsSeen(loadRules(source));
    const mutant = mutateRules(source, 'const saw = prev.key === key ? prev.saw : false;',
      'const saw = key !== null ? prev.saw : false;');
    assert.throws(() => channelClearsSeen(mutant), /новый пустой канал не наследует просмотренное видео/);
    assert.equal(mutant.nextStageVideoSeen({ key: 'voice-1', saw: true }, enabled).saw, true,
      'тот же канал по-прежнему помнит видео');
    disablingClearsSeen(mutant);
  });

  it('мутант без сброса при выключении не даёт начать новое включение с чистой памятью', () => {
    const source = readFileSync(new URL('./stageAutoShowRules.ts', import.meta.url), 'utf8');
    disablingClearsSeen(loadRules(source));
    const mutant = mutateRules(source, 'const key = input.hideNoVideo ? input.channelId : null;',
      'const key = input.channelId;');
    assert.throws(() => disablingClearsSeen(mutant), /выключение стирает память даже при оставшемся видео/);
    channelClearsSeen(mutant);
    assert.equal(mutant.nextStageVideoSeen({ key: 'voice-1', saw: false }, {
      ...enabled, hasVideo: true,
    }).saw, true, 'запоминание активного видео сохранилось');
  });
});
