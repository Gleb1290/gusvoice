import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Это стражи исходников: React/LiveKit не импортируются, Kotlin не исполняется.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const android = '../../desktop/src-tauri/gen/android/app/src/main/';
const native = (name: string) => read(`${android}java/tech/gusik/gusvoice/${name}.kt`);
const voice = read('./components/VoiceConnection.tsx');
const activity = native('MainActivity');
const service = native('VoiceForegroundService');
const receiver = native('VoiceActionReceiver');
const bubble = native('MicBubble');
const manifest = read(`${android}AndroidManifest.xml`);

function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'контрфакт имеет один точный якорь');
  return source.replace(from, to);
}
function rejects(source: string, from: string, to: string, check: (source: string) => void) {
  check(source); // Исправный оригинал обязателен: иначе «убитый мутант» ничего не доказывает.
  assert.throws(() => check(replaceOnce(source, from, to)), assert.AssertionError);
}
function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(n: ts.Node) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }
  visit(node); return found;
}
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function ptt(source: string) {
  const file = ts.createSourceFile('VoiceConnection.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = descendants(file, n => ts.isCallExpression(n) && n.expression.getText() === 'useEffect'
    && !!n.arguments[0] && ts.isArrowFunction(n.arguments[0])
    && descendants(n.arguments[0], c => ts.isVariableDeclaration(c) && c.name.getText() === 'teardownMicPtt').length === 1);
  assert.equal(effects.length, 1, 'найден именно эффект рации с Android-регистрацией');
  const effect = effects[0] as ts.CallExpression;
  const callback = effect.arguments[0] as ts.ArrowFunction;
  assert.ok(ts.isBlock(callback.body));
  const body = callback.body;
  function variable(name: string) {
    const declarations = body.statements.filter(ts.isVariableStatement)
      .flatMap(s => [...s.declarationList.declarations]).filter(d => d.name.getText() === name);
    assert.equal(declarations.length, 1, `одна локальная переменная ${name}`);
    assert.ok(declarations[0].initializer); return declarations[0].initializer;
  }
  function handler(name: string) {
    const value = variable(name); assert.ok(ts.isArrowFunction(value) && ts.isBlock(value.body)); return value.body;
  }
  return { effect, body, variable, handler };
}
function startGuard(source: string) {
  const body = ptt(source).handler('start');
  const first = body.statements[0]; assert.ok(ts.isIfStatement(first));
  assert.equal(compact(first.expression), 'held||!pttCanOpen(selfMuted,selfDeafened)', 'мьют/деафен запрещают открытие до изменения held');
  assert.ok(ts.isReturnStatement(first.thenStatement));
  const open = descendants(body, n => ts.isCallExpression(n)
    && n.expression.getText() === 'room.localParticipant.setMicrophoneEnabled');
  assert.equal(open.length, 1); assert.equal(compact((open[0] as ts.CallExpression).arguments[0]), 'true');
}
function depsGuard(source: string) {
  const deps = ptt(source).effect.arguments[1]; assert.ok(deps && ts.isArrayLiteralExpression(deps));
  for (const dep of ['room', 'selfMuted', 'selfDeafened']) assert.ok(deps.elements.some(e => compact(e) === dep), `эффект пересоздаётся при ${dep}`);
}
function blurGuard(source: string) {
  const body = ptt(source).handler('onBlur');
  assert.equal(body.statements.length, 1);
  const guard = body.statements[0]; assert.ok(ts.isIfStatement(guard));
  assert.equal(compact(guard.expression), '!nativeHeld');
  assert.equal(compact(guard.thenStatement), 'end();'); assert.equal(guard.elseStatement, undefined);
}
function cleanupGuard(source: string) {
  const effect = ptt(source);
  const returns = effect.body.statements.filter(ts.isReturnStatement); assert.equal(returns.length, 1);
  const cleanup = returns[0].expression; assert.ok(cleanup && ts.isArrowFunction(cleanup) && ts.isBlock(cleanup.body));
  const statements = cleanup.body.statements.map(compact);
  const snapshot = statements.indexOf('constopened=held||releaseTimer!=null;');
  const clear = statements.indexOf('clearRelease();');
  assert.ok(snapshot >= 0 && clear > snapshot, 'снимок открытого микрофона берётся до отмены хвоста');
  const closing = cleanup.body.statements.filter(ts.isIfStatement).filter(n => compact(n.expression) === 'opened');
  assert.equal(closing.length, 1);
  assert.equal(compact(closing[0].thenStatement), 'voidroom.localParticipant.setMicrophoneEnabled(false).catch(()=>{});');
  assert.ok(cleanup.body.statements.indexOf(closing[0]) > clear, 'после отмены таймера микрофон закрывается');
}

