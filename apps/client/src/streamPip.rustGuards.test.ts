import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const rust = readFileSync(new URL('../../desktop/src-tauri/src/pip.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Это статические свидетели, не Rust-компилятор: текст никогда не исполняется.
// Строки сохраняются для проверок адреса, но не могут подделать границы блоков.
function lexical(source: string) {
  const code = source.split('');
  const structure = source.split('');
  function blank(start: number, end: number, comment: boolean) {
    for (let i = start; i < end; i++) {
      if (source[i] !== '\n') {
        structure[i] = ' ';
        if (comment) code[i] = ' ';
      }
    }
  }
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      blank(start, i, true);
    } else if (source.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      assert.equal(depth, 0, 'R255-lexical: блочный комментарий завершён');
      blank(start, i, true);
    } else {
      const raw = source.slice(i).match(/^(?:br|r)(#{0,255})"/);
      const character = source.slice(i).match(/^'(?:\\.|[^'\\\r\n])'/);
      if (raw) {
        const closing = `"${raw[1]}`;
        const end = source.indexOf(closing, i + raw[0].length);
        assert.notEqual(end, -1, 'R255-lexical: raw-строка завершена');
        i = end + closing.length;
        blank(start, i, false);
      } else if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
        assert.ok(i < source.length, 'R255-lexical: строка завершена');
        i++;
        blank(start, i, false);
      } else if (character) {
        i += character[0].length;
        blank(start, i, false);
      } else i++;
    }
  }
  return { code: code.join(''), structure: structure.join('') };
}

function blockAt(source: string, opening: number, kind: string) {
  const { code, structure } = lexical(source);
  assert.equal(structure[opening], '{', `${kind}: найдена открывающая скобка`);
  let depth = 0;
  for (let i = opening; i < structure.length; i++) {
    if (structure[i] === '{') depth++;
    if (structure[i] === '}' && --depth === 0) return { body: code.slice(opening + 1, i), end: i + 1 };
  }
  assert.fail(`${kind}: блок сбалансирован`);
}

