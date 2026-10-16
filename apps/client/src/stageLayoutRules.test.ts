import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as layoutRules from './stageLayoutRules';

type Rules = typeof layoutRules;
const source = readFileSync(new URL('./stageLayoutRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  const js = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: (id: string) => { throw Error(`Неизвестный импорт ${id}`); } });
  return module.exports;
}
function mutation(anchor: string, replacement: string, check: (rules: Rules) => void): void {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь мутанта должен однозначно обозначать реальный код');
  check(layoutRules); // сначала выполняем тот же контракт на оригинальном модуле.
  assert.throws(
    () => check(load(source.replace(anchor, replacement))),
    (error: unknown) => error instanceof assert.AssertionError && error.operator === 'strictEqual',
    'мутант должен ломать именно ожидаемое равенство, а не падать по посторонней причине',
  );
}

// Класс ошибки: неизвестное сохранённое значение вместо безопасного «Авто» ломает сцену.
it('R248 допустимые виды читаются, неизвестные и повреждённые превращаются в Авто', () => {
  for (const layout of layoutRules.STAGE_LAYOUTS) assert.equal(layoutRules.parseStageLayout(layout), layout);
  for (const raw of [undefined, null, 1, {}, '', 'future-layout', 'FOCUS']) assert.equal(layoutRules.parseStageLayout(raw), 'auto');
});

// Класс ошибки: мобильный выбор показывает недоступный режим или затирает сохранённый выбор.
it('R248 телефон предлагает три вида, ПК пять, а сетка/сбоку на телефоне действуют как Авто', () => {
  assert.deepEqual(layoutRules.stageLayoutChoices(false), ['auto', 'grid', 'focus', 'side', 'speaker']);
  assert.deepEqual(layoutRules.stageLayoutChoices(true), ['auto', 'focus', 'speaker']);
  for (const layout of layoutRules.STAGE_LAYOUTS) {
    const effective = layoutRules.effectiveStageLayout(layout, true);
    assert.equal(effective, layout === 'grid' || layout === 'side' ? 'auto' : layout);
    assert.equal(layoutRules.effectiveStageLayout(layout, false), layout);
    assert.equal(layout, layoutRules.parseStageLayout(layout)); // применение не переписывает источник выбора.
  }
  assert.equal(layoutRules.effectiveStageLayout('grid', false), 'grid');
  assert.equal(layoutRules.effectiveStageLayout('side', false), 'side');
});

// Класс ошибки: режим с одним главным видео ошибочно ведёт себя как равная сетка или наоборот.
it('R248 только Фокус, Сбоку и Говорящий допускают одну большую плитку', () => {
  assert.equal(layoutRules.isOneBigLayout('auto'), false);
  assert.equal(layoutRules.isOneBigLayout('grid'), false);
  assert.equal(layoutRules.isOneBigLayout('focus'), true);
  assert.equal(layoutRules.isOneBigLayout('side'), true);
  assert.equal(layoutRules.isOneBigLayout('speaker'), true);
});

// Класс ошибки: автооткрытие игнорирует режим, уже открытый показ, камеру, seen или порядок участников.
it('R248 автооткрывается первый ещё не виденный чужой показ только в Фокусе/Сбоку без занятого фокуса', () => {
  const screens = ['seen-first', 'new-second', 'new-third'];
  const seen = new Set(['seen-first']);
  assert.equal(layoutRules.stageAutoOpenStream('focus', screens, [], false, seen), 'new-second');
  assert.equal(layoutRules.stageAutoOpenStream('side', screens, [], false, seen), 'new-second');
  assert.equal(layoutRules.stageAutoOpenStream('focus', screens, [], false, new Set()), 'seen-first');
  assert.equal(layoutRules.stageAutoOpenStream('focus', screens, ['already-watched'], false, seen), null);
  assert.equal(layoutRules.stageAutoOpenStream('side', screens, [], true, seen), null);
  for (const layout of ['auto', 'grid', 'speaker'] as const)
    assert.equal(layoutRules.stageAutoOpenStream(layout, screens, [], false, seen), null);
  assert.equal(layoutRules.stageAutoOpenStream('focus', [], [], false, seen), null);
  assert.equal(layoutRules.stageAutoOpenStream('focus', screens, [], false, new Set(screens)), null,
    'закрытые пользователем известные показы не открываются снова');
});

// Класс ошибки: перебивающий дёргает главную плитку или тишина сбрасывает её без причины.
it('R248 говорящий удерживает себя крупным, а в тишине последний крупный остаётся на месте', () => {
  const prev = { id: 'current', at: 3500 };
  const interrupted = layoutRules.nextStageSpeaker(prev, {
    speakingSince: new Map([['current', 3500], ['interrupter', 4000]]), present: ['current', 'interrupter'], now: 6000,
  });
  assert.deepEqual(interrupted, prev);
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, { speakingSince: new Map(), present: ['current', 'interrupter'], now: 9000 }), prev);
  assert.deepEqual(layoutRules.nextStageSpeaker({ id: null, at: 0 }, { speakingSince: new Map(), present: ['first', 'second'], now: 5000 }), { id: 'first', at: 0 });
  assert.deepEqual(layoutRules.nextStageSpeaker({ id: 'first', at: 0 }, {
    speakingSince: new Map([['second', 5000]]), present: ['first', 'second'], now: 5600,
  }), { id: 'second', at: 5600 }, 'запас с at:0 не держит первый настоящий голос ещё 1500 мс');
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, { speakingSince: new Map([['stranger', 0]]), present: [], now: 9000 }), { id: null, at: 0 });
});