it('R250 рация не открывает заглушённый микрофон и пересоздаёт обработчики при мьюте/деафене', () => {
  startGuard(voice); depsGuard(voice);
});
it('R250 blur не отпускает рацию, зажатую нативной кнопкой', () => blurGuard(voice));
it('R250 очистка эффекта закрывает зажатый микрофон и активный хвост отпускания', () => cleanupGuard(voice));
for (const [name, from, to, check] of [
  ['обход мьюта', '!pttCanOpen(selfMuted, selfDeafened)', 'selfDeafened', startGuard],
  ['устаревший selfMuted', '[room, selfMuted, selfDeafened]', '[room, selfDeafened]', depsGuard],
  ['безусловный blur', 'if (!nativeHeld) end();', 'end();', blurGuard],
  ['потерянный хвост отпускания', 'const opened = held || releaseTimer != null;', 'const opened = held;', cleanupGuard],
  ['открытие вместо закрытия при cleanup', 'if (opened) void room.localParticipant.setMicrophoneEnabled(false)', 'if (opened) void room.localParticipant.setMicrophoneEnabled(true)', cleanupGuard],
] as const) it(`R250 AST-контрфакт: ${name}`, () => rejects(voice, from, to, check));

// Убираем комментарии, сохраняя строки, их экранирование и длину — позиции блоков остаются исходными.
function code(source: string) {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
}
function closeAt(source: string, at: number, open = '{', close = '}') {
  assert.equal(source[at], open); let depth = 0;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}()]/g; tokens.lastIndex = at;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    if (token[0] === open) depth++;
    if (token[0] === close && --depth === 0) return token.index;
  }
  assert.fail('замкнутый блок Kotlin');
}
function method(source: string, name: string) {
  const clean = code(source), signatures = [...clean.matchAll(new RegExp(`\\bfun\\s+${name}\\s*\\(`, 'g'))];
  assert.equal(signatures.length, 1, `один метод ${name}`);
  const parameters = clean.indexOf('(', signatures[0].index!);
  const after = closeAt(clean, parameters, '(', ')') + 1;
  const at = clean.indexOf('{', after); assert.ok(at >= 0);
  return clean.slice(at + 1, closeAt(clean, at));
}
function manifestGuard(source: string) {
  const clean = source.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...clean.matchAll(/<receiver\b[^>]*>/g)].filter(m => /android:name="\.VoiceActionReceiver"/.test(m[0]));
  assert.equal(entries.length, 1); assert.match(entries[0][0], /\bandroid:exported="false"/);
  assert.match(clean, /<uses-permission\b[^>]*android:name="android\.permission\.SYSTEM_ALERT_WINDOW"[^>]*\/>/);
}
function pendingGuard(source: string) {
  const clean = code(source), calls = [...clean.matchAll(/\bPendingIntent\.(getActivity|getBroadcast)\s*\(/g)];
  assert.equal(calls.length, 2, 'проверяются и открытие приложения, и кнопки уведомления');
  for (const call of calls) {
    const begin = clean.indexOf('(', call.index!);
    const args = clean.slice(begin + 1, closeAt(clean, begin, '(', ')'));
    assert.match(args, /,\s*PendingIntent\.FLAG_IMMUTABLE\s+or\s+PendingIntent\.FLAG_UPDATE_CURRENT\s*,?\s*$/);
  }
  assert.match(method(source, 'buildNotification'), /actionIntent\(VoiceActionReceiver\.ACTION_LEAVE, 3\)/);
}
function whitelistGuard(source: string) {
  const body = method(source, 'onReceive');
  const match = /\bval\s+action\s*=\s*when\s*\(intent\.action\)\s*\{/.exec(body); assert.ok(match);
  const begin = body.indexOf('{', match.index), end = closeAt(body, begin);
  assert.deepEqual(body.slice(begin + 1, end).trim().split('\n').map(s => s.trim()).filter(Boolean), [
    'ACTION_TOGGLE_MUTE -> "toggle-mute"', 'ACTION_TOGGLE_DEAFEN -> "toggle-deafen"', 'ACTION_LEAVE -> "leave"', 'else -> return',
  ], 'только три фиксированные строки; неизвестный Intent выходит до JS');
  const dispatch = [...body.matchAll(/MainActivity\.sendMicAction\(([^)]*)\)/g)];
  assert.equal(dispatch.length, 1); assert.equal(dispatch[0][1], 'action');
  assert.ok(dispatch[0].index! > end, 'отправка идёт только после закрытого when');
}
function bridgeGuard(source: string) {
  const clean = code(source);
  const bridge = /\binner\s+class\s+NativeBridge\s*\{/.exec(clean); assert.ok(bridge);
  const at = clean.indexOf('{', bridge.index), body = clean.slice(at + 1, closeAt(clean, at));
  assert.match(body, /@JavascriptInterface\s+fun\s+micState\(json:\s*String\)\s*\{/);
  assert.match(method(body, 'micState'), /VoiceForegroundService\.updateMicState\(this@MainActivity, json\)/);
  assert.match(method(source, 'sendMicAction'), /wv\.evaluateJavascript\("window\.__gvMicAction && window\.__gvMicAction\('\$action'\)", null\)/);
}
it('R250/R251 манифест закрывает receiver и объявляет право поверх приложений', () => manifestGuard(manifest));
it('R250 оба PendingIntent уведомления immutable, кнопка выхода ведёт в закрытый receiver', () => pendingGuard(service));
it('R250 неизвестный Intent выходит до отправки в JS, три известных действия имеют фиксированные строки', () => whitelistGuard(receiver));
it('R250 micState доступен настоящему NativeBridge через JavascriptInterface', () => bridgeGuard(activity));
for (const [name, source, from, to, check] of [
  ['экспорт приёмника', manifest, 'android:name=".VoiceActionReceiver"\n            android:exported="false"', 'android:name=".VoiceActionReceiver"\n            android:exported="true"', manifestGuard],
  ['изменяемое действие уведомления', service, 'PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,\n  )', 'PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,\n  )', pendingGuard],
  ['сырой Intent проходит в JS', receiver, 'else -> return', 'else -> intent.action ?: return', whitelistGuard],
  ['обход отфильтрованного action', receiver, 'MainActivity.sendMicAction(action)', 'MainActivity.sendMicAction(intent.action ?: "")', whitelistGuard],
  ['аннотация только в комментарии', activity, '@JavascriptInterface\n    fun micState', '// @JavascriptInterface\n    fun micState', bridgeGuard],
] as const) it(`R250 Kotlin-контрфакт: ${name}`, () => rejects(source, from, to, check));

function showGuard(source: string) {
  const clean = code(source);
  const rule = /\bfun\s+shouldShow\s*\([^)]*\)\s*:\s*Boolean\s*=\s*([^\n]+)/.exec(clean); assert.ok(rule);
  assert.deepEqual(rule[1].trim().split(/\s*&&\s*/), ['inVoice', 'enabled', '!hidden', 'canDraw', '!appForeground']);
  const sync = method(source, 'sync');
  assert.match(sync, /val show = shouldShow\(next != null, isEnabled\(ctx\), isHidden\(ctx\), canDraw\(ctx\), appForeground\)/);
  assert.match(sync, /if\s*\(!show\)\s*\{\s*remove\(\)\s*return\s*\}/);
  assert.match(clean, /fun canDraw\(ctx: Context\): Boolean = Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.M \|\| Settings\.canDrawOverlays\(ctx\)/);
}
function windowsGuard(source: string) {
  const clean = code(source);
  // Строки с именами методов в журналах не считаются вызовами.
  const masked = clean.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, s => ' '.repeat(s.length));
  const safe: Array<[number, number]> = [];
  for (const start of masked.matchAll(/\btry\s*\{/g)) {
    const begin = masked.indexOf('{', start.index!), end = closeAt(masked, begin);
    if (/^\s*catch\s*\(\w+\s*:\s*(?:RuntimeException|Exception|Throwable)\s*\)\s*\{/.test(masked.slice(end + 1))) safe.push([begin, end]);
  }
  const calls = [...masked.matchAll(/\bwm\.(addView|removeView|updateViewLayout)\s*\(/g)];
  assert.ok(calls.length >= 5, 'проверяются окна пузыря, крестика и перемещение');
  assert.deepEqual(new Set(calls.map(c => c[1])), new Set(['addView', 'removeView', 'updateViewLayout']));
  for (const call of calls) assert.ok(safe.some(([begin, end]) => call.index! > begin && call.index! < end), `вызов ${call[1]} защищён catch от отозванного разрешения`);
}
function foregroundGuard(source: string) {
  assert.match(method(source, 'onPause'), /VoiceForegroundService\.setAppForeground\(false\)/);
  assert.match(method(source, 'onResume'), /VoiceForegroundService\.setAppForeground\(true\)/);
}
function hiddenGuard(source: string) {
  const update = method(source, 'updateMicState');
  assert.match(update, /if\s*\(inVoice && !lastInVoice\)\s+MicBubble\.setHidden\(app, false\)\s+lastInVoice = inVoice/);
  assert.ok(update.indexOf('MicBubble.setHidden(app, false)') < update.indexOf('live?.syncBubble()'), 'новый вход снимает hidden до синхронизации');
}
it('R251 пузырь показывается только при всех пяти условиях и реальном разрешении системы', () => showGuard(bubble));
it('R251 каждый вызов WindowManager защищён try/catch при отзыве разрешения', () => windowsGuard(bubble));
it('R251 уход/возврат активности передаёт false/true в состояние пузыря', () => {
  foregroundGuard(activity);
  assert.match(method(service, 'setAppForeground'), /MicBubble\.appForeground = foreground\s+live\?\.syncBubble\(\)/);
});
it('R251 новый вход в голос сбрасывает hidden до синхронизации пузыря', () => hiddenGuard(service));
for (const [name, from, to] of [
  ['вне голоса', 'inVoice && enabled', 'true && enabled'],
  ['выключен в настройках', '&& enabled &&', '&& true &&'],
  ['спрятан крестиком', '&& !hidden &&', '&& true &&'],
  ['нет разрешения', '&& canDraw &&', '&& true &&'],
  ['приложение на экране', ' && !appForeground', ''],
] as const) it(`R251 контрфакт условия показа: ${name}`, () => rejects(bubble, from, to, showGuard));
it('R251 контрфакт незахваченного WindowManager ловится для каждого из пяти мест', () => {
  windowsGuard(bubble);
  const clean = code(bubble), calls = [...clean.matchAll(/\bwm\.(?:addView|removeView|updateViewLayout)\([^\n]+\)/g)];
  assert.equal(calls.length, 5);
  for (const call of calls) {
    // Переносим конкретный вызов перед его try, оставляя прежний catch — простого поиска try в методе недостаточно.
    const at = call.index!, start = clean.lastIndexOf('try {', at);
    const changed = bubble.slice(0, start) + call[0] + '\n' + bubble.slice(start, at) + bubble.slice(at + call[0].length);
    assert.throws(() => windowsGuard(changed), assert.AssertionError);
  }
});
for (const [name, source, from, to, check] of [
  ['onPause оставляет foreground', activity, 'VoiceForegroundService.setAppForeground(false)', 'VoiceForegroundService.setAppForeground(true)', foregroundGuard],
  ['новый вход оставляет hidden', service, 'if (inVoice && !lastInVoice) MicBubble.setHidden(app, false)', 'if (inVoice && !lastInVoice) MicBubble.setHidden(app, true)', hiddenGuard],
  ['разрешение только в комментарии', manifest, '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />', '<!-- <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" /> -->', manifestGuard],
] as const) it(`R251 Kotlin-контрфакт: ${name}`, () => rejects(source, from, to, check));

function nativeUpGuard(source: string) {
  const registration = ptt(source).variable('teardownMicPtt');
  assert.ok(ts.isConditionalExpression(registration));
  assert.equal(compact(registration.condition), 'isAndroid()');
  const call = registration.whenTrue;
  assert.ok(ts.isCallExpression(call)); assert.equal(compact(call.expression), 'onMicPtt');
  assert.equal(call.arguments.length, 2);
  const up = call.arguments[1]; assert.ok(ts.isArrowFunction(up) && ts.isBlock(up.body));
  assert.deepEqual(up.body.statements.map(compact), [
    'nativeHeld=false;', 'if(!held)return;', 'held=false;', 'clearRelease();',
    'voidroom.localParticipant.setMicrophoneEnabled(false);',
  ], 'без зажатия нет закрытия; после сброса held и хвоста — синхронный вызов закрытия');
  const delayed = descendants(up.body, n => ts.isCallExpression(n)
    && (compact(n.expression) === 'end' || /(?:^|\.)setTimeout$/.test(compact(n.expression))));
  assert.equal(delayed.length, 0, 'натив уже выждал хвост: WebView не должен ждать второй таймер');
}
function desktopReleaseGuard(source: string) {
  const effect = ptt(source), end = effect.handler('end');
  assert.deepEqual(end.statements.slice(0, 4).map(compact), [
    'if(!held)return;', 'held=false;', 'constdelay=Math.max(0,getAudioSettings().pttReleaseMs);', 'clearRelease();',
  ]);
  assert.equal(end.statements.length, 5);
  const assignment = end.statements[4]; assert.ok(ts.isExpressionStatement(assignment));
  assert.ok(ts.isBinaryExpression(assignment.expression));
  assert.equal(compact(assignment.expression.left), 'releaseTimer');
  assert.equal(assignment.expression.operatorToken.kind, ts.SyntaxKind.EqualsToken);
  const timer = assignment.expression.right; assert.ok(ts.isCallExpression(timer));
  assert.equal(compact(timer.expression), 'setTimeout'); assert.equal(timer.arguments.length, 2);
  assert.equal(compact(timer.arguments[1]), 'delay');
  const callback = timer.arguments[0]; assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  assert.deepEqual(callback.body.statements.map(compact), [
    'releaseTimer=null;', 'if(!held)voidroom.localParticipant.setMicrophoneEnabled(false);',
  ], 'повторное нажатие не закрывает микрофон по старому таймеру');
  for (const name of ['upKey', 'upMouse']) {
    const endings = descendants(effect.handler(name), n => ts.isCallExpression(n) && compact(n.expression) === 'end');
    assert.equal(endings.length, 1, `${name} сохраняет общий хвост отпускания`);
  }
  for (const [name, hook] of [['teardownNative', 'onNativePtt'], ['teardownNativeKey', 'onNativeKeyPtt']]) {
    assert.equal(compact(effect.variable(name)), `isDesktop()?${hook}(start,end):null`);
  }
}

// Класс ошибки: зависший микрофон свёрнутого WebView из-за второго, уже ненужного таймера.
it('R252 отпускание нативной рации сразу закрывает только действительно зажатый микрофон', () => nativeUpGuard(voice));
// Класс ошибки: исправление Android случайно отрезает хвост слов клавиатуры и desktop-хуков.
it('R252 клавиатура, мышь и desktop-хуки по-прежнему отпускают через настроенный хвост', () => desktopReleaseGuard(voice));
for (const [name, from, to, check] of [
  ['незажатый микрофон закрывается', 'nativeHeld = false;\n            if (!held) return;', 'nativeHeld = false;', nativeUpGuard],
  ['натив снова зовёт отложенный end', 'nativeHeld = false;\n            if (!held) return;\n            held = false;\n            clearRelease();\n            void room.localParticipant.setMicrophoneEnabled(false);', 'nativeHeld = false;\n            end();', nativeUpGuard],
  ['натив ждёт замороженный таймер', 'nativeHeld = false;\n            if (!held) return;\n            held = false;\n            clearRelease();\n            void room.localParticipant.setMicrophoneEnabled(false);', 'nativeHeld = false;\n            if (!held) return;\n            held = false;\n            clearRelease();\n            setTimeout(() => { void room.localParticipant.setMicrophoneEnabled(false); }, 200);', nativeUpGuard],
  ['desktop теряет длительность хвоста', '}, delay);', '}, 0);', desktopReleaseGuard],
] as const) {
  // Класс ошибки: страж обязан отвергать реальный регресс, а не просто находить слова в исходнике.
  it(`R252 AST-контрфакт: ${name}`, () => rejects(voice, from, to, check));
}

const tight = (source: string) => source.replace(/\s+/g, '');
function kotlinBlock(source: string, header: RegExp) {
  const match = header.exec(source); assert.ok(match, `найден блок ${header}`);
  const at = source.indexOf('{', match.index), end = closeAt(source, at);
  return { body: source.slice(at + 1, end), after: source.slice(end + 1) };
}
function bubbleDelayGuard(source: string) {
  const clean = code(source);
  assert.match(clean, /private\s+val\s+main\s*=\s*Handler\(Looper\.getMainLooper\(\)\)/);
  assert.match(clean, /private\s+var\s+pendingUp\s*:\s*Runnable\?\s*=\s*null/);
  assert.match(clean, /class\s+Look\([^\n]*val\s+pttReleaseMs\s*:\s*Int\s*=\s*0\)/);
  const release = method(source, 'releasePtt');
  const holding = kotlinBlock(release, /^\s*if\s*\(holding\)\s*\{/);
  assert.equal(tight(holding.body), tight(`
    holding = false
    view?.invalidate()
    val delay = look.pttReleaseMs.coerceIn(0, 5000)
    if (now || delay == 0) {
      onAction("ptt-up")
    } else {
      val r = Runnable {
        pendingUp = null
        onAction("ptt-up")
      }
      pendingUp = r
      main.postDelayed(r, delay.toLong())
    }
    return
  `), 'ноль/now — сразу; положительный хвост — Runnable на главном Handler и только потом ptt-up');
  const touch = method(source, 'onTouch');
  const up = kotlinBlock(touch, /MotionEvent\.ACTION_UP\s*->\s*\{/);
  assert.match(up.body, /holding\s*->\s*releasePtt\(\)/, 'отпускание пальца входит в нативный отсчёт');
  const cancel = kotlinBlock(touch, /MotionEvent\.ACTION_CANCEL\s*->\s*\{/);
  assert.match(cancel.body, /^\s*releasePtt\(\)/);
}
function bubbleRepressGuard(source: string) {
  const down = kotlinBlock(method(source, 'onTouch'), /MotionEvent\.ACTION_DOWN\s*->\s*\{/);
  const press = kotlinBlock(down.body, /if\s*\(look\.ptt && !look\.muted && !look\.deafened\)\s*\{/);
  assert.equal(tight(press.body), tight(`
    holding = true
    v.invalidate()
    val pending = pendingUp
    if (pending != null) {
      main.removeCallbacks(pending)
      pendingUp = null
    } else {
      onAction("ptt-down")
    }
  `), 'повторное касание отменяет старый up, но не дублирует ещё активный down');
}
function bubbleRemoveGuard(source: string) {
  assert.match(method(source, 'remove'), /^\s*releasePtt\(now\s*=\s*true\)/,
    'немедленное отпускание идёт даже до проверки отсутствующего view');
  bubbleDelayGuard(source); // now обязан обходить таймер также при ещё зажатом пальце.
  const holding = kotlinBlock(method(source, 'releasePtt'), /^\s*if\s*\(holding\)\s*\{/);
  assert.equal(tight(holding.after), tight(`
    if (now) {
      val pending = pendingUp ?: return
      main.removeCallbacks(pending)
      pendingUp = null
      onAction("ptt-up")
    }
  `), 'снятие пузыря посреди хвоста отменяет callback и немедленно отпускает ровно один раз');
}
function releaseWireGuard(source: string) {
  const parse = method(source, 'parseMicState');
  assert.match(parse, /else\s+MicState\(\s*o\.optBoolean\("muted", false\),\s*o\.optBoolean\("deafened", false\),\s*o\.optBoolean\("ptt", false\),\s*o\.optBoolean\("speaking", false\),\s*o\.optString\("channelName", ""\)\.take\(100\),\s*o\.optInt\("pttReleaseMs", 0\),\s*\)/,
    'поле JSON становится длительностью MicState, а не неиспользуемым чтением');
  const clean = code(source);
  assert.match(clean, /class\s+MicState\([\s\S]*?val\s+channelName\s*:\s*String,\s*val\s+pttReleaseMs\s*:\s*Int,\s*\)/);
  assert.match(method(source, 'syncBubble'), /val mic = parseMicState\(micStateJson\)\s+b\.sync\(mic\?\.let\s*\{\s*MicBubble\.Look\(it\.muted, it\.deafened, it\.ptt, it\.speaking, it\.pttReleaseMs\)\s*\}\)/,
    'поле доходит до Look именно последним аргументом');
}

// Класс ошибки: хвост ждётся в остановленном WebView вместо работающего Android Handler.
it('R252 пузырь ждёт положительный хвост на Handler, а ноль и принудительное отпускание отправляет сразу', () => bubbleDelayGuard(bubble));
// Класс ошибки: старый up гасит новое зажатие либо повторный down открывает вторую сессию.
it('R252 повторное касание отменяет отложенный up без повторного down', () => bubbleRepressGuard(bubble));
// Класс ошибки: снятый пузырь оставляет зажатый микрофон или живой отложенный callback.
it('R252 снятие пузыря сразу отпускает и зажатие, и уже начатый хвост', () => bubbleRemoveGuard(bubble));
// Класс ошибки: настройка теряется между JSON страницы, службой и Look пузыря.
it('R252 служба передаёт длительность отпускания из JSON в Look пузыря', () => releaseWireGuard(service));
for (const [name, source, from, to, check] of [
  ['повторное касание не отменяет pendingUp', bubble, 'if (pending != null) {\n            main.removeCallbacks(pending)', 'if (pending != null) {', bubbleRepressGuard],
  ['повторное касание дублирует down', bubble, 'pendingUp = null\n          } else {', 'pendingUp = null\n            onAction("ptt-down")\n          } else {', bubbleRepressGuard],
  ['положительный хвост отправляет up сразу', bubble, 'main.postDelayed(r, delay.toLong())', 'onAction("ptt-up")', bubbleDelayGuard],
  ['нулевой хвост уходит в таймер', bubble, 'if (now || delay == 0)', 'if (now)', bubbleDelayGuard],
  ['remove не просит немедленное отпускание', bubble, 'releasePtt(now = true)', 'releasePtt()', bubbleRemoveGuard],
  ['снятие пузыря не отменяет хвост', bubble, 'val pending = pendingUp ?: return\n      main.removeCallbacks(pending)', 'val pending = pendingUp ?: return', bubbleRemoveGuard],
  ['снятие пузыря не отправляет up из хвоста', bubble, 'pendingUp = null\n      onAction("ptt-up")', 'pendingUp = null', bubbleRemoveGuard],
  ['служба читает другое поле JSON', service, 'o.optInt("pttReleaseMs", 0)', 'o.optInt("releaseMs", 0)', releaseWireGuard],
  ['Look получает ноль вместо настройки', service, 'MicBubble.Look(it.muted, it.deafened, it.ptt, it.speaking, it.pttReleaseMs)', 'MicBubble.Look(it.muted, it.deafened, it.ptt, it.speaking, 0)', releaseWireGuard],
] as const) {
  // Класс ошибки: статический страж пропускает сломанную отмену, тайминг или передачу настройки.
  it(`R252 Kotlin-контрфакт: ${name}`, () => rejects(source, from, to, check));
}
