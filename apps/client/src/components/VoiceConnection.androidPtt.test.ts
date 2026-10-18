import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Страж настоящего эффекта: React/LiveKit не импортируются, фрагменты исходника не исполняются.
const source = readFileSync(new URL('./VoiceConnection.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (next: ts.Node) => {
    if (predicate(next)) found.push(next);
    ts.forEachChild(next, visit);
  };
  visit(node);
  return found;
}

function declarations(body: ts.Block, name: string): ts.VariableDeclaration[] {
  return body.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .filter(d => ts.isIdentifier(d.name) && d.name.text === name);
}

function effectOf(raw: string) {
  const file = ts.createSourceFile('VoiceConnection.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const components = file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name?.text === 'VoiceConnection');
  assert.equal(components.length, 1, 'один настоящий компонент VoiceConnection');
  const component = components[0];
  assert.ok(component.body && component.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const matches = descendants(component.body, n => ts.isCallExpression(n) && compact(n.expression) === 'useEffect'
    && !!n.arguments[0] && ts.isArrowFunction(n.arguments[0]) && ts.isBlock(n.arguments[0].body)
    && declarations(n.arguments[0].body, 'armMutedMic').length === 1);
  assert.equal(matches.length, 1, 'выбран эффект с armMutedMic, а не соседний эффект рации/метаданных');
  const effect = matches[0] as ts.CallExpression;
  const callback = effect.arguments[0] as ts.ArrowFunction;
  assert.ok(ts.isBlock(callback.body));
  const body = callback.body;
  function local(name: string) {
    const values = declarations(body, name);
    assert.equal(values.length, 1, `одна локальная переменная ${name}`);
    assert.ok(values[0].initializer);
    return values[0].initializer;
  }
  const arm = local('armMutedMic');
  assert.ok(ts.isArrowFunction(arm) && ts.isBlock(arm.body));
  assert.ok(arm.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), 'подготовка ждёт захват и mute');
  assert.equal(compact(local('lp')), 'room.localParticipant', 'проверки относятся к участнику текущей комнаты');
  return { effect, body, arm, armBody: arm.body, local };
}

function calls(body: ts.Node, name: string): ts.CallExpression[] {
  return descendants(body, n => ts.isCallExpression(n) && compact(n.expression) === name) as ts.CallExpression[];
}

function awaitedStatement(body: ts.Block, name: string) {
  const matches = calls(body, name);
  assert.equal(matches.length, 1, `ровно один вызов ${name}`);
  const call = matches[0];
  assert.ok(ts.isAwaitExpression(call.parent), `${name} обязательно дожидаются`);
  const statement = call.parent.parent;
  assert.ok(ts.isExpressionStatement(statement), `${name} — непосредственная операция эффекта`);
  const index = body.statements.indexOf(statement);
  assert.ok(index >= 0, `${name} не спрятан в недостижимой вложенной ветке`);
  return { call, index };
}

function capture(body: ts.Block) {
  const tracks = declarations(body, 't');
  assert.equal(tracks.length, 1, 'результат захвата хранится в одном локальном треке');
  const track = tracks[0];
  assert.ok(track.initializer && ts.isAwaitExpression(track.initializer));
  const call = track.initializer.expression;
  assert.ok(ts.isCallExpression(call)); assert.equal(compact(call.expression), 'createLocalAudioTrack');
  assert.equal(calls(body, 'createLocalAudioTrack').length, 1);
  const statement = track.parent.parent;
  assert.ok(ts.isVariableStatement(statement));
  const index = body.statements.indexOf(statement); assert.ok(index >= 0);
  return { call, index };
}

function captureGuard(raw: string) {
  const { armBody } = effectOf(raw), create = capture(armBody);
  assert.equal(create.call.arguments.length, 1);
  assert.equal(compact(create.call.arguments[0]), 'room.options.audioCaptureDefaults', 'захват использует настройки текущей комнаты');
}

function muteBeforePublishGuard(raw: string) {
  const { armBody } = effectOf(raw), create = capture(armBody);
  const mute = awaitedStatement(armBody, 't.mute');
  const publish = awaitedStatement(armBody, 'lp.publishTrack');
  assert.equal(mute.call.arguments.length, 0);
  assert.equal(publish.call.arguments.length, 2); assert.equal(compact(publish.call.arguments[0]), 't');
  assert.ok(create.index < mute.index && mute.index < publish.index,
    'сначала захват, затем завершившийся mute, только потом публикация того же трека');
}

function publicationGuards(raw: string) {
  const { armBody } = effectOf(raw), create = capture(armBody);
  const mute = awaitedStatement(armBody, 't.mute'), publish = awaitedStatement(armBody, 'lp.publishTrack');
  const probes = calls(armBody, 'lp.getTrackPublication');
  assert.equal(probes.length, 2, 'публикация проверяется и до захвата, и после ожиданий');
  const guards = armBody.statements.filter(ts.isIfStatement).filter(n => ts.isCallExpression(n.expression)
    && compact(n.expression.expression) === 'lp.getTrackPublication');
  assert.equal(guards.length, 2, 'обе проверки исполняются на основном пути подготовки');
  for (const guard of guards) {
    const call = guard.expression as ts.CallExpression;
    assert.equal(call.arguments.length, 1); assert.equal(compact(call.arguments[0]), 'Track.Source.Microphone');
    assert.equal(guard.elseStatement, undefined);
  }
  const [before, after] = guards;
  assert.ok(armBody.statements.indexOf(before) < create.index, 'готовая публикация исключает повторный захват');
  assert.ok(ts.isReturnStatement(before.thenStatement) && !before.thenStatement.expression);
  assert.ok(mute.index < armBody.statements.indexOf(after) && armBody.statements.indexOf(after) < publish.index,
    'после всех ожиданий снова проверяется победившая публикация, ещё до своей публикации');
  assert.ok(ts.isBlock(after.thenStatement));
  assert.equal(after.thenStatement.statements.length, 2);
  const [stop, leave] = after.thenStatement.statements;
  assert.equal(compact(stop), 't.stop();', 'лишний захваченный трек останавливается');
  assert.ok(ts.isReturnStatement(leave) && !leave.expression, 'после stop нет второй публикации');
}

function armCatch(raw: string) {
  const view = effectOf(raw);
  const initial = view.body.statements[0];
  assert.ok(ts.isIfStatement(initial));
  assert.equal(compact(initial.expression), "state!=='connected'");
  assert.ok(ts.isReturnStatement(initial.thenStatement));
  const deps = view.effect.arguments[1]; assert.ok(deps && ts.isArrayLiteralExpression(deps));
  for (const name of ['room', 'state', 'selfMuted', 'selfDeafened']) {
    assert.ok(deps.elements.some(n => compact(n) === name), `применение обновляется при ${name}`);
  }
  const ptt = view.local('ptt'); assert.equal(compact(ptt), 'getAudioSettings().pushToTalk');
  const declaration = ptt.parent.parent.parent;
  assert.ok(ts.isVariableStatement(declaration));
  const branch = view.body.statements[view.body.statements.indexOf(declaration) + 1];
  assert.ok(ts.isIfStatement(branch)); assert.equal(compact(branch.expression), '!ptt', 'обычный режим остаётся отдельной веткой');
  assert.equal(compact(branch.thenStatement), 'applyOpenMic();');
  const android = branch.elseStatement;
  assert.ok(android && ts.isIfStatement(android)); assert.equal(compact(android.expression), 'isAndroid()', 'подготовка ограничена Android');
  assert.equal(android.elseStatement, undefined, 'на остальных платформах рация не захватывает микрофон заранее');
  const invoke = android.thenStatement; assert.ok(ts.isExpressionStatement(invoke) && ts.isVoidExpression(invoke.expression));
  const caught = invoke.expression.expression;
  assert.ok(ts.isCallExpression(caught) && ts.isPropertyAccessExpression(caught.expression));
  assert.equal(caught.expression.name.text, 'catch', 'ошибка фоновой подготовки обработана');
  assert.equal(compact(caught.expression.expression), 'armMutedMic()');
  assert.equal(calls(view.body, 'armMutedMic').length, 1, 'нет второго запуска в обход Android/PTT');
  return caught;
}

function sourceGuard(raw: string) {
  const { call } = awaitedStatement(effectOf(raw).armBody, 'lp.publishTrack');
  assert.equal(call.arguments.length, 2); assert.equal(compact(call.arguments[0]), 't');
  const options = call.arguments[1]; assert.ok(ts.isObjectLiteralExpression(options));
  const sources = options.properties.filter(ts.isPropertyAssignment).filter(p => compact(p.name) === 'source');
  assert.equal(sources.length, 1); assert.equal(compact(sources[0].initializer), 'Track.Source.Microphone');
}

function warningGuard(raw: string) {
  const caught = armCatch(raw);
  assert.equal(caught.arguments.length, 1);
  const handler = caught.arguments[0]; assert.ok(ts.isArrowFunction(handler));
  assert.equal(handler.parameters.length, 1); const error = handler.parameters[0].name;
  assert.ok(ts.isIdentifier(error));
  assert.ok(ts.isCallExpression(handler.body));
  assert.equal(compact(handler.body.expression), 'console.warn', 'фоновая ошибка только логируется, без тоста/смены мьюта');
  assert.equal(handler.body.arguments.length, 2);
  const message = handler.body.arguments[0]; assert.ok(ts.isStringLiteral(message));
  assert.equal(message.text, '[voice] muted mic for PTT failed:');
  assert.equal(compact(handler.body.arguments[1]), error.text);
}

// Класс ошибки: предварительный захват использует не тот микрофон/параметры комнаты.
it('R253 предварительный Android-микрофон создаётся с аудионастройками текущей комнаты', () => captureGuard(source));
// Класс ошибки: при входе с рацией наружу успевает уйти незаглушённый звук.
it('R253 заглушение трека завершается до его публикации', () => muteBeforePublishGuard(source));
// Класс ошибки: повторный захват или публикация дублирует уже созданный другим действием микрофон.
it('R253 публикация проверяется до захвата и после ожиданий, проигравший трек останавливается без публикации', () => publicationGuards(source));
// Класс ошибки: предварительный захват включается без рации, на другой платформе либо до подключения комнаты.
it('R253 предварительный захват запускается только с рацией на Android, обычный режим сохраняет applyOpenMic', () => { armCatch(source); });
// Класс ошибки: подготовленный трек публикуется не как микрофон и не открывается клавишей рации.
it('R253 заглушённый трек публикуется с источником Microphone', () => sourceGuard(source));
// Класс ошибки: отказ фонового захвата оставляет необработанный Promise или пугает человека тостом.
it('R253 ошибка подготовки обрабатывается предупреждением без тоста и изменения намерения мьюта', () => warningGuard(source));

function replaceOnce(raw: string, from: string, to: string) {
  assert.equal(raw.split(from).length - 1, 1, 'одна адресная точка мутации');
  return raw.replace(from, to);
}
function changeArm(raw: string, changes: readonly (readonly [string, string])[]) {
  const { arm } = effectOf(raw), start = arm.getStart(), end = arm.getEnd();
  let body = raw.slice(start, end);
  for (const [from, to] of changes) body = replaceOnce(body, from, to);
  return raw.slice(0, start) + body + raw.slice(end);
}
const secondGuard = 'if (lp.getTrackPublication(Track.Source.Microphone)) {\n        t.stop();\n        return;\n      }';
const muted = 'await t.mute();';
const published = 'await lp.publishTrack(t, { source: Track.Source.Microphone });';

const mutations: readonly [string, (raw: string) => string, (raw: string) => unknown][] = [
  ['публикация раньше заглушения', raw => changeArm(raw, [
    [muted, '__r253_swap__;'], [published, muted], ['__r253_swap__;', published],
  ]), muteBeforePublishGuard],
  ['пропущена проверка до захвата', raw => changeArm(raw, [
    ['if (lp.getTrackPublication(Track.Source.Microphone)) return;', ''],
  ]), publicationGuards],
  ['пропущена повторная проверка после захвата', raw => changeArm(raw, [[secondGuard, '']]), publicationGuards],
  ['снято ограничение Android', raw => replaceOnce(raw, 'else if (isAndroid()) void armMutedMic()', 'else if (true) void armMutedMic()'), armCatch],
  ['снято ограничение режима рации', raw => replaceOnce(raw, 'if (!ptt) applyOpenMic();', 'if (false) applyOpenMic();'), armCatch],
  ['не дожидаются завершения mute', raw => changeArm(raw, [[muted, 'void t.mute();']]), muteBeforePublishGuard],
  ['публикация с источником камеры', raw => changeArm(raw, [
    ['source: Track.Source.Microphone', 'source: Track.Source.Camera'],
  ]), sourceGuard],
  ['захват без настроек комнаты', raw => changeArm(raw, [
    ['createLocalAudioTrack(room.options.audioCaptureDefaults)', 'createLocalAudioTrack(undefined)'],
  ]), captureGuard],
  ['проигравший трек не останавливается', raw => changeArm(raw, [['        t.stop();\n', '']]), publicationGuards],
  ['после остановки продолжается публикация', raw => changeArm(raw, [['        return;\n', '']]), publicationGuards],
  ['фоновая ошибка вызывает тост', raw => replaceOnce(raw,
    "console.warn('[voice] muted mic for PTT failed:', e)", "toastError(e, 'Микрофон недоступен')"), warningGuard],
  ['ошибка подготовки больше не перехватывается', raw => replaceOnce(raw,
    "armMutedMic().catch((e) => console.warn('[voice] muted mic for PTT failed:', e))", 'armMutedMic()'), warningGuard],
];
for (const [label, mutate, check] of mutations) {
  // Класс ошибки: соответствующий страж обязан замечать сломанный порядок, условия, гонку или обработку отказа.
  it(`R253 контрфакт: ${label}`, () => {
    check(source); // Оригинал проходит прежде, чем строится контрфакт; код компонента не исполняется.
    const changed = mutate(source);
    const parsed = ts.createSourceFile('mutant.tsx', changed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // Синтаксическая ошибка не считается доказательством чувствительности стража.
    assert.equal((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
    assert.throws(() => check(changed), assert.AssertionError);
  });
}
