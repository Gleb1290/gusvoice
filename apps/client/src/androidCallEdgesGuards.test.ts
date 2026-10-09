import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const kotlinRoot = '../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/';
const ask = readFileSync(new URL(`${kotlinRoot}FullScreenAsk.kt`, import.meta.url), 'utf8');
const incoming = readFileSync(new URL(`${kotlinRoot}IncomingCallActivity.kt`, import.meta.url), 'utf8');

// Стражи исходника, не запуск Kotlin и не перевод shouldAsk на JavaScript.
// // в строках (например URI настроек) не должен превращаться в комментарий.
function code(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith('/') ? ' ' : token);
}

function body(source: string, name: string): string {
  const clean = code(source);
  const open = new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(clean);
  assert.ok(open, `найдена функция ${name}`);
  const start = open.index + open[0].length;
  let depth = 1;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = start;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(start, token.index);
  }
  assert.fail(`закрыта функция ${name}`);
}

function rejects(source: string, target: string, replacement: string, check: (source: string) => void) {
  check(source);
  assert.equal(source.split(target).length - 1, 1, 'контрфакт меняет одно место исходника');
  const mutant = source.replace(target, replacement);
  assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), assert.AssertionError);
}

function askClauses(source: string): string[] {
  const clean = code(source);
  const expression = /fun\s+shouldAsk\s*\(sdk:\s*Int,\s*canFullScreen:\s*Boolean,\s*asked:\s*Boolean,\s*loggedIn:\s*Boolean\):\s*Boolean\s*=\s*([^\r\n]+)/.exec(clean);
  assert.ok(expression, 'проверяется настоящая формула shouldAsk, не пояснение рядом');
  return expression[1]!.trim().replace(/\s+/g, ' ').split(' && ');
}

function buttonBody(source: string, kind: 'Positive' | 'Negative', label: string): string {
  const clean = body(source, 'maybeAsk');
  const marker = `.set${kind}Button("${label}")`;
  assert.equal(clean.split(marker).length - 1, 1, 'найдена нужная кнопка самого диалога');
  const start = clean.indexOf('{', clean.indexOf(marker) + marker.length);
  assert.ok(start >= 0);
  let depth = 1;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = start + 1;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(start + 1, token.index);
  }
  assert.fail('замкнут обработчик кнопки');
}

