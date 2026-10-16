import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const root = '../../desktop/src-tauri/gen/android/app/src/main/';
const kotlin = (name: string) => readFileSync(new URL(`${root}java/tech/gusik/gusvoice/${name}.kt`, import.meta.url), 'utf8');
const share = kotlin('ShareIntent');
const media = kotlin('MediaBridge');
const activity = kotlin('MainActivity');
const manifest = readFileSync(new URL(`${root}AndroidManifest.xml`, import.meta.url), 'utf8');

// AST-стражи проверяют проводку лимита, а не исполняют вырезанный фрагмент компонента.
function nodes(source: string, predicate: (node: ts.Node) => boolean): { tree: ts.SourceFile; found: ts.Node[] } {
  const tree = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  return { tree, found };
}

describe('R140 лимит крупного видео проходит от листа до камеры и Android', () => {
  it('мост принимает 1032 МиБ с запасом для контейнера вместо обрезания файла 1 ГиБ', () => {
    // Меньший предел промежуточного моста ломает файл ещё до серверной загрузки.
    rejects(media, 'const val PUT_MAX = 1032L', 'const val PUT_MAX = 512L', (source) => {
      assert.match(code(source), /const val PUT_MAX\s*=\s*1032L\s*\*\s*1024\s*\*\s*1024/);
      assert.match(code(source), /p\.bytes\s*>\s*PUT_MAX/);
    });
  });

  it('камера по умолчанию сохраняет предел канала, но вычисляет предел записи из maxBytes', () => {
    // Без проводки пропса ЛС разрешает большой файл, а камера всё равно останавливается на 25 МБ.
    const source = readFileSync(new URL('./components/CameraScreen.tsx', import.meta.url), 'utf8');
    const check = (raw: string) => {
      const bindings = nodes(raw, (node) => ts.isBindingElement(node) && node.name.getText() === 'maxBytes');
      assert.equal(bindings.found.length, 1);
      assert.equal((bindings.found[0] as ts.BindingElement).initializer?.getText(bindings.tree), 'ATTACH_MAX_BYTES');
      const calls = nodes(raw, (node) => ts.isCallExpression(node) && node.expression.getText() === 'startRecording');
      assert.equal(calls.found.length, 1);
      const opts = (calls.found[0] as ts.CallExpression).arguments[2];
      assert.ok(opts && ts.isObjectLiteralExpression(opts));
      const props = opts.properties.filter((p) => ts.isPropertyAssignment(p) && p.name.getText(calls.tree) === 'softLimit');
      assert.equal(props.length, 1);
      assert.equal((props[0] as ts.PropertyAssignment).initializer.getText(calls.tree), 'videoSoftLimit(maxBytes)');
    };
    rejects(source, 'softLimit: videoSoftLimit(maxBytes)', 'softLimit: videoSoftLimit()', check);
    rejects(source, 'maxBytes = ATTACH_MAX_BYTES', 'maxBytes = 1024', check);
  });

  it('лист передаёт камере собственный maxBytes, а не предел по умолчанию', () => {
    // Проверяем именно JSX CameraScreen: соседний maxBytes в отправке не доказывает проводку камеры.
    const source = readFileSync(new URL('./components/MediaSheet.tsx', import.meta.url), 'utf8');
    const check = (raw: string) => {
      const result = nodes(raw, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'CameraScreen');
      assert.equal(result.found.length, 1);
      const element = result.found[0] as ts.JsxSelfClosingElement;
      const props = element.attributes.properties.filter((p) => ts.isJsxAttribute(p) && p.name.getText(result.tree) === 'maxBytes');
      assert.equal(props.length, 1);
      const value = (props[0] as ts.JsxAttribute).initializer;
      assert.ok(value && ts.isJsxExpression(value));
      assert.equal(value.expression?.getText(result.tree), 'maxBytes');
    };
    // Ограничиваем мутацию единственным тегом камеры: maxBytes есть также у списка и выбора файлов.
    const { tree, found } = nodes(source, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'CameraScreen');
    assert.equal(found.length, 1);
    const tag = found[0]!.getText(tree);
    rejects(source, tag, tag.replace('maxBytes={maxBytes}', 'maxBytes={25 * 1024 * 1024}'), check);
  });
});