// Класс ошибки: кандидат выхватывает фокус до 600 мс речи или не проходит точную границу в 600 мс.
it('R248 кандидат проходит minTalk ровно в 600 мс, но не за 1 мс до границы', () => {
  const prev = { id: 'current', at: 0 };
  const input = (since: number) => ({ speakingSince: new Map([['candidate', since]]), present: ['current', 'candidate'], now: 2000 });
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, input(1401)), prev); // 599 мс.
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, input(1400)), { id: 'candidate', at: 2000 }); // ровно 600 мс.
});

// Класс ошибки: гистерезис смены срабатывает на 1 мс раньше либо блокирует ровно допустимую смену.
it('R248 смена ждёт 1500 мс с прошлой, затем проходит на самой границе удержания', () => {
  const prev = { id: 'current', at: 1000 };
  const input = (now: number) => ({ speakingSince: new Map([['candidate', 1000]]), present: ['current', 'candidate'], now });
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, input(2499)), prev); // hold 1499 мс.
  assert.deepEqual(layoutRules.nextStageSpeaker(prev, input(2500)), { id: 'candidate', at: 2500 }); // hold 1500 мс.
});

// Класс ошибки: ушедший спикер продолжает занимать фокус из-за hold, хотя его слот освободился.
it('R248 ушедший крупный освобождает место сразу, не дожидаясь его старого hold', () => {
  const next = layoutRules.nextStageSpeaker({ id: 'left-scene', at: 1950 }, {
    speakingSince: new Map([['candidate', 1000]]), present: ['candidate'], now: 2000,
  });
  assert.deepEqual(next, { id: 'candidate', at: 2000 });
});

// Класс ошибки: выбирается самый недавно начавший говорить, а не тот, кто говорит дольше всех.
it('R248 из подходящих говорящих крупно выбирается дольше всех говорящий', () => {
  const next = layoutRules.nextStageSpeaker({ id: 'old-focus', at: 0 }, {
    speakingSince: new Map([['newer', 1500], ['longest', 800]]), present: ['old-focus', 'newer', 'longest'], now: 2500,
  });
  assert.deepEqual(next, { id: 'longest', at: 2500 });
});

