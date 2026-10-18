import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { it } from 'node:test';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rust = read('../../desktop/src-tauri/src/lib.rs');
const baseConfig = read('../../desktop/src-tauri/tauri.conf.json');
const windowsConfig = read('../../desktop/src-tauri/tauri.windows.conf.json');
const capabilityDirectory = new URL('../../desktop/src-tauri/capabilities/', import.meta.url);
const capabilities = readdirSync(capabilityDirectory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name, raw: readFileSync(new URL(name, capabilityDirectory), 'utf8') }));

function failure(prefix: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
}

function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `R255-mutation-anchor: единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

// Сохраняем позиции и строки: комментарий не может притвориться командой, а скобка в строке — кодом.
// Rust допускает вложенные /* */ и raw-строки; простое удаление через regexp здесь ненадёжно.
function rustViews(source: string) {
  const code = source.split('');
  const structure = source.split('');
  const erase = (target: string[], start: number, end: number) => {
    for (let j = start; j < end; j++) if (target[j] !== '\n') target[j] = ' ';
  };
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i + 2);
      i = newline < 0 ? source.length : newline;
      erase(code, start, i);
      erase(structure, start, i);
    } else if (source.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      assert.equal(depth, 0, 'R255-lex-comment: комментарий закрыт');
      erase(code, start, i);
      erase(structure, start, i);
    } else {
      const raw = /^(?:br|r)(#*)"/.exec(source.slice(i));
      const character = /^'(?:\\.|[^'\\\n])'/.exec(source.slice(i));
      if (raw) {
        const end = source.indexOf(`"${raw[1]}`, i + raw[0].length);
        assert.notEqual(end, -1, 'R255-lex-string: raw-строка закрыта');
        i = end + raw[1].length + 1;
      } else if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
        assert.ok(i < source.length, 'R255-lex-string: строка закрыта');
        i++;
      } else if (character) i += character[0].length;
      else { i++; continue; }
      erase(structure, start, i);
    }
  }
  return { code: code.join(''), structure: structure.join('') };
}

function balanced(source: string, start: number) {
  const view = rustViews(source);
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  assert.ok(pairs[view.structure[start]], 'R255-scope-open: начало области — открывающая скобка');
  const stack: string[] = [];
  for (let i = start; i < view.structure.length; i++) {
    const char = view.structure[i];
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === ')' || char === ']' || char === '}') {
      assert.equal(char, stack.pop(), 'R255-scope-balanced: скобки вложены правильно');
      if (stack.length === 0) return { body: view.code.slice(start + 1, i), start, end: i + 1 };
    }
  }
  assert.fail('R255-scope-end: область закрыта');
}

function functionBody(source: string, name: string) {
  const code = rustViews(source).code;
  const declaration = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(code);
  assert.ok(declaration, `R255-function: найдена функция ${name}`);
  return balanced(code, code.indexOf('{', declaration.index)).body;
}

