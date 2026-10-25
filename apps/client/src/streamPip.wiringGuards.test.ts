import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Стражи проводки: приложение/LiveKit не импортируем и куски функций не исполняем.
// Реальные правила streamsInView/wantedLayer проверяются отдельно; здесь их нельзя обойти при подключении.
const voice = readFileSync(new URL('./components/VoiceConnection.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (n: ts.Node) => n.getText().replace(/\s+/g, '');
function descendants(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(n: ts.Node) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }
  visit(node); return found;
}
function ast(raw: string) {
  return ts.createSourceFile('VoiceConnection.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function effect(raw: string, kind: 'audio' | 'layer') {
  const marker = kind === 'audio' ? 'streamAudioVolume' : 'wantedLayer';
  const effects = descendants(ast(raw), n => ts.isCallExpression(n) && n.expression.getText() === 'useEffect'
    && !!n.arguments[0] && ts.isArrowFunction(n.arguments[0])
    && descendants(n.arguments[0], c => ts.isCallExpression(c) && c.expression.getText() === marker).length === 1);
  assert.equal(effects.length, 1, `R254 единственный эффект ${kind} с настоящим правилом`);
  const call = effects[0] as ts.CallExpression;
  const fn = call.arguments[0] as ts.ArrowFunction;
  assert.ok(ts.isBlock(fn.body));
  const declarations = fn.body.statements.filter(ts.isVariableStatement)
    .flatMap(n => [...n.declarationList.declarations]).filter(n => n.name.getText() === 'apply');
  assert.equal(declarations.length, 1, `R254 ${kind}: один обработчик apply`);
  const apply = declarations[0].initializer;
  assert.ok(apply && ts.isArrowFunction(apply) && ts.isBlock(apply.body));
  return { call, body: fn.body, apply: apply.body };
}
function variable(body: ts.Block, name: string) {
  const declarations = descendants(body, n => ts.isVariableDeclaration(n) && n.name.getText() === name) as ts.VariableDeclaration[];
  assert.equal(declarations.length, 1, `R254 одна переменная ${name}`);
  assert.ok(declarations[0].initializer); return declarations[0].initializer;
}
function inViewGuard(raw: string, kind: 'audio' | 'layer') {
  const { apply } = effect(raw, kind);
  assert.equal(compact(variable(apply, 'watchedStreams')), 'streamsInView(useStore.getState().watchedStreams,pipStreams)',
    `R254 ${kind}: PiP включён в поле видимости даже без сцены`);
  const reads = apply.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
    .filter(n => ts.isObjectBindingPattern(n.name)
      && n.name.elements.some(e => e.name.getText() === 'pipStreams')
      && n.initializer && compact(n.initializer) === 'useStore.getState()');
  assert.equal(reads.length, 1, `R254 ${kind}: актуальный pipStreams читается внутри apply`);
  assert.equal(compact(variable(apply, 'watched')), 'watchedStreams.some((w)=>w===p.identity||ownerOf(w)===p.identity)',
    `R254 ${kind}: спутник связывается с владельцем без потери PiP`);
}
function audioGuard(raw: string) {
  inViewGuard(raw, 'audio');
  const { apply } = effect(raw, 'audio');
  const calls = descendants(apply, n => ts.isCallExpression(n)) as ts.CallExpression[];
  assert.ok(calls.some(n => compact(n) === 'sub.setSubscribed(watched)'), 'R254 звук подписан по объединённому полю видимости');
  assert.ok(calls.some(n => compact(n) === 'streamAudioVolume(p.identity,watchedStreams,mutedStreams,(id)=>streamVolumes[id]??1)'),
    'R254 громкость получает объединённые показы и личный mute/volume');
  assert.ok(calls.some(n => compact(n) === 't.setVolume(vol)'), 'R254 рассчитанная громкость применяется к треку');
}
function layerGuard(raw: string) {
  inViewGuard(raw, 'layer');
  const { apply } = effect(raw, 'layer');
  assert.equal(compact(variable(apply, 'windowHidden')), "isWindowCovered()||document.visibilityState==='hidden'",
    'R254 скрытость главного окна не маскируется ради PiP');
  assert.equal(compact(variable(apply, 'inPip')), 'isInPip(p.identity,pipStreams)||pipStreams.some((x)=>ownerOf(x)===p.identity)',
    'R254 признак PiP учитывает точный показ и его владельца');
  assert.equal(compact(variable(apply, 'layer')), 'wantedLayer(pref,{windowHidden,watched,inPip})',
    'R254 слой получает inPip отдельно от скрытости главного окна');
  const calls = descendants(apply, n => ts.isCallExpression(n)) as ts.CallExpression[];
  assert.ok(calls.some(n => compact(n).endsWith('.setVideoQuality?.(LAYER_QUALITY[layer])')),
    'R254 выбранный слой применяется к публикации');
}
function layerResendOrderGuard(raw: string) {
  const { body, apply } = effect(raw, 'layer');
  const maps = body.statements.filter(ts.isVariableStatement)
    .flatMap(n => [...n.declarationList.declarations]).filter(n => n.name.getText() === 'sentFor');
  assert.equal(maps.length, 1, 'R278 память отправленного слоя принадлежит эффекту, а не одному apply');
  const init = maps[0].initializer;
  assert.ok(init && ts.isNewExpression(init) && init.expression.getText() === 'WeakMap'
    && (init.arguments?.length ?? 0) === 0, 'R278 трек хранится отдельно для каждой публикации');
  const loops = descendants(apply, n => ts.isForOfStatement(n)
    && compact(n.expression) === 'p.trackPublications.values()') as ts.ForOfStatement[];
  assert.equal(loops.length, 1, 'R278 слой применяется внутри перебора публикаций');
  const block = loops[0].statement;
  assert.ok(ts.isBlock(block));
  assert.equal(compact(variable(block, 'fresh')), 'sentFor.get(pub)!==pub.track',
    'R278 свежесть определяется сменой трека той же публикации');
  const reads = block.statements.filter(ts.isVariableStatement)
    .filter(n => n.declarationList.declarations.some(d => d.name.getText() === 'fresh'));
  const writes = block.statements.filter(n => ts.isExpressionStatement(n)
    && compact(n.expression) === 'sentFor.set(pub,pub.track)');
  assert.equal(reads.length, 1, 'R278 свежесть читается до отправки слоя текущей публикации');
  assert.equal(writes.length, 1, 'R278 текущий трек запоминается для следующего apply');
  assert.ok(block.statements.indexOf(reads[0]) < block.statements.indexOf(writes[0]),
    'R278 get предыдущего трека идёт раньше set текущего');
}
function layerResendBranchGuard(raw: string) {
  const { apply } = effect(raw, 'layer');
  const branches = descendants(apply, n => ts.isIfStatement(n)
    && compact(n.expression) === 'needsLayerResend(pub.videoQuality,LAYER_QUALITY[layer],fresh)') as ts.IfStatement[];
  assert.equal(branches.length, 1, 'R278 повтор решает настоящее правило по качеству публикации и свежести трека');
  function branchCall(branch: ts.Statement | undefined, method: string, args: string[], message: string) {
    assert.ok(branch && ts.isBlock(branch) && branch.statements.length === 1, message);
    const statement = branch.statements[0];
    assert.ok(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression), message);
    const call = statement.expression;
    assert.ok(ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === method, message);
    let receiver: ts.Expression = call.expression.expression;
    while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver)) receiver = receiver.expression;
    assert.equal(compact(receiver), 'pub', message);
    assert.deepEqual(call.arguments.map(compact), args, message);
  }
  branchCall(branches[0].thenStatement, 'emitTrackUpdate', [],
    'R278 равный слой новой подписки отправляется через emitTrackUpdate');
  branchCall(branches[0].elseStatement, 'setVideoQuality', ['LAYER_QUALITY[layer]'],
    'R278 в else остаётся обычная смена качества setVideoQuality');
}
function listenersGuard(raw: string) {
  for (const kind of ['audio', 'layer'] as const) {
    const { body, call } = effect(raw, kind);
    const statements = body.statements.map(compact);
    assert.ok(statements.includes('apply();'), `R254 ${kind}: первоначальное применение`);
    const name = kind === 'audio' ? 'unsub' : 'unsubStore';
    assert.equal(compact(variable(body, name)), 'useStore.subscribe(apply)',
      `R254 ${kind}: смена pipStreams вызывает apply через подписку на весь стор`);
    const returns = body.statements.filter(ts.isReturnStatement);
    assert.equal(returns.length, 1);
    const cleanup = returns[0].expression;
    assert.ok(cleanup && ts.isArrowFunction(cleanup) && ts.isBlock(cleanup.body));
    assert.ok(cleanup.body.statements.map(compact).includes(`${name}();`), `R254 ${kind}: подписка снимается при выходе`);
    assert.equal(compact(call.arguments[1]), '[room]', `R254 ${kind}: обработчик принадлежит комнате`);
    if (kind === 'layer') {
      assert.ok(statements.includes("document.addEventListener('visibilitychange',apply);"), 'R254 видимость повторно применяет слой');
      assert.ok(cleanup.body.statements.map(compact).includes("document.removeEventListener('visibilitychange',apply);"));
      assert.equal(compact(variable(body, 'unCovered')), 'onWindowCovered(apply)');
      assert.equal(compact(variable(body, 'unPref')), 'onStreamQuality(apply)');
      assert.ok(statements.includes('room.on(RoomEvent.TrackSubscribed,apply);'), 'R254 новая подписка повторно применяет слой');
      for (const cleanupCall of ['unCovered();', 'unPref();', 'room.off(RoomEvent.TrackSubscribed,apply);']) {
        assert.ok(cleanup.body.statements.map(compact).includes(cleanupCall), `R254 снят слушатель ${cleanupCall}`);
      }
    }
  }
}
function hostGuard(raw: string) {
  const file = ast(raw);
  const host = descendants(file, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'StreamPipHost');
  assert.equal(host.length, 1, 'R254 один PiP-хост живёт вне сцены');
  const parent = host[0].parent;
  assert.ok(ts.isJsxElement(parent), 'R254 PiP-хост не спрятан под условием/компонентом сцены');
  assert.equal(parent.openingElement.tagName.getText(), 'RoomContext.Provider', 'R254 хост смонтирован в голосовой комнате');
  assert.ok(parent.children.some(n => ts.isJsxExpression(n) && n.expression && compact(n.expression) === 'children'),
    'R254 PiP-хост сосед контента, а не ребёнок размонтируемой сцены');
  assert.equal(descendants(file, n => ts.isImportDeclaration(n) && n.moduleSpecifier.getText() === "'./StreamPipView'"
    && !!n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
    && n.importClause.namedBindings.elements.some(e => e.name.text === 'StreamPipHost')).length, 1,
  'R254 хост импортирован из настоящего компонента PiP');
}
function rejects(raw: string, from: string, to: string, check: (raw: string) => void, message: string) {
  check(raw); // Original-first: красный оригинал не считается защитой от мутанта.
  assert.equal(raw.split(from).length - 1, 1, 'R254 единственный точный якорь контрфакта');
  assert.throws(() => check(raw.replace(from, to)), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith(message));
}