// Класс ошибки: пересчёт назначается не на minTalk/hold deadline либо пропускается, пока ждут нового события.
it('R248 recheck ждёт более поздний из minTalk и hold, а ненужный пересчёт возвращает null', () => {
  const current = { id: 'current', at: 1000 };
  const input = { speakingSince: new Map([['candidate', 700]]), present: ['current', 'candidate'], now: 800 };
  assert.equal(layoutRules.stageSpeakerRecheckMs(current, input), 1700); // minTalk до 1300, hold до 2500.
  assert.equal(layoutRules.stageSpeakerRecheckMs(current, { ...input, now: 2400 }), 100);
  assert.equal(layoutRules.stageSpeakerRecheckMs(current, { ...input, speakingSince: new Map([['current', 500]]) }), null);
  assert.equal(layoutRules.stageSpeakerRecheckMs(current, { ...input, speakingSince: new Map() }), null);
  const fresh = { speakingSince: new Map([['candidate', 9900]]), present: ['current', 'candidate'], now: 10_000 };
  assert.equal(layoutRules.stageSpeakerRecheckMs({ id: 'current', at: 0 }, fresh), 500, 'возраст речи может быть более поздним сроком, чем hold');
  assert.equal(layoutRules.stageSpeakerRecheckMs({ id: null, at: 0 }, { ...fresh, now: 10_500 }), 0, 'готовому кандидату без текущего не добавляется hold');
  assert.equal(layoutRules.stageSpeakerRecheckMs({ id: null, at: 0 }, { ...fresh, now: 12_000 }), 0, 'просроченный срок не становится отрицательным');
});

// Класс ошибки: гистерезис, минимальная речь, удержание текущего, резерв at=0 или выбор лучшего кандидата регрессируют.
it('R248 мутанты hold, minTalk, удержания, fallback at=now и newest candidate убиваются', () => {
  const hold = (r: Rules) => {
    const prev = { id: 'current', at: 1000 };
    assert.equal(r.nextStageSpeaker(prev, { speakingSince: new Map([['candidate', 1000]]), present: ['current', 'candidate'], now: 2499 }).id, 'current');
  };
  mutation('inp.now - cur.at >= hold', 'true', hold);

  const minTalk = (r: Rules) => {
    const prev = { id: 'current', at: 0 };
    assert.equal(r.nextStageSpeaker(prev, { speakingSince: new Map([['candidate', 1401]]), present: ['current', 'candidate'], now: 2000 }).id, 'current');
  };
  mutation('inp.now - cand.since >= minTalk', 'true', minTalk);

  const keepCurrent = (r: Rules) => {
    const prev = { id: 'current', at: 0 };
    const next = r.nextStageSpeaker(prev, { speakingSince: new Map([['current', 500], ['candidate', 0]]), present: ['current', 'candidate'], now: 2000 });
    assert.equal(next.id, prev.id); assert.equal(next.at, prev.at);
  };
  mutation('if (cur.id && inp.speakingSince.has(cur.id)) return cur;', 'if (false) return cur;', keepCurrent);

  const fallback = (r: Rules) => {
    const next = r.nextStageSpeaker({ id: null, at: 0 }, { speakingSince: new Map(), present: ['first'], now: 5000 });
    assert.equal(next.id, 'first'); assert.equal(next.at, 0);
  };
  mutation('return first === prev.id && prev.at === 0 ? prev : { id: first, at: 0 };', 'return first === prev.id && prev.at === 0 ? prev : { id: first, at: inp.now };', fallback);

  const longest = (r: Rules) => assert.equal(r.nextStageSpeaker({ id: 'gone', at: 0 }, {
    speakingSince: new Map([['newer', 1500], ['longest', 800]]), present: ['newer', 'longest'], now: 2500,
  }).id, 'longest');
  mutation('if (!best || since < best.since) best = { id, since };', 'if (!best || since > best.since) best = { id, since };', longest);
});
