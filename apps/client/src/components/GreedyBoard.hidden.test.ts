import assert from 'node:assert/strict';
import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as practice from '../duelPractice';
import * as rules from '../duelRules';
import * as wheel from '../wheelRules';
import { React, environment, load, sourceOf } from './R171.phoneHarness';

const source = sourceOf('DuelScene');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.parse('2026-10-29T12:00:00Z');
const noop = () => {};
type Edit = readonly [string, string];
type Side = shared.DuelSide;
interface Props {
  duel: shared.DuelDto; skew: number; mySide: Side | null; people: (id: string) => { name: string; avatar: null };
  now: number; busy: boolean; phone: boolean; coin: React.ReactNode; onMove: (m: 'roll' | 'stop') => void;
}
// Предохранитель — ошибка самого прогона, не ожидаемое нарушение проверяемого правила.
// Его нельзя принять за успешный kill: paired ниже принимает только адресные AssertionError.
class BoardBudgetExceeded extends Error {
  constructor(part: string) { super(`R359/board/budget/${part}`); this.name = 'BoardBudgetExceeded'; }
}
function exposeBoard(raw: string) {
  const ast = ts.createSourceFile('DuelScene.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'GreedyBoard').length, 1,
    'R356/board/setup/настоящий GreedyBoard');
  // Добавлен только экспорт AST: исполняется весь DuelScene вместе с Die/Duelist/useFresh и настоящими хуками.
  const extra = ts.factory.createExportDeclaration(undefined, false,
    ts.factory.createNamedExports([ts.factory.createExportSpecifier(false, undefined, 'GreedyBoard')]));
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, [...ast.statements, extra]));
}
function fixture(raw: string) {
  let clock = now, serial = 0;
  const spent = { hooks: 0, setters: 0, timers: 0, steps: 0, renders: 0 };
  function consume(part: keyof typeof spent) {
    if (++spent[part] > 200) throw new BoardBudgetExceeded(part);
  }
  const setters = new WeakMap<Function, Function>();
  const limitedReact = { ...React,
    useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
      // Входы в useState ограничивают и внутренние повторные рендеры GreedyBoard/Duelist,
      // которые не видны счётчику явных render(). Настоящий React по-прежнему держит состояние.
      consume('hooks');
      const [value, setValue] = React.useState<T>(initial);
      let limited = setters.get(setValue) as React.Dispatch<React.SetStateAction<T>> | undefined;
      if (!limited) {
        limited = (next) => { consume('setters'); setValue(next); };
        setters.set(setValue, limited);
      }
      // Как у React, dispatch сохраняет идентичность между рендерами — обёртка не создаёт новых зависимостей эффектов.
      return [value, limited];
    },
  };
  const timers = new Map<number, { at: number; cb: () => void }>();
  const fakeWindow = { setTimeout(cb: () => void, ms = 0) { consume('timers'); const id = ++serial; timers.set(id, { at: clock + ms, cb }); return id; },
    clearTimeout(id: number) { timers.delete(id); } };
  const useStore = Object.assign(() => { throw new Error('R356/board/setup/неожиданный селектор'); },
    { getState: () => ({ selfDeafened: true }) });
  const forbidden = () => { throw new Error('R356/board/setup/неожиданный API'); };
  const module = load<{ GreedyBoard: React.ComponentType<Props> }>(new URL('./DuelScene.tsx', import.meta.url), exposeBoard(raw), {
    react: limitedReact,
    '@gusvoice/shared': shared, '../duelRules': rules, '../duelPractice': practice, '../wheelRules': wheel,
    '../store': { useStore }, '../api': { api: new Proxy({}, { get: () => forbidden }) },
    '../benchMock': { isMockEconomy: () => false }, '../economyClient': { ensureDuel: forbidden },
    '../phoneLayout': { usePhoneLayout: () => false }, '../sounds': { playSound: noop },
    '../assets/guscoin.svg': { default: '/coin.svg' }, '../assets/duel/judge.png': { default: '/judge.png' },
    '../assets/duel/duelist.png': { default: '/duelist.png' }, '../assets/duel/duelist-sash.png': { default: '/sash.png' },
    './Avatar': { Avatar: ({ name }: { name: string }) => React.createElement('span', { 'data-avatar': name }) },
    './BottomSheet': { BottomSheet: forbidden }, './Icon': { Icon: () => React.createElement('i') },
    './Duel': { CountRing: () => React.createElement('i'), applyDuelReply: forbidden, duelFailText: forbidden,
      useDuelPeople: forbidden, useNowTick: forbidden },
  }, { window: fakeWindow });
  return {
    beforeRender: () => consume('renders'),
    board: (duel: shared.DuelDto, mySide: Side | null = 'challenger') => React.createElement(module.GreedyBoard,
      { duel, mySide, skew: 0, now: clock, busy: false, phone: false, coin: null, onMove: noop,
        people: (id: string) => ({ name: id === 'me' ? 'Игрок' : 'Капитан', avatar: null }) }),
    async advance(ms: number) {
      clock += ms;
      await React.act(async () => {
        for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= clock) {
          consume('steps'); timers.delete(id); t.cb();
        }
      });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Check = (f: Fixture, host: HTMLDivElement, render: (n: React.ReactNode) => Promise<void>) => Promise<void>;
async function run(raw: string, check: Check) {
  await environment(async (host, render) => {
    const f = fixture(raw);
    await check(f, host, async element => { f.beforeRender(); await render(element); });
  });
}
function paired(title: string, check: Check, ...edits: Edit[]) {
  it(title, async () => {
    await run(source, check);
    await counterfact(async () => { for (const [from, to] of edits) {
      assert.equal(source.split(from).length - 1, 1, 'R356/board/setup/единственная игла');
      await assert.rejects(run(source.replace(from, to), check),
        e => !(e instanceof BoardBudgetExceeded) && e instanceof assert.AssertionError && e.message.startsWith('R356/board/check/'),
        'контрфакт падает на адресном поведении, не на настройке/загрузке');
      await run(source, check);
    } });
  });
}
function full(): shared.DuelDto {
  const d = practice.practiceStart('greedy', 'me', now, { unit: () => 0, die: () => 6 }).duel;
  return { ...d, id: 'r356-board', greedy: { ...d.greedy!, scores: { challenger: 7, target: 9 },
    turn: 'target', turnPoints: 5, seq: 5, rolls: [3, 4, 4, 5, 5], lastRoll: { by: 'target', die: 5 } } };
}
const masked = (d: shared.DuelDto, viewer: Side | null = 'challenger') => ({ ...d, greedy: shared.greedyHide(d.greedy!, viewer) });
function one<T extends Element>(host: ParentNode, selector: string): T {
  const all = host.querySelectorAll<T>(selector);
  assert.equal(all.length, 1, `R356/board/check/один ${selector}`); return all[0];
}
function player(host: ParentNode, side: Side): HTMLElement {
  return one(host, `.dc-figure.${side}`).parentElement!;
}

for (const viewer of ['challenger', 'target', null] as const) {
  paired(`R356 настоящий GreedyBoard: ${viewer ?? 'зритель'} видит знак вопроса и пустую secret-полосу только у скрытой стороны`, async (f, host, render) => {
    const d = masked(full(), viewer); await render(f.board(d, viewer));
    for (const side of ['challenger', 'target'] as const) {
      const p = player(host, side), hidden = side !== viewer;
      assert.equal(p.classList.contains('secret'), hidden, 'R356/board/check/сторона маски');
      const score = one(p, '.gr-score');
      if (hidden) {
        assert.equal(score.firstChild?.textContent, '?', 'R356/board/check/вопрос вместо ложного нуля');
        assert.equal(one(score, 'small').textContent, 'скрыт до конца', 'R356/board/check/объяснение маски');
        assert.equal(score.getAttribute('title'), 'Счёт скрыт до конца партии', 'R356/board/check/подсказка');
        assert.equal(one(p, '.gr-bar').classList.contains('secret'), true, 'R356/board/check/secret-полоса');
        assert.equal(one<HTMLElement>(p, '.gr-bar-fill').style.width, '0%', 'R356/board/check/полоса без заполнения');
        assert.equal(p.querySelectorAll('.gr-bar-bank').length, 0, 'R356/board/check/копилка не выдаётся полосой');
      } else {
        assert.equal(score.firstChild?.textContent, String(d.greedy!.scores[side]), 'R356/board/check/свой счёт открыт');
        assert.equal(p.querySelectorAll('.gr-bar.secret').length, 0, 'R356/board/check/своя полоса обычная');
      }
    }
    assert.equal(host.querySelectorAll('.gr-reveal').length, 0, 'R356/board/check/до решения нет раскрытия');
    assert.equal(one(host, '.gr-bank b').textContent, d.greedy!.hidden!.target ? '?' : '5', 'R356/board/check/копилка скрытого хода');
  }, ['g.hidden?.[side] === true', 'false'],
  ["className={`gr-bar${hide ? ' secret' : ''}`}", 'className="gr-bar"'],
  ...(viewer !== 'target' ? [["{secret(g.turn) ? '?' : g.turnPoints}", '{g.turnPoints}'] as const] : []));
}

paired('R356 своя копилка и кнопки остаются числовыми: маска не ломает собственный ход', async (f, host, render) => {
  const d = full(); d.greedy!.turn = 'challenger'; d.greedy!.lastRoll = { by: 'challenger', die: 5 };
  await render(f.board(masked(d)));
  assert.equal(one(host, '.gr-bank b').textContent, '5', 'R356/board/check/своя копилка');
  assert.equal(one(player(host, 'challenger'), '.gr-score-bank').textContent, '+5', 'R356/board/check/прибавка к своему счёту');
  assert.equal(one<HTMLElement>(player(host, 'challenger'), '.gr-bar-bank').style.width, '25%', 'R356/board/check/полоса своей копилки');
  assert.deepEqual([...host.querySelectorAll('.gr-actions button')].map(b => b.textContent?.trim()), ['Бросить ещё', 'Стоп, забрать 5'],
    'R356/board/check/числовые действия');
}, ["const bank = turn && !hide ? g.turnPoints : 0;", 'const bank = 0;']);

paired('R356 чужая единица показывает Сгорело без суммы, собственная — настоящую сумму', async (f, host, render) => {
  for (const by of ['target', 'challenger'] as const) {
    const d = full(); d.id += by; d.greedy!.lastRoll = { by, die: 1 }; d.greedy!.burned = 8;
    d.greedy!.turn = by === 'target' ? 'challenger' : 'target';
    d.greedy!.turnPoints = 0; d.greedy!.rolls.push(1);
    await render(f.board(masked(d)));
    const burn = one(host, '.gr-burn');
    assert.equal(burn.firstChild?.textContent, by === 'target' ? 'Сгорело!' : 'Сгорело 8!', 'R356/board/check/сумма только своя');
    assert.equal(burn.textContent?.includes('пожадничал — ход переходит'), true, 'R356/board/check/смысл сгорания сохранён');
    assert.equal(host.querySelectorAll('.gr-stop').length, 0, 'R356/board/check/единица — не стоп');
  }
}, ["'Сгорело!' : 'Единица!'", "'Сгорело 0!' : 'Единица!'"]);

paired('R356 смена хода без нового броска показывает Забрал, не раскрывая сумму соперника', async (f, host, render) => {
  const d = full(); await render(f.board(masked(d)));
  assert.equal(host.querySelectorAll('.gr-stop').length, 0, 'R356/board/check/нет выдуманного стопа при первом снимке');
  const stopped: shared.DuelDto = { ...d, greedy: { ...d.greedy!, seq: d.greedy!.seq + 1, turn: 'challenger', turnPoints: 0,
    scores: { ...d.greedy!.scores, target: 14 } } };
  await render(f.board(masked(stopped)));
  const stop = one(host, '.gr-stop');
  assert.equal(stop.firstChild?.textContent?.trim(), 'Забрал!', 'R356/board/check/стоп виден');
  assert.equal(stop.textContent?.includes('Капитан остановился — ход переходит'), true, 'R356/board/check/автор стопа');
  assert.equal(/\d/.test(stop.textContent ?? ''), false, 'R356/board/check/стоп без чужой суммы');
  const rolled: shared.DuelDto = { ...stopped, greedy: { ...stopped.greedy!, seq: stopped.greedy!.seq + 1,
    rolls: [...stopped.greedy!.rolls, 3], turnPoints: 3, lastRoll: { by: 'challenger', die: 3 } } };
  await render(f.board(masked(rolled)));
  // При ожидаемом падении stale-stop мутанта форматируем только 0/1. Сам DOM-узел содержит циклическое
  // React/happy-dom дерево; его диагностическое сравнение с null способно исчерпать память раньше вывода ошибки.
  assert.equal(host.querySelectorAll('.gr-stop').length, 0, 'R356/board/check/следующий бросок убрал старый стоп');
  await f.advance(shared.DUEL_ROLL_ANIM_MS);
}, ['g.turn !== p.turn) setStopped', 'false) setStopped'],
['stopped.seq === g.seq', 'true']);

paired('R356 раскрытие на решении получает только прежде скрытая сторона; новая партия сбрасывает память', async (f, host, render) => {
  const d = full(); await render(f.board(masked(d)));
  const next: shared.DuelDto = { ...d, greedy: { ...d.greedy!, seq: 6, scores: { challenger: 7, target: 14 } } };
  await render(f.board(masked(next)));
  assert.equal(host.querySelectorAll('.gr-reveal').length, 0, 'R356/board/check/середина игры без раскрытия');
  const decided: shared.DuelDto = { ...next, moveUntil: null, greedy: { ...next.greedy!, scores: { challenger: 7, target: 23 } } };
  await render(f.board(decided));
  assert.equal(player(host, 'target').classList.contains('gr-reveal'), true, 'R356/board/check/раскрыт бывший секрет');
  assert.equal(player(host, 'challenger').classList.contains('gr-reveal'), false, 'R356/board/check/свой счёт не раскрывается повторно');
  assert.equal(one(player(host, 'target'), '.gr-score').firstChild?.textContent, '23', 'R356/board/check/полный итог');
  await render(f.board({ ...decided, state: 'settled', winnerId: decided.targetId }));
  assert.equal(host.querySelectorAll('.gr-reveal').length, 1, 'R356/board/check/итог одной стороны');
  await render(f.board({ ...decided, id: 'another-game', state: 'playing', moveUntil: d.moveUntil }));
  assert.equal(host.querySelectorAll('.gr-reveal').length, 0, 'R356/board/check/новый id без старой памяти');
}, ['const revealed = !hide && wasHidden.current[side];', 'const revealed = !hide;'],
['const revealed = !hide && wasHidden.current[side];', 'const revealed = wasHidden.current[side];'],
["if (wasHidden.current.id !== d.id) wasHidden.current = { id: d.id, challenger: false, target: false };", '']);

paired('R356 старый DTO без hidden сразу рисует оба числа, копилку и кубик без анимации раскрытия', async (f, host, render) => {
  const d = full(); await render(f.board(d));
  assert.equal(host.querySelectorAll('.secret, .gr-reveal').length, 0, 'R356/board/check/старый DTO не секретный');
  assert.deepEqual([...host.querySelectorAll('.gr-score')].map(e => e.firstChild?.textContent), ['7', '9'], 'R356/board/check/оба числа прежние');
  assert.equal(one(host, '.gr-bank b').textContent, '5', 'R356/board/check/копилка прежняя');
  assert.equal(host.querySelectorAll('.dc-die.unknown').length, 0, 'R356/board/check/кость открыта');
  assert.equal(one<HTMLElement>(host, '.dc-cube').style.transform, rules.DIE_FACE_ROT[5], 'R356/board/check/настоящая грань');
}, ['g.hidden?.[side] === true', 'g.hidden?.[side] !== false']);

// CSSOM браузера разбирает настоящий целый styles.css; комментарий/упоминание вне media не считается защитой.
function reducedRules(raw: string): CSSStyleRule[] {
  const sheet = new window.CSSStyleSheet(); sheet.replaceSync(raw);
  const out: CSSStyleRule[] = [];
  const visit = (list: CSSRuleList, reduce = false) => {
    for (const rule of Array.from(list)) {
      if (rule.type === 4) {
        const media = rule as CSSMediaRule;
        visit(media.cssRules, reduce || /\(prefers-reduced-motion:\s*reduce\)/.test(media.conditionText));
      } else if (reduce && rule.type === 1) out.push(rule as CSSStyleRule);
    }
  };
  visit(sheet.cssRules); return out;
}
for (const [selector, property] of [['.gr-reveal .gr-score', 'animation'], ['.gr-reveal .gr-bar-fill', 'transition']] as const) {
  it(`R356 prefers-reduced-motion отключает ${property} у ${selector}`, async () => {
    const check = (raw: string) => {
      const matching = reducedRules(raw).filter(r => r.selectorText.split(',').some(s => s.trim() === selector));
      assert.ok(matching.some(r => r.style.getPropertyValue(property).trim() === 'none'), 'R356/css/check/движение раскрытия выключено');
    };
    await environment(async () => {
      check(css);
      counterfact(() => {
      const needle = property === 'animation' ? '  .gr-reveal .gr-score {\n    animation: none;' : '  .gr-reveal .gr-bar-fill {\n    transition: none;';
      assert.equal(css.split(needle).length - 1, 1, 'R356/css/setup/единственное reduced правило');
      assert.throws(() => check(css.replace(needle, needle.replace(selector, '.r356-removed'))),
        e => e instanceof assert.AssertionError && e.message.startsWith('R356/css/check/'), 'не ловить ошибку парсера вместо отсутствующей защиты');
      });
      check(css);
    });
  });
}