it('R254 звук PiP без сцены остаётся подписанным с личной громкостью и мьютом', () => {
  // Класс ошибки: очищенный watchedStreams отписывает ещё видимый PiP и обнуляет его звук.
  audioGuard(voice);
});
it('R254 скрытое главное окно передаёт PiP в правило слоя, не понижая его как закрытый показ', () => {
  // Класс ошибки: HIGH в отдельном окне превращается в LOW после сворачивания главного.
  layerGuard(voice);
});
it('R254 смена PiP повторно применяет звук и слой, слушатели снимаются при выходе', () => {
  // Класс ошибки: PiP прочитан один раз или попал не в тот селектор стора.
  listenersGuard(voice);
});
it('R254 PiP-хост находится в VoiceConnection вне размонтируемой сцены', () => {
  // Класс ошибки: уход в текстовый канал уничтожает окошко вместе с VoiceStage.
  hostGuard(voice);
});
it('R254 потеря PiP из поля видимости звука или слоя обнаруживается раздельно', () => {
  const anchor = 'const watchedStreams = streamsInView(useStore.getState().watchedStreams, pipStreams);';
  assert.equal(voice.split(anchor).length - 1, 2, 'R254 объединение нужно двум независимым эффектам');
  for (const kind of ['audio', 'layer'] as const) {
    const check = kind === 'audio' ? audioGuard : layerGuard;
    check(voice);
    // Меняем только одно из двух мест, чтобы исправная соседняя проводка не скрывала регрессию.
    const index = kind === 'audio' ? voice.indexOf(anchor) : voice.lastIndexOf(anchor);
    const changed = voice.slice(0, index) + 'const watchedStreams = useStore.getState().watchedStreams;' + voice.slice(index + anchor.length);
    assert.throws(() => check(changed), (e: unknown) => e instanceof assert.AssertionError
      && e.message.startsWith(`R254 ${kind}: PiP включён в поле видимости`));
  }
});
it('R254 удаление inPip из выбора слоя обнаруживается, даже когда звук подключён правильно', () => {
  rejects(voice, 'wantedLayer(pref, { windowHidden, watched, inPip })', 'wantedLayer(pref, { windowHidden, watched })',
    layerGuard, 'R254 слой получает inPip отдельно');
});
it('R254 потеря подписки слоя на изменения PiP обнаруживается независимо от первоначального apply', () => {
  rejects(voice, 'const unsubStore = useStore.subscribe(apply);', 'const unsubStore = () => {};',
    listenersGuard, 'R254 layer: смена pipStreams вызывает apply');
});
it('R254 условный PiP-хост вместо постоянного обнаруживается при сохранённом импорте', () => {
  rejects(voice, '<StreamPipHost />', '{false && <StreamPipHost />}',
    hostGuard, 'R254 PiP-хост не спрятан под условием');
});
it('R256 звук и слой не ограничивают объединённое поле видимости первым показом PiP', () => {
  // Первый показ уже защищён R254; второй владелец не должен терять подписку или качество.
  const anchor = 'const watchedStreams = streamsInView(useStore.getState().watchedStreams, pipStreams);';
  assert.equal(voice.split(anchor).length - 1, 2, 'R256 список объединяется независимо для звука и слоя');
  for (const kind of ['audio', 'layer'] as const) {
    const check = kind === 'audio' ? audioGuard : layerGuard;
    check(voice);
    const index = kind === 'audio' ? voice.indexOf(anchor) : voice.lastIndexOf(anchor);
    const changed = voice.slice(0, index) + anchor.replace('pipStreams)', 'pipStreams[0])') + voice.slice(index + anchor.length);
    assert.throws(() => check(changed), (e: unknown) => e instanceof assert.AssertionError
      && e.message.startsWith(`R254 ${kind}: PiP включён в поле видимости`));
  }
});
it('R256 слой сохраняет владельцев всех спутников PiP, а не только первого или точный identity', () => {
  // У публикации звука/видео identity владельца может отличаться от identity спутника в списке PiP.
  const anchor = 'isInPip(p.identity, pipStreams) || pipStreams.some((x) => ownerOf(x) === p.identity)';
  for (const mutant of [
    'isInPip(p.identity, pipStreams)',
    'isInPip(p.identity, pipStreams) || ownerOf(pipStreams[0]) === p.identity',
  ]) rejects(voice, anchor, mutant, layerGuard, 'R254 признак PiP учитывает точный показ и его владельца');
});
it('R278 новая подписка определяется до сохранения трека, память переживает повторный apply', () => {
  // Иначе после превью тот же LOW будет ошибочно считаться уже доведённым до сервера.
  layerResendOrderGuard(voice);
});
it('R278 равный слой повторяется серверу, а новый выбор идёт через обычную смену качества', () => {
  // Проверяем обе ветки: без else восстановление LOW ломало бы ручную смену качества.
  layerResendBranchGuard(voice);
});
it('R278 запись текущего трека раньше чтения предыдущего обнаруживается после проверки оригинала', () => {
  // Контрфакт делает fresh всегда false: библиотека опять промолчит после переподписки.
  rejects(voice, 'const fresh = sentFor.get(pub) !== pub.track;\n          sentFor.set(pub, pub.track);',
    'sentFor.set(pub, pub.track);\n          const fresh = sentFor.get(pub) !== pub.track;',
    layerResendOrderGuard, 'R278 get предыдущего трека идёт раньше set текущего');
});
it('R278 потеря принудительной отправки слоя обнаруживается даже при сохранённом setVideoQuality', () => {
  // Пустая then-ветка синтаксически корректна, но повторное открытие снова получит верхний слой.
  rejects(voice, '(pub as { emitTrackUpdate?: () => void }).emitTrackUpdate?.();', '',
    layerResendBranchGuard, 'R278 равный слой новой подписки отправляется через emitTrackUpdate');
});