// Статические стражи, не исполнение Kotlin: комментарий не может заменить проверку.
// Сохраняем строки (в том числе content://), чтобы // внутри них не стало комментарием.
function code(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => token.startsWith('/') ? ' ' : token);
}

function body(source: string, name: string): string {
  const clean = code(source);
  const start = new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(clean);
  assert.ok(start, `найдена функция ${name}`);
  const offset = start.index + start[0].length;
  let depth = 1;
  // Не считаем фигурные скобки в строках и шаблонах Kotlin.
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = offset;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(offset, token.index);
  }
  assert.fail(`закрыта функция ${name}`);
}

function rejects(source: string, target: string, replacement: string, check: (source: string) => void): void {
  check(source);
  assert.equal(source.split(target).length - 1, 1, 'мутант меняет ровно одно место настоящего исходника');
  const mutant = source.replace(target, replacement);
  assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), assert.AssertionError, 'удаление защиты обязано покраснить страж');
}

function rejectsIn(source: string, name: string, target: string, replacement: string, check: (source: string) => void): void {
  const b = body(source, name);
  assert.equal(b.split(target).length - 1, 1, 'одно место в выбранной функции');
  rejects(code(source), b, b.replace(target, replacement), check);
}

function filters(source: string): string[] {
  const xml = source.replace(/<!--[\s\S]*?-->/g, '');
  const main = [...xml.matchAll(/<activity\b([^>]*)>([\s\S]*?)<\/activity>/g)]
    .find((match) => /android:name\s*=\s*"\.MainActivity"/.test(match[1]!));
  assert.ok(main, 'фильтры принадлежат MainActivity, не соседней активности');
  return [...main[2]!.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g)].map((match) => match[1]!);
}

function filterWith(source: string, action: string): string {
  const found = filters(source).filter((filter) => filter.includes(`android.intent.action.${action}"`));
  assert.equal(found.length, 1, `ровно один фильтр ${action}`);
  return found[0]!;
}

