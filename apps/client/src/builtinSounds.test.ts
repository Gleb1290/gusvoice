import assert from 'node:assert/strict';
import { it } from 'node:test';
import ts from 'typescript';
import { load, normal, edited, sourceOf, type Edit } from './predictions.harness';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';

const source = sourceOf('./builtinSounds.ts');
const P = 'R351 вшитые звуки: ';
const expected = {
  'wheel-tick': 'wheelTick', 'wheel-win': 'wheelWin', 'wheel-jackpot': 'wheelJackpot',
  'dice-roll': 'diceRoll', 'duel-win': 'duelWin', 'duel-lose': 'duelLose', 'duel-invite': 'duelInvite',
  'greedy-burn': 'greedyBurn', 'rps-reveal': 'rpsReveal', 'prediction-result': 'predictionResult',
  'prediction-open': 'predictionOpen', 'prediction-closed': 'predictionClosed', 'games-launch': 'gamesLaunch',
};

function fixture(raw: string, files: Record<string, string> = {}) {
  const tree = ts.createSourceFile('builtinSounds.ts', raw, ts.ScriptTarget.Latest, true);
  const globs: ts.CallExpression[] = [];
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'glob' && node.expression.expression.kind === ts.SyntaxKind.MetaProperty) globs.push(node);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  assert.equal(globs.length, 1, 'R351 setup: один IO-вызов Vite glob');
  const glob = globs[0];
  // Подмена только Vite IO; весь модуль, таблица выбора и побочные регистрации исполняются вместе.
  const wholeModule = raw.slice(0, glob.getStart(tree)) + '__testFiles' + raw.slice(glob.end);
  const registered: Array<[string, string]> = [], warmed: string[] = [];
  const listeners: Array<{ name: string; callback: () => void; options: unknown }> = [];
  const api = load<typeof import('./builtinSounds')>(wholeModule, {
    './sounds': {
      registerBuiltinSound: (event: string, url: string) => registered.push([event, url]),
      warmBuiltinSound: (event: string) => warmed.push(event),
    },
  }, { __testFiles: files, window: { addEventListener: (name: string, callback: () => void, options: unknown) => listeners.push({ name, callback, options }) } });
  return { api, registered, warmed, listeners };
}
function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(source, edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}
function test(title: string, check: (raw: string) => void, edits: Edit[]) {
  it(`R351 ${title}`, () => paired(source, check, edits, P));
}

// Ошибка в имени события молча оставит синтез вместо выбранной владельцем записи.
test('каждое разрешённое имя файла отображается в своё событие и регистрируется целым модулем', raw => {
  const files = Object.fromEntries(Object.keys(expected).map(name => [`./assets/sounds/${name}.ogg`, `/assets/${name}.ogg`]));
  const f = fixture(raw, files);
  assert.deepEqual(normal(f.api.BUILTIN_SOUND_FILES), expected, P + 'полная таблица без перепутанных событий');
  assert.deepEqual(normal(f.registered), Object.entries(expected).map(([name, event]) => [event, `/assets/${name}.ogg`]),
    P + 'найденные записи реально зарегистрированы');
}, [["'prediction-open': 'predictionOpen'", "'prediction-open': 'predictionClosed'"],
  ['for (const [event, url] of builtinSoundsFrom(FILES)) registerBuiltinSound(event, url);', 'void FILES;']]);

// Чужое имя — не новое событие; имена прототипа также не должны пройти allowlist.
test('cannon-shot, prototype-имена, неверное расширение и пустой URL пропускаются, соседний mp3 принимается', raw => {
  const f = fixture(raw);
  assert.deepEqual(normal(f.api.builtinSoundsFrom({
    './cannon-shot.mp3': '/cannon.mp3', './constructor.mp3': '/prototype.mp3', './toString.ogg': '/prototype.ogg',
    './wheel-win.wav': '/bad.wav', './wheel-win.MP3': '/bad.mp3', './wheel-win.mp3?x=1': '/bad-query.mp3',
    './games-launch.mp3': '', './prediction-open.mp3': '/seagull.mp3',
  })), [['predictionOpen', '/seagull.mp3']], P + 'только разрешённая запись попала в выборку');
}, [["!Object.prototype.hasOwnProperty.call(BUILTIN_SOUND_FILES, m[1])", 'false'], ['!m || !url ||', '!m ||']]);

// Порядок обхода файлов не должен случайно заменить совместимый с Safari mp3 на ogg.
test('mp3 выигрывает у ogg в обоих порядках обхода, одинокий ogg остаётся допустимым', raw => {
  const f = fixture(raw);
  for (const rows of [
    [['./wheel-win.ogg', '/win.ogg'], ['./wheel-win.mp3', '/win.mp3']],
    [['./wheel-win.mp3', '/win.mp3'], ['./wheel-win.ogg', '/win.ogg']],
  ]) assert.deepEqual(normal(f.api.builtinSoundsFrom(Object.fromEntries(rows))), [['wheelWin', '/win.mp3']], P + 'mp3 не зависит от порядка');
  assert.deepEqual(normal(f.api.builtinSoundsFrom({ './wheel-win.ogg': '/win.ogg' })), [['wheelWin', '/win.ogg']], P + 'ogg без пары принимается');
  assert.deepEqual(normal(f.api.builtinSoundsFrom({})), [], P + 'пустой набор не создаёт регистраций');
}, [['if (!prev || (mp3 && !prev.mp3))', 'if (!prev)'], ['if (!prev || (mp3 && !prev.mp3))', 'if (true)']]);

// Без прогрева трещотка первого вращения останется синтезом: оба первых жеста должны будить именно wheelTick.
test('первый pointerdown и keydown прогревают wheelTick однократно в capture-фазе', raw => {
  const f = fixture(raw);
  assert.deepEqual(f.listeners.map(l => [l.name, normal(l.options)]), [
    ['pointerdown', { once: true, capture: true }], ['keydown', { once: true, capture: true }],
  ], P + 'подписки на первые жесты одноразовые');
  f.listeners.forEach(l => l.callback());
  assert.deepEqual(f.warmed, ['wheelTick', 'wheelTick'], P + 'оба жеста греют трещотку');
}, [["const warm = () => warmBuiltinSound('wheelTick');", "const warm = () => warmBuiltinSound('wheelWin');"]]);