function functionBody(source: string, name: string) {
  const { code, structure } = lexical(source);
  const matches = [...structure.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g'))];
  assert.equal(matches.length, 1, `R255-function-${name}: ровно одна функция`);
  const start = matches[0].index!;
  const opening = structure.indexOf('{', start);
  return { ...blockAt(code, opening, `R255-function-${name}`), signature: code.slice(start, opening), opening };
}

function once(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `R255-mutation-anchor: единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

function failure(kind: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(`${kind}:`);
}

function checkArm(source: string) {
  const { code } = lexical(source);
  assert.match(code, /\bpub\s+async\s+fn\s+gv_pip_arm\s*\(/, 'R255-arm-async: IPC-команда асинхронна');
  const { body } = functionBody(code, 'gv_pip_arm');
  const refusal = /\bif\s+window\.label\(\)\s*!=\s*"main"\s*\{/.exec(body);
  assert.ok(refusal, 'R255-arm-origin: чужое окно отклоняется');
  const guard = blockAt(body, refusal.index + refusal[0].lastIndexOf('{'), 'R255-arm-origin');
  assert.match(guard.body, /^\s*return\s*;\s*$/, 'R255-arm-origin: отказ завершается до побочных эффектов');
  const store = /\bARMED_UNTIL\.store\s*\(\s*now_ms\(\)\s*\+\s*ARM_MS\s*,\s*Ordering::SeqCst\s*\)/.exec(body);
  assert.ok(store, 'R255-arm-deadline-store: срок ARM_MS реально записывается в разрешение');
  assert.ok(guard.end <= store.index, 'R255-arm-origin: отказ чужому окну раньше записи разрешения');
}

function checkDeadline(source: string) {
  const { code } = lexical(source);
  const matches = [...code.matchAll(/\bconst\s+ARM_MS\s*:\s*u64\s*=\s*([\d_]+)\s*;/g)];
  assert.equal(matches.length, 1, 'R255-arm-deadline: один срок разрешения');
  const duration = Number(matches[0][1].replace(/_/g, ''));
  assert.ok(duration > 0 && duration <= 5000, 'R255-arm-deadline: разрешение живёт от 1 до 5000 мс');
  checkArm(source);
}

function checkConsume(source: string) {
  const { body } = functionBody(source, 'take_arm');
  const swap = /\blet\s+until\s*=\s*ARMED_UNTIL\.swap\(\s*0\s*,\s*Ordering::SeqCst\s*\)\s*;/.exec(body);
  assert.ok(swap, 'R255-arm-consume: разрешение атомарно снимается через swap(0)');
  const valid = /\buntil\s*!=\s*0\s*&&\s*now_ms\(\)\s*<=\s*until\b/.exec(body);
  assert.ok(valid && swap.index + swap[0].length <= valid.index,
    'R255-arm-consume: разрешение снимается до проверки его срока');
}

function checkNewWindow(source: string) {
  const { body } = functionBody(source, 'on_new_window');
  const consume = /\blet\s+armed\s*=\s*take_arm\(\)\s*;/.exec(body);
  assert.ok(consume, 'R255-window-consume-order: каждый запрос снимает разрешение');
  const rejection = /\bif\s+!armed\s*\|\|\s*url\.as_str\(\)\s*!=\s*"about:blank"\s*\{/.exec(body);
  assert.ok(rejection, 'R255-window-url: пускается только взведённый about:blank');
  assert.ok(consume.index + consume[0].length <= rejection.index,
    'R255-window-consume-order: разрешение снимается до проверки адреса');
  const guard = blockAt(body, rejection.index + rejection[0].lastIndexOf('{'), 'R255-window-deny');
  assert.match(guard.body, /^\s*return\s+NewWindowResponse::Deny\s*;\s*$/,
    'R255-window-deny: невзведённое или постороннее окно запрещено');
  const builder = body.indexOf('WebviewWindowBuilder::new');
  assert.ok(builder >= guard.end, 'R255-window-deny: окно строится только после отказной ветки');
  assert.match(body, /\bNewWindowResponse::Create\s*\{\s*window\s*\}/,
    'R255-window-create: допустимый запрос получает построенное окно');
  assert.match(body, /\bErr\s*\(\s*_\s*\)\s*=>\s*NewWindowResponse::Deny\b/,
    'R255-window-build-deny: ошибка построения не разрешает другое окно');
}

function checkBuilder(source: string) {
  const { body } = functionBody(source, 'on_new_window');
  const chain = body.match(/\blet\s+built\s*=\s*builder\b([\s\S]*?)\.build\(\s*\)\s*;/)?.[1];
  assert.ok(chain, 'R255-window-flags: проверяется цепочка реально строящегося окна');
  for (const [method, value] of [['always_on_top', 'true'], ['skip_taskbar', 'true'], ['minimizable', 'false'], ['focused', 'false']]) {
    assert.match(chain, new RegExp(`\\.${method}\\s*\\(\\s*${value}\\s*\\)`),
      `R255-window-flags: ${method}(${value})`);
  }
}

function checkClose(source: string) {
  const { body } = functionBody(source, 'close_with_page');
  const event = /\bWindowCloseRequestedEventHandler::create\s*\(\s*Box::new\s*\(\s*move\s*\|_,\s*_\|\s*\{/.exec(body);
  assert.ok(event, 'R255-close-handler: закрытие подключено к событию страницы');
  const handler = blockAt(body, event.index + event[0].lastIndexOf('{'), 'R255-close-handler').body;
  const spawn = /\bstd::thread::spawn\s*\(\s*move\s*\|\|\s*\{/.exec(handler);
  assert.ok(spawn, 'R255-close-thread: закрытие выходит из COM-колбэка в отдельный поток');
  const thread = blockAt(handler, spawn.index + spawn[0].lastIndexOf('{'), 'R255-close-thread');
  assert.match(thread.body, /\bw\.destroy\(\s*\)/, 'R255-close-thread: поток действительно закрывает окно');
  const outsideThread = handler.slice(0, spawn.index) + handler.slice(thread.end);
  assert.doesNotMatch(outsideThread, /\.(?:destroy|close)\s*\(/,
    'R255-close-thread: внутри COM-колбэка нет прямого закрытия');
}

it('R255 Rust: только main асинхронно взводит короткое одноразовое разрешение [arm-origin/deadline]', () => {
  checkArm(rust);
  checkDeadline(rust);
  checkConsume(rust);
});

it('R255 Rust: запрос сначала тратит разрешение, затем пускает только about:blank [window-url/deny]', () => {
  checkNewWindow(rust);
});

it('R255 Rust: окно остаётся поверх без панели задач, сворачивания и захвата фокуса [window-flags]', () => {
  checkBuilder(rust);
});

it('R255 Rust: страница закрывает рамку из отдельного потока [close-thread]', () => {
  checkClose(rust);
});

it('R255 Rust: комментарий со скобками и ложным разрешением не заменяет живой код [lexical]', () => {
  const decorated = `/* { /* nested */ } */\n// NewWindowResponse::Allow {\n${rust}`;
  checkArm(decorated);
  checkConsume(decorated);
  checkNewWindow(decorated);
  checkBuilder(decorated);
  checkClose(decorated);
  checkNewWindow(once(rust, '.title("GusVoice")', '.title("GusVoice { // not comment }")'));
  const ghost = once(rust, '!armed || url.as_str() != "about:blank"', '!armed /* || url.as_str() != "about:blank" */');
  assert.throws(() => checkNewWindow(ghost), failure('R255-window-url'));
});