function checkRegistration(source = rust) {
  const code = rustViews(source).code;
  const macro = /\btauri::generate_handler!\s*\[/.exec(code);
  assert.ok(macro, 'R255-handler: найден generate_handler');
  const body = balanced(code, macro.index + macro[0].lastIndexOf('[')).body;
  const rows = body.split('\n').map((row) => row.trim()).filter(Boolean);
  const commands = rows.flatMap((row, index) => row.includes('pip::gv_pip_arm') ? [{ row, index }] : []);
  assert.equal(commands.length, 1, 'R255-pip-registration: команда зарегистрирована один раз');
  assert.equal(commands[0].row, 'pip::gv_pip_arm,', 'R255-pip-command-line: команда стоит на отдельной строке');
  assert.equal(rows[commands[0].index - 1], '#[cfg(desktop)]', 'R255-pip-cfg: собственный cfg(desktop) прямо перед командой');
}

function checkSetup(source = rust) {
  const code = rustViews(source).code;
  const setup = /\.setup\s*\(\s*\|_app\|\s*\{/.exec(code);
  assert.ok(setup, 'R255-setup: найдена setup-closure');
  const body = balanced(code, setup.index + setup[0].lastIndexOf('{')).body;
  assert.match(body, /^\s*build_main_window\(_app\.handle\(\)\)\?;/,
    'R255-setup-first: главное окно создаётся до любой другой операции setup');
}

function mobileBranch(source: string) {
  const body = functionBody(source, 'build_main_window');
  const mobile = /#\[cfg\(mobile\)\]\s*\{/.exec(body);
  assert.ok(mobile, 'R255-main-mobile: мобильная ветка существует');
  const start = mobile.index + mobile[0].lastIndexOf('{');
  return { ...balanced(body, start), attributeStart: mobile.index, functionBody: body };
}

function checkMobile(source = rust) {
  const branch = mobileBranch(source).body;
  assert.match(branch, /app\.get_webview_window\("main"\)\.is_some\(\)/,
    'R255-main-mobile-existing: готовое главное окно не создаётся повторно');
  assert.match(branch, /app\.config\(\)\.app\.windows\.iter\(\)\.find\(\|w\|\s*w\.label\s*==\s*"main"\)/,
    'R255-main-mobile-config: берётся конфигурация именно main');
  assert.match(branch, /tauri::WebviewWindowBuilder::from_config\(app,\s*&cfg\)\?\s*\.build\(\)\?;/,
    'R255-main-mobile-build: мобильное окно действительно строится из конфига');
}

function checkDesktop(source = rust) {
  const body = functionBody(source, 'build_main_window');
  assert.match(body, /#\[cfg\(desktop\)\]\s*\{\s*pip::build_main\(app\)\s*\}/,
    'R255-main-desktop: десктоп строит main через PiP-обработчик');
}

function checkVisibility(source = rust) {
  const body = functionBody(source, 'set_main_webview_shown');
  const pin = /\blet\s+shown\s*=\s*shown\s*\|\|\s*pip::any_open\(\)\s*;/.exec(body);
  assert.ok(pin, 'R255-pip-visible: открытый PiP удерживает родительскую страницу видимой');
  const swap = body.indexOf('WEBVIEW_SHOWN.swap(shown,');
  assert.ok(swap > pin.index + pin[0].length, 'R255-pip-visible-order: состояние PiP учтено до swap');
  assert.match(body, /SetIsVisible\(shown\)/, 'R255-pip-visible-apply: WebView получает вычисленную видимость');
}

function checkEntryPoint(source = rust) {
  assert.match(rustViews(source).code, /#\[cfg_attr\(mobile,\s*tauri::mobile_entry_point\)\]\s*pub\s+fn\s+run\s*\(/,
    'R255-mobile-entry: атрибут точки входа относится непосредственно к run');
}

function mainConfig(raw: string) {
  const config = JSON.parse(raw);
  const windows = config.app?.windows as Array<Record<string, unknown>> | undefined;
  const mains = windows?.filter((window) => window.label === 'main') ?? [];
  assert.equal(mains.length, 1, 'R255-config-main: main объявлен ровно один раз');
  return mains[0];
}

function checkBaseConfig(raw = baseConfig) {
  assert.equal(mainConfig(raw).create, false, 'R255-main-create-base: общий main создаётся вручную');
}

function checkWindowsConfig(raw = windowsConfig) {
  const main = mainConfig(raw);
  assert.equal(main.create, false, 'R255-main-create-windows: Windows main создаётся вручную');
  assert.deepEqual(main, { ...mainConfig(baseConfig), visible: false },
    'R255-main-config-drift: Windows main совпадает с общим, кроме visible:false (контракт R240)');
}

// Консервативно проверяем пересечение с семейством pip-*: метасимволы в начале не считаем безопасными.
// При этом main*, overlay-* и другие заведомо чужие префиксы не блокируются.
function mayTargetPip(pattern: string) {
  const firstMeta = pattern.search(/[*?\[\]{}\\]/);
  if (firstMeta < 0) return pattern.startsWith('pip-');
  const literalPrefix = pattern.slice(0, firstMeta);
  return literalPrefix.startsWith('pip-') || 'pip-'.startsWith(literalPrefix);
}

function checkCapabilities(entries = capabilities) {
  assert.ok(entries.length > 0, 'R255-capabilities-present: найдены capability-конфиги');
  for (const { name, raw } of entries) {
    const capability = JSON.parse(raw);
    assert.ok(Array.isArray(capability.permissions), `R255-capability-permissions: список прав в ${name}`);
    if (capability.permissions.length === 0) continue;
    for (const field of ['windows', 'webviews']) {
      const labels: unknown = capability[field];
      if (labels === undefined) continue;
      assert.ok(Array.isArray(labels), `R255-capability-labels: список ${field} в ${name}`);
      for (const label of labels) {
        assert.equal(typeof label, 'string', `R255-capability-label-type: строковая метка в ${name}`);
        assert.equal(mayTargetPip(label), false, `R255-pip-capability: ${name} не выдаёт права ${field}=${label}`);
      }
    }
  }
}

it('PiP-команда доступна только на десктопе и имеет собственный cfg', () => checkRegistration());
it('создание main — первая операция setup, до остальных окон и плагинов', () => checkSetup());
it('телефон при create:false всё равно создаёт main из своего конфига', () => checkMobile());
it('десктоп создаёт main с обработчиком новых PiP-окон', () => checkDesktop());
it('открытый PiP сохраняет отрисовку родителя до записи флага видимости', () => checkVisibility());
it('точкой входа Android остаётся run, а не соседняя команда', () => checkEntryPoint());
it('общий main не создаётся Tauri автоматически', () => checkBaseConfig());
it('Windows main создаётся вручную и сохраняет контракт заставки R240', () => checkWindowsConfig());
it('все штатные capabilities main, overlay и других окон не дают прав PiP', () => checkCapabilities());

it('мутант: удалённая мобильная ветка, оставленная в комментарии, обнаруживается', () => {
  checkMobile(rust);
  const branch = mobileBranch(rust);
  const original = branch.functionBody.slice(branch.attributeStart, branch.end);
  const mutant = replaceOnce(rust, original, `/* ${original} */`);
  assert.throws(() => checkMobile(mutant), failure('R255-main-mobile:'));
});

it('мутант: закомментированный cfg у PiP-команды не защищает Android', () => {
  checkRegistration(rust);
  const mutant = replaceOnce(rust, '#[cfg(desktop)]\n            pip::gv_pip_arm,',
    '// #[cfg(desktop)]\n            pip::gv_pip_arm,');
  assert.throws(() => checkRegistration(mutant), failure('R255-pip-cfg:'));
});

it('мутант: cfg и команда на одной строке нарушают адресную регистрацию', () => {
  checkRegistration(rust);
  const mutant = replaceOnce(rust, '#[cfg(desktop)]\n            pip::gv_pip_arm,', '#[cfg(desktop)] pip::gv_pip_arm,');
  assert.throws(() => checkRegistration(mutant), failure('R255-pip-command-line:'));
});

it('мутант: операция до создания main в setup обнаруживается', () => {
  checkSetup(rust);
  const mutant = replaceOnce(rust, 'build_main_window(_app.handle())?;', 'prepare(); build_main_window(_app.handle())?;');
  assert.throws(() => checkSetup(mutant), failure('R255-setup-first:'));
});

it('мутант: сворачивание родителя больше не учитывает открытый PiP', () => {
  checkVisibility(rust);
  const mutant = replaceOnce(rust, 'let shown = shown || pip::any_open();', 'let shown = shown;');
  assert.throws(() => checkVisibility(mutant), failure('R255-pip-visible:'));
});

it('мутант: проверка PiP после swap слишком поздняя и отклоняется', () => {
  checkVisibility(rust);
  let mutant = replaceOnce(rust, 'let shown = shown || pip::any_open();', '');
  mutant = replaceOnce(mutant, 'if WEBVIEW_SHOWN.swap(shown, Ordering::Relaxed) == shown {',
    'if WEBVIEW_SHOWN.swap(shown, Ordering::Relaxed) == shown {\nlet shown = shown || pip::any_open();');
  assert.throws(() => checkVisibility(mutant), failure('R255-pip-visible-order:'));
});

it('мутант: чужая функция не может перехватить мобильный атрибут run', () => {
  checkEntryPoint(rust);
  const mutant = replaceOnce(rust, '#[cfg_attr(mobile, tauri::mobile_entry_point)]',
    '#[cfg_attr(mobile, tauri::mobile_entry_point)]\nfn accidental_entry() {}');
  assert.throws(() => checkEntryPoint(mutant), failure('R255-mobile-entry:'));
});

it('мутант: автоматическое создание main в общем конфиге обнаруживается', () => {
  checkBaseConfig(baseConfig);
  const mutant = replaceOnce(baseConfig, '"create": false', '"create": true');
  assert.throws(() => checkBaseConfig(mutant), failure('R255-main-create-base:'));
});

it('мутант: автоматическое создание main в Windows-конфиге обнаруживается', () => {
  checkWindowsConfig(windowsConfig);
  const mutant = replaceOnce(windowsConfig, '"create": false', '"create": true');
  assert.throws(() => checkWindowsConfig(mutant), failure('R255-main-create-windows:'));
});

for (const label of ['pip-*', '*', 'p*']) {
  it(`мутант: capability с меткой ${label} открывает права PiP и отклоняется`, () => {
    checkCapabilities(capabilities);
    const original = capabilities.find(({ name }) => name === 'default.json');
    assert.ok(original, 'R255-mutation-capability: штатный default.json существует');
    const parsed = JSON.parse(original.raw);
    parsed.windows = ['main', label];
    const mutant = capabilities.map((entry) => entry === original ? { ...entry, raw: JSON.stringify(parsed) } : entry);
    assert.throws(() => checkCapabilities(mutant), failure('R255-pip-capability:'));
  });
}

it('безопасные префиксы capabilities принимаются, а замаскированные PiP-перечни отклоняются', () => {
  checkCapabilities([{ name: 'no-rights.json', raw: JSON.stringify({ windows: ['pip-*'], permissions: [] }) }]);
  for (const field of ['windows', 'webviews']) {
    for (const label of ['main', 'overlay', 'toast', 'main*', 'overlay-*', 'notify*', 'splash', 'pip']) {
      checkCapabilities([{ name: 'safe.json', raw: JSON.stringify({ [field]: [label], permissions: ['core:default'] }) }]);
    }
    for (const label of ['pip-1', '?ip-*', '[p]ip-*', '{main,pip-*}', '*pip*']) {
      assert.throws(() => checkCapabilities([{ name: 'unsafe.json',
        raw: JSON.stringify({ [field]: [label], permissions: ['core:default'] }) }]), failure('R255-pip-capability:'));
    }
  }
});