it('R132 кнопка «Настройки» открывает право FSI, но не запоминает KEY_ASKED', () => {
  // Возврат из настроек без выданного права должен снова предложить включить полноэкранный звонок.
  const check = (source: string) => {
    const settings = buttonBody(source, 'Positive', 'Настройки');
    assert.match(settings, /activity\.startActivity\(/);
    assert.match(settings, /Settings\.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT/);
    assert.doesNotMatch(settings, /\b(?:putBoolean|remove)\s*\(\s*KEY_ASKED\b/);
  };
  rejects(ask, '.setPositiveButton("Настройки") { _, _ ->',
    '.setPositiveButton("Настройки") { _, _ ->\n prefs.edit().putBoolean(KEY_ASKED, true).apply()', check);
});

it('R132 «Не сейчас» сохраняет KEY_ASKED=true, закрытие диалога лишь отпускает showing', () => {
  // Парный принимающий сценарий: явный отказ прекращает будущие вопросы, случайное закрытие — нет.
  const check = (source: string) => {
    assert.match(buttonBody(source, 'Negative', 'Не сейчас'), /prefs\.edit\(\)\.putBoolean\(KEY_ASKED, true\)\.apply\(\)/);
    const maybe = body(source, 'maybeAsk');
    assert.match(maybe, /\.setOnDismissListener\s*\{\s*showing = false\s*\}/);
    assert.equal([...maybe.matchAll(/\.putBoolean\(KEY_ASKED, true\)/g)].length, 1, 'флаг пишет только явный отказ');
  };
  rejects(ask, '.setNegativeButton("Не сейчас") { _, _ -> prefs.edit().putBoolean(KEY_ASKED, true).apply() }',
    '.setNegativeButton("Не сейчас") { _, _ -> }', check);
  rejects(ask, '.setOnDismissListener { showing = false }',
    '.setOnDismissListener { showing = false; prefs.edit().putBoolean(KEY_ASKED, true).apply() }', check);
});

it('R128 предложение полного экрана начинается с SDK 34, SDK 33 исключён до проверки флагов', () => {
  // Android 13 не имеет этого запроса разрешения: ошибочный порог отправлял бы человека в чужие настройки.
  const check = (source: string) => {
    assert.equal(askClauses(source)[0], 'sdk >= 34');
    assert.equal(askClauses(source).length, 4);
  };
  for (const threshold of ['33', '35']) rejects(ask, 'sdk >= 34', `sdk >= ${threshold}`, check);
  rejects(ask, 'sdk >= 34', 'sdk > 34', check);
});

it('R128 все восемь сочетаний флагов охвачены конъюнкцией: вход есть, разрешения нет, ещё не спрашивали', () => {
  // Статически закрепляем полную формулу таблицы 33/34 × canFullScreen × asked × loggedIn:
  // SDK 33 — всегда нет; SDK 34 — только false/false/true. Kotlin в Node не исполняется.
  const check = (source: string) => {
    assert.deepEqual(askClauses(source), ['sdk >= 34', '!canFullScreen', '!asked', 'loggedIn']);
  };
  rejects(ask, ' && !asked', '', check);
  rejects(ask, '!canFullScreen', 'canFullScreen', check);
  rejects(ask, ' && loggedIn', '', check);
  rejects(ask, ' && !asked', ' || !asked', check);
});

it('R128 реальное разрешение, сохранённый asked и наличие входа переданы в shouldAsk до показа', () => {
  // Верная чистая формула бесполезна, если экран входа или сохранённый отказ обходят её через подставные флаги.
  const check = (source: string) => {
    const maybe = body(source, 'maybeAsk');
    assert.match(maybe, /shouldAsk\(\s*Build\.VERSION\.SDK_INT,\s*CallNotifier\.canFullScreen\(activity\),\s*prefs\.getBoolean\(KEY_ASKED, false\),\s*NotifAuth\.forUser\(activity, ""\) != null,\s*\)/);
    assert.match(maybe, /if \(!ask\) return\s*showing = true\s*AlertDialog\.Builder/);
  };
  rejects(ask, 'prefs.getBoolean(KEY_ASKED, false)', 'false', check);
  rejects(ask, 'NotifAuth.forUser(activity, "") != null', 'true', check);
  rejects(ask, 'if (!ask) return', '', check);
});

it('R128 входящий звонок ставит зелёный ответ слева, красный отказ справа', () => {
  // Возврат прежнего порядка провоцирует случайное отклонение звонка привычным нажатием на левую кнопку.
  const check = (source: string) => {
    assert.match(code(source), /const val ANSWER_LEFT = true\b/);
    const build = body(source, 'build');
    assert.match(build, /val answerLeft = ANSWER_LEFT/);
    assert.match(build, /val declineBtn = round\(R\.drawable\.ic_call_end, DANGER, "Отклонить"\) \{ decline\(call\) \}/);
    assert.match(build, /val answerBtn = round\(R\.drawable\.ic_stat_call, GREEN, "Ответить"\) \{ answer\(call\) \}/);
    assert.match(build, /root\.addView\(\s*if \(answerLeft\) answerBtn else declineBtn,\s*FrameLayout\.LayoutParams\([^\n]*Gravity\.BOTTOM or Gravity\.START\)\s*\.apply \{ leftMargin = edge; bottomMargin = bottom \}/);
    assert.match(build, /root\.addView\(\s*if \(answerLeft\) declineBtn else answerBtn,\s*FrameLayout\.LayoutParams\([^\n]*Gravity\.BOTTOM or Gravity\.END\)\s*\.apply \{ rightMargin = edge; bottomMargin = bottom \}/);
  };
  rejects(incoming, 'const val ANSWER_LEFT = true', 'const val ANSWER_LEFT = false', check);
  rejects(incoming, 'if (answerLeft) answerBtn else declineBtn,', 'if (answerLeft) declineBtn else answerBtn,', check);
  rejects(incoming, 'Gravity.BOTTOM or Gravity.END', 'Gravity.BOTTOM or Gravity.START', check);
});

it('R128 системные панели и вырез экрана дают все четыре отступа корню входящего звонка', () => {
  // Отступ только снизу спасает навигационную панель, но в ландшафте кнопки попадают под боковой вырез.
  const check = (source: string) => {
    const build = body(source, 'build');
    assert.match(build, /ViewCompat\.setOnApplyWindowInsetsListener\(root\) \{ v, ins ->/);
    assert.match(build, /val bars = ins\.getInsets\(WindowInsetsCompat\.Type\.systemBars\(\) or WindowInsetsCompat\.Type\.displayCutout\(\)\)/);
    assert.match(build, /v\.setPadding\(bars\.left, bars\.top, bars\.right, bars\.bottom\)\s*WindowInsetsCompat\.CONSUMED/);
    assert.ok(build.indexOf('setOnApplyWindowInsetsListener(root)') < build.lastIndexOf('return root'));
  };
  rejects(incoming, ' or WindowInsetsCompat.Type.displayCutout()', '', check);
  rejects(incoming, 'WindowInsetsCompat.Type.systemBars() or ', '', check);
  for (const side of ['left', 'top', 'right', 'bottom']) rejects(incoming, `bars.${side}`, '0', check);
});