it('R255 Rust: удаление проверки адреса и Allow вместо Deny отвергаются адресными стражами [window-url/deny]', () => {
  checkNewWindow(rust);
  const noUrl = once(rust, '!armed || url.as_str() != "about:blank"', '!armed');
  assert.throws(() => checkNewWindow(noUrl), failure('R255-window-url'));
  // Allow может не существовать в версии Rust enum: свидетель проверяет контракт, не компиляцию.
  const allow = once(rust, 'return NewWindowResponse::Deny;', 'return NewWindowResponse::Allow;');
  assert.throws(() => checkNewWindow(allow), failure('R255-window-deny'));
});

it('R255 Rust: load вместо swap и перенос расходования за проверку адреса ловятся [arm-consume/order]', () => {
  checkConsume(rust);
  const load = once(rust, 'ARMED_UNTIL.swap(0, Ordering::SeqCst)', 'ARMED_UNTIL.load(Ordering::SeqCst)');
  assert.throws(() => checkConsume(load), failure('R255-arm-consume'));
  checkNewWindow(rust);
  const late = once(rust,
    'let armed = take_arm();\n    if !armed || url.as_str() != "about:blank"',
    'if url.as_str() != "about:blank" || !take_arm()');
  assert.throws(() => checkNewWindow(late), failure('R255-window-consume-order'));
});

it('R255 Rust: ровно 5000 мс допустимы, 5001 и неиспользуемая константа нет [arm-deadline/store]', () => {
  checkDeadline(rust);
  const declaration = lexical(rust).code.match(/\bconst\s+ARM_MS\s*:\s*u64\s*=\s*[\d_]+\s*;/)?.[0];
  assert.ok(declaration, 'R255-mutation-anchor: объявление срока найдено');
  checkDeadline(once(rust, declaration, 'const ARM_MS: u64 = 5000;'));
  assert.throws(() => checkDeadline(once(rust, declaration, 'const ARM_MS: u64 = 5001;')), failure('R255-arm-deadline'));
  const unused = once(rust, 'ARMED_UNTIL.store(now_ms() + ARM_MS,', 'ARMED_UNTIL.store(now_ms() + 6000,');
  assert.throws(() => checkDeadline(unused), failure('R255-arm-deadline-store'));
});

it('R255 Rust: прямое закрытие без thread::spawn не проходит [close-thread]', () => {
  checkClose(rust);
  const direct = once(rust, 'std::thread::spawn(move || {\n                    let _ = w.destroy();\n                });', 'let _ = w.destroy();');
  assert.throws(() => checkClose(direct), failure('R255-close-thread'));
});

it('R255 Rust: отсутствие async, отказа чужому окну и защитных флагов обнаруживается [arm-origin/flags]', () => {
  checkArm(rust);
  assert.throws(() => checkArm(once(rust, 'pub async fn gv_pip_arm(', 'pub fn gv_pip_arm(')), failure('R255-arm-async'));
  assert.throws(() => checkArm(once(rust, 'if window.label() != "main"', 'if window.label() == "main"')), failure('R255-arm-origin'));
  checkBuilder(rust);
  for (const [method, value] of [['always_on_top', 'true'], ['skip_taskbar', 'true'], ['minimizable', 'false'], ['focused', 'false']]) {
    const changed = once(rust, `.${method}(${value})`, `.${method}(${value === 'true' ? 'false' : 'true'})`);
    assert.throws(() => checkBuilder(changed), failure('R255-window-flags'));
  }
});