describe('R118 Android: безопасный вход системного «Поделиться»', () => {
  it('file URI не проходит: разрешён только content с отказом до проверки поставщика', () => {
    rejects(share, 'if (!uri.scheme.equals("content", ignoreCase = true)) return false', '', (source) => {
      const accepted = body(source, 'accepted');
      assert.match(accepted, /^\s*if\s*\(!uri\.scheme\.equals\("content",\s*ignoreCase\s*=\s*true\)\)\s*return false/);
      assert.match(body(source, 'parse'), /all\.filter\s*\{\s*accepted\(it,\s*packageName\)\s*\}/);
    });
  });

  it('поставщик нашего пакета отвергается, а условие не запрещает всех чужих поставщиков', () => {
    rejects(share, 'auth != pkg && ', '', (source) => {
      assert.match(body(source, 'accepted'), /return\s+auth\s*!=\s*pkg\s*&&\s*!auth\.startsWith/);
    });
  });

  it('любые подпоставщики нашего пакета отвергаются, а не только fileprovider', () => {
    rejects(share, ' && !auth.startsWith("$pkg.")', '', (source) => {
      assert.match(body(source, 'accepted'), /return\s+auth\s*!=\s*pkg\s*&&\s*!auth\.startsWith\("\$pkg\."\)/);
      assert.match(body(source, 'accepted'), /val raw\s*=\s*uri\.encodedAuthority\s*\?:\s*return false/);
    });
  });

  it('R140 известный размер больше SHARE_MAX 1 ГиБ отвергается до чтения дескриптора, ровно предел не запрещён', () => {
    rejects(media, 'if (size > SHARE_MAX) return SharedFile(name, mime, size, null, "too-big")', '', (source) => {
      const copy = body(source, 'copyShared');
      const guard = /if\s*\(size\s*>\s*SHARE_MAX\)\s*return SharedFile\(name,\s*mime,\s*size,\s*null,\s*"too-big"\)/.exec(copy);
      assert.ok(guard);
      assert.ok(copy.indexOf('afd.createInputStream()') > guard.index, 'лимит проверен до чтения');
      assert.match(code(source), /const val SHARE_MAX\s*=\s*1024L\s*\*\s*1024\s*\*\s*1024/);
    });
  });

  it('неизвестный размер контролируется по прочитанным байтам до записи очередной порции', () => {
    rejects(media, 'if (total > SHARE_MAX)', 'if (false)', (source) => {
      const copy = body(source, 'copyShared');
      assert.match(copy, /total\s*\+=\s*n\s*if\s*\(total\s*>\s*SHARE_MAX\)\s*\{\s*o\.close\(\)\s*out\.delete\(\)\s*return SharedFile\(name,\s*mime,\s*total,\s*null,\s*"too-big"\)\s*\}\s*o\.write\(buf,\s*0,\s*n\)/);
    });
  });

  it('R127 уже скопированное большое вложение передаётся клиенту с SHARE_MAX, не со старым пределом 25 МиБ', () => {
    // Копирование 1 ГиБ бесполезно, если второй этап sharedOpen молча обрезает поток на DEFAULT_MAX.
    const check = (source: string) => {
      assert.match(body(source, 'sharedOpen'), /streamOne\(proxy, id, i, Uri\.fromFile\(file\), f\.name, f\.mime, SHARE_MAX\)/);
      assert.match(code(source), /const val SHARE_MAX\s*=\s*1024L\s*\*\s*1024\s*\*\s*1024/);
    };
    rejectsIn(media, 'sharedOpen', 'f.mime, SHARE_MAX)', 'f.mime, DEFAULT_MAX)', check);
    rejects(media, 'const val SHARE_MAX = 1024L', 'const val SHARE_MAX = 512L', check);
  });

  it('пересоздание активности не предлагает старое вложение снова, новый intent обрабатывается', () => {
    rejects(activity, 'if (savedInstanceState == null) media.onShareIntent(intent)', 'media.onShareIntent(intent)', (source) => {
      assert.match(body(source, 'onCreate'), /if\s*\(savedInstanceState\s*==\s*null\)\s*media\.onShareIntent\(intent\)/);
      assert.match(body(source, 'onNewIntent'), /media\.onShareIntent\(intent\)/);
    });
  });

  for (const [action, mimes] of [
    ['SEND', ['text/*', 'image/*', 'video/*', 'audio/*', '*/*']],
    ['SEND_MULTIPLE', ['image/*', 'video/*', '*/*']],
  ] as const) {
    it(`${action} принимается MainActivity через DEFAULT с прежним набором типов`, () => {
      const check = (source: string) => {
        const filter = filterWith(source, action);
        assert.match(filter, /<category\s+android:name="android\.intent\.category\.DEFAULT"\s*\/>/);
        for (const mime of mimes) assert.ok(filter.includes(`android:mimeType="${mime}"`), mime);
      };
      rejects(manifest, `<action android:name="android.intent.action.${action}" />`, '', check);
      const original = filterWith(manifest, action);
      rejects(manifest, original, original.replace('<category android:name="android.intent.category.DEFAULT" />', ''), check);
      for (const mime of mimes) rejects(manifest, original, original.replace(`<data android:mimeType="${mime}" />`, ''), check);
    });
  }

  it('новые share-фильтры не вытесняют запуск приложения и приглашение gusvoice', () => {
    const check = (source: string) => {
      const launcher = filterWith(source, 'MAIN');
      for (const category of ['LAUNCHER', 'LEANBACK_LAUNCHER']) assert.ok(launcher.includes(`android.intent.category.${category}"`));
      const view = filterWith(source, 'VIEW');
      for (const category of ['DEFAULT', 'BROWSABLE']) assert.ok(view.includes(`android.intent.category.${category}"`));
      assert.match(view, /<data\s+android:scheme="gusvoice"\s*\/>/);
    };
    for (const action of ['MAIN', 'VIEW']) rejects(manifest, `<action android:name="android.intent.action.${action}" />`, '', check);
    for (const category of ['LAUNCHER', 'LEANBACK_LAUNCHER', 'BROWSABLE']) rejects(manifest, `<category android:name="android.intent.category.${category}" />`, '', check);
    const view = filterWith(manifest, 'VIEW');
    rejects(manifest, view, view.replace('<category android:name="android.intent.category.DEFAULT" />', ''), check);
    rejects(manifest, '<data android:scheme="gusvoice" />', '', check);
  });
});

describe('R119 Android: второй рубеж и отмена входящих файлов', () => {
  it('userId@, кодирование и регистр не маскируют свой provider; media остаётся чужим', () => {
    const check = (source: string) => {
      const b = body(source, 'accepted');
      assert.match(b, /val auth = Uri\.decode\(raw\.substringAfterLast\('@'\)\)\.lowercase\(\)/);
      assert.match(b, /val pkg = packageName\.lowercase\(\)/);
      assert.match(b, /if \(auth\.isEmpty\(\)\) return false/);
      assert.match(b, /return auth != pkg && !auth\.startsWith\("\$pkg\."\)/);
      // Это структура Kotlin, не JS-копия правил: 0@media не совпадёт ни с pkg, ни с pkg+'.'.
    };
    for (const [target, replacement] of [
      ["raw.substringAfterLast('@')", 'raw'], ['Uri.decode(raw.substringAfterLast(\'@\'))', "raw.substringAfterLast('@')"],
      ["Uri.decode(raw.substringAfterLast('@')).lowercase()", "Uri.decode(raw.substringAfterLast('@'))"],
      ['packageName.lowercase()', 'packageName'], ['if (auth.isEmpty()) return false', ''],
    ]) rejectsIn(share, 'accepted', target!, replacement!, check);
  });

  it('неизвестный путь закрыт; pipe и внешняя память не объявлены приватными', () => {
    const check = (source: string) => {
      const b = body(source, 'ownPath');
      assert.match(b, /^\s*if \(path\.isNullOrEmpty\(\) \|\| path\.length > 4096\) return true/);
      assert.match(b, /if \(!path\.startsWith\("\/"\)\) return false/);
      assert.match(b, /val p = \(if \(path\.endsWith\("\/"\)\) path else "\$path\/"\)\.lowercase\(\)/);
    };
    rejects(share, 'path.isNullOrEmpty() || ', '', check);
    rejects(share, 'path.length > 4096', 'path.length > 8192', check);
    rejects(share, 'if (!path.startsWith("/")) return false', '', check);
  });

  it('data/data, user и user_de учитывают границу пакета, package2 и storage не совпадают', () => {
    const check = (source: string) => {
      const b = body(source, 'ownPath');
      assert.ok(b.includes('if (p.contains("/data/data/$pkg/")) return true'));
      assert.ok(b.includes('Regex("/user(_de)?/[0-9]+/" + Regex.escape(pkg) + "/").containsMatchIn(p)'));
      assert.match(b, /val pkg = packageName\.lowercase\(\)/);
      assert.match(b, /val dir = d\.trimEnd\('\/'\)\.lowercase\(\)/);
      assert.match(b, /dir\.isNotEmpty\(\) && p\.startsWith\("\$dir\/"\)/);
      assert.match(b, /return ownDirs\.any/);
      // /data/data/pkg без конечного '/' дополняется выше; pkg2 не совпадает из-за границы '/'.
      // /data/user/0/pkg/cache/x и /data/user_de/0/pkg/x охвачены (_de)? + номером + той же границей.
      // /storage/emulated/0/x не совпадает ни с data/data, ни с user; pipe отсечён до этих веток.
    };
    for (const target of ['if (p.contains("/data/data/$pkg/")) return true',
      'if (Regex("/user(_de)?/[0-9]+/" + Regex.escape(pkg) + "/").containsMatchIn(p)) return true']) rejects(share, target, '', check);
    rejects(share, 'p.startsWith("$dir/")', 'p.startsWith(dir)', check);
    rejects(share, 'Regex.escape(pkg)', 'pkg', check);
    rejectsIn(share, 'ownPath', 'packageName.lowercase()', 'packageName', check);
    rejects(share, '(_de)?', '', check);
  });

  it('настоящий FD проверен до потока; пути процесса включают канонические и device-protected каталоги', () => {
    const check = (source: string) => {
      const b = body(source, 'copyShared');
      const guard = b.indexOf('if (ShareIntent.ownPath(fdPath(afd), activity.packageName, ownDirs))');
      const read = b.indexOf('afd.createInputStream()');
      assert.ok(guard >= 0 && read > guard);
      assert.match(b.slice(guard, read), /return SharedFile\(name, mime, -1L, null, "unreadable"\)/);
      const dirs = body(source, 'ownDirs');
      for (const name of ['cacheDir', 'filesDir', 'codeCacheDir', 'noBackupFilesDir', 'applicationInfo.dataDir', 'createDeviceProtectedStorageContext().dataDir', 'canonicalPath']) assert.ok(dirs.includes(name));
      assert.match(code(source), /Os\.readlink\("\/proc\/self\/fd\/\$\{afd\.parcelFileDescriptor\.fd\}"\)/);
    };
    rejects(media, 'if (ShareIntent.ownPath(fdPath(afd), activity.packageName, ownDirs))', 'if (false)', check);
    rejects(media, 'dirs.add(activity.createDeviceProtectedStorageContext().dataDir)', '', check);
  });

  it('медленный provider не занимает однопоточный io; новое поколение убивает старое и не публикует его', () => {
    const check = (source: string) => {
      assert.match(code(source), /shareCopy: ExecutorService = Executors\.newCachedThreadPool\(\)/);
      const b = body(source, 'onShareIntent');
      assert.match(b, /ShareJob\(shareGen\.incrementAndGet\(\), UUID\.randomUUID\(\)\.toString\(\)\)/);
      assert.match(b, /shareJob\?\.kill\(\)\s*shareJob = job/);
      assert.match(b, /shareCopy\.execute\s*\{[\s\S]*copyShared\(/);
      assert.match(b, /if \(bridgeOff \|\| shareGen\.get\(\) != job\.gen\) \{\s*dir\.deleteRecursively\(\)\s*return@publish\s*\}\s*shared = Shared/);
    };
    for (const [target, replacement] of [['shareCopy.execute {', 'io.execute {'], ['shareJob?.kill()', ''], ['shareGen.get() != job.gen', 'false']]) rejectsIn(media, 'onShareIntent', target!, replacement!, check);
  });

  it('R140 360 секунд общие на все файлы, signal прерывает provider и kill закрывает открытые FD', () => {
    const check = (source: string) => {
      assert.match(code(source), /const val SHARE_COPY_MS = 360_000L/);
      const b = body(source, 'onShareIntent');
      assert.match(b, /main\.postDelayed\(\{ if \(!job\.dead\) job\.kill\(\) \}, SHARE_COPY_MS\)/);
      assert.match(b, /val deadline = SystemClock\.elapsedRealtime\(\) \+ SHARE_COPY_MS\s*val files = parsed\.uris\.mapIndexed/);
      const c = body(source, 'copyShared');
      assert.match(c, /docMeta\(uri, job\.signal\)/);
      assert.match(body(source, 'docMeta'), /cr\.query\(uri, arrayOf\(OpenableColumns\.DISPLAY_NAME\), null, null, null, signal\)/);
      assert.match(c, /openAssetFileDescriptor\(uri, "r", job\.signal\)/);
      assert.match(c, /if \(job\.dead \|\| SystemClock\.elapsedRealtime\(\) > deadline\) throw IOException/);
      assert.match(body(source, 'kill'), /dead = true[\s\S]*signal\.cancel\(\)[\s\S]*open\.toList\(\)\.forEach\s*\{[\s\S]*it\.close\(\)/);
      assert.match(c, /job\.open\.add\(afd\)/);
      assert.match(c, /finally\s*\{\s*afd\?\.let\s*\{\s*job\.open\.remove\(it\)[\s\S]*it\.close\(\)/);
    };
    for (const [target, replacement] of [['360_000L', '180_000L'], ['signal.cancel()', ''], ['job.dead || SystemClock.elapsedRealtime() > deadline', 'job.dead'], ['docMeta(uri, job.signal)', 'docMeta(uri)'], ['openAssetFileDescriptor(uri, "r", job.signal)', 'openAssetFileDescriptor(uri, "r")'], ['job.open.add(afd)', ''], ['job.open.remove(it)', '']]) rejects(media, target!, replacement!, check);
    rejectsIn(media, 'kill', 'it.close()', '', check);
    rejectsIn(media, 'docMeta', 'null, null, null, signal)', 'null, null, null)', check);
  });

  it('ошибка или поздняя отмена стирает частичную копию вместо отправки её как готовой', () => {
    const check = (source: string) => {
      const c = body(source, 'copyShared');
      assert.match(c, /if \(job\.dead\) throw IOException\("share copy cancelled"\)\s*SharedFile\(name, mime, total, out, null\)/);
      assert.match(c, /catch \(e: Exception\) \{\s*out\.delete\(\)\s*SharedFile\(name, mime, -1L, null, "unreadable"\)/);
    };
    rejects(media, 'if (job.dead) throw IOException("share copy cancelled")', '', check);
    const c = body(media, 'copyShared');
    rejects(code(media), c, c.replace(/(catch \(e: Exception\) \{\s*)out\.delete\(\)/, '$1'), check);
  });

  it('attach убирает брошенный inbox даже без моста, но с мостом сохраняет текущие токены', () => {
    const check = (source: string) => {
      const b = body(source, 'attach');
      assert.match(b, /if \(!on\) \{[\s\S]*File\(root, INBOX\)\.deleteRecursively\(\)[\s\S]*return\s*\}\s*webViewRef/);
      assert.match(b, /val keep = setOfNotNull\(shared\?\.token, shareJob\?\.token\)/);
      assert.match(b, /File\(root, INBOX\)\.listFiles\(\)\?\.forEach \{ if \(it\.name !in keep\) it\.deleteRecursively\(\) \}/);
    };
    rejects(media, 'File(root, INBOX).deleteRecursively()', '', check);
    rejects(media, 'if (it.name !in keep)', 'if (false)', check);
    rejects(media, 'setOfNotNull(shared?.token, shareJob?.token)', 'setOfNotNull(shared?.token)', check);
  });

  it('FileProvider публикует только clip/open/share/cam, не inbox, весь кеш или external', () => {
    const paths = readFileSync(new URL(`${root}res/xml/file_paths.xml`, import.meta.url), 'utf8');
    const check = (source: string) => {
      const xml = source.replace(/<!--[\s\S]*?-->/g, '');
      const entries = [...xml.matchAll(/<([\w-]+)\b([^>]*)\/>/g)];
      assert.equal(entries.length, 4);
      assert.deepEqual(entries.map(m => [m[1], /\bpath="([^"]+)"/.exec(m[2]!)?.[1]]),
        [['cache-path', 'gv-media/clip/'], ['cache-path', 'gv-media/open/'], ['cache-path', 'gv-media/share/'], ['cache-path', 'gv-media/cam/']]);
    };
    for (const name of ['clip', 'open', 'share', 'cam']) rejects(paths, `path="gv-media/${name}/"`, 'path="."', check);
    rejects(paths, 'path="gv-media/cam/"', 'path="gv-media/inbox/"', check);
    rejects(paths, '</paths>', '<external-path name="outside" path="." /></paths>', check);
  });
});
