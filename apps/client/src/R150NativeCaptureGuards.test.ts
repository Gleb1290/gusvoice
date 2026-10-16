import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = '../../desktop/src-tauri/gen/android/app/src/main/';
const read = (path: string) => readFileSync(new URL(root + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const media = read('java/tech/gusik/gusvoice/MediaBridge.kt');
const activity = read('java/tech/gusik/gusvoice/MainActivity.kt');
const manifest = read('AndroidManifest.xml');
function code(s: string) {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, t => t.startsWith('/') ? ' ' : t);
}
function body(s: string, name: string) {
  const clean = code(s);
  const start = new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(clean);
  assert.ok(start, `функция ${name} существует`);
  const offset = start.index + start[0].length;
  let depth = 1;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g; tokens.lastIndex = offset;
  for (let t = tokens.exec(clean); t; t = tokens.exec(clean)) {
    if (t[0] === '{') depth++;
    if (t[0] === '}' && --depth === 0) return clean.slice(offset, t.index);
  }
  assert.fail(`функция ${name} закрыта`);
}
function rejects(s: string, from: string, to: string, check: (s: string) => void) {
  check(s); assert.equal(s.split(from).length - 1, 1, 'контрфакт меняет одно место целого файла');
  assert.throws(() => check(s.replace(from, to)), assert.AssertionError);
}
describe('R150/R151 статическая проводка Android, не эмуляция платформы', () => {
  it('USER_SELECTED не объявлен и не запрашивается; обычные фото и видео остались', () => {
    const checkManifest = (s: string) => {
      const xml = s.replace(/<!--[\s\S]*?-->/g, '');
      assert.doesNotMatch(xml, /READ_MEDIA_VISUAL_USER_SELECTED/);
      assert.match(xml, /android\.permission\.READ_MEDIA_IMAGES/); assert.match(xml, /android\.permission\.READ_MEDIA_VIDEO/);
    };
    rejects(manifest, '</manifest>', '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" /></manifest>', checkManifest);
    const checkMedia = (s: string) => {
      assert.doesNotMatch(code(s), /Manifest\.permission\.READ_MEDIA_VISUAL_USER_SELECTED/);
      assert.match(code(s), /Manifest\.permission\.READ_MEDIA_IMAGES/); assert.match(code(s), /Manifest\.permission\.READ_MEDIA_VIDEO/);
    };
    rejects(media, 'private fun mediaPermissions()', 'private val removed = Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED\n  private fun mediaPermissions()', checkMedia);
  });
  it('blocked зависит от последнего отказа и rationale, не от прежнего показа окна', () => {
    const check = (s: string) => {
      assert.match(code(s), /KEY_DENIED\s*=\s*"perm_denied"/);
      const b = body(s, 'permState'); assert.match(b, /getBoolean\(KEY_DENIED, false\)/);
      assert.match(b, /if \(full\) return "granted"/);
      assert.match(b, /shouldShowRequestPermissionRationale\(it\)/);
      assert.match(b, /denied && !rationale\) "blocked" else "ask"/);
      assert.doesNotMatch(b, /KEY_ASKED|"partial"/);
      assert.match(body(s, 'onPermissionResult'), /putBoolean\(KEY_DENIED, permState\(\) != "granted"\)/);
    };
    rejects(media, 'val denied = prefs.getBoolean(KEY_DENIED, false)', 'val denied = prefs.getBoolean(KEY_ASKED, false)', check);
    rejects(media, 'denied && !rationale', 'denied', check);
  });
  it('ask запускает системное окно даже из blocked', () => {
    const check = (s: string) => {
      const b = body(s, 'perm'); assert.match(b, /if \(state == "granted" \|\| permWaiter != null\)/);
      assert.match(b, /activity\.launchMediaPermissions\(mediaPermissions\(\)\)/);
      assert.doesNotMatch(b, /state == "blocked"/);
    };
    rejects(media, 'state == "granted" || permWaiter != null', 'state == "granted" || state == "blocked" || permWaiter != null', check);
  });
  it('камера проверяет CAMERA, ждёт разрешения, сообщает отказ и занятость', () => {
    const check = (s: string) => {
      const b = body(s, 'capture'); assert.match(b, /captureWaiter != null[\s\S]*err\(id, "busy"\)/);
      assert.match(b, /if \(granted\(Manifest\.permission\.CAMERA\)\) \{\s*launchCapture\(w\)\s*return/);
      assert.match(b, /activity\.launchCameraPermission\(\)/);
      assert.match(body(s, 'onCameraPermission'), /if \(!ok\) \{[\s\S]*"camera-denied"[\s\S]*return[\s\S]*launchCapture\(w\)/);
      assert.match(code(s), /\.put\("capture", true\)/);
    };
    rejects(media, 'if (granted(Manifest.permission.CAMERA)) {\n      launchCapture(w)', 'if (true) {\n      launchCapture(w)', check);
    assert.match(manifest.replace(/<!--[\s\S]*?-->/g, ''), /android\.permission\.CAMERA/);
    assert.match(code(activity), /RequestPermission\(\)\) \{ media\.onCameraPermission\(it\) \}/);
    assert.match(code(activity), /requestCamera\.launch\(Manifest\.permission\.CAMERA\)/);
    assert.match(code(activity), /StartActivityForResult\(\)\) \{ media\.onCaptureResult\(it\.resultCode, it\.data\) \}/);
  });
  it('интент камеры выдаёт EXTRA_OUTPUT, ClipData, read/write и предел видео из запроса', () => {
    const check = (s: string) => {
      const b = body(s, 'launchCapture');
      assert.match(b, /if \(w\.video\) MediaStore\.ACTION_VIDEO_CAPTURE else MediaStore\.ACTION_IMAGE_CAPTURE/);
      assert.match(b, /putExtra\(MediaStore\.EXTRA_OUTPUT, uri\)/);
      assert.match(b, /FLAG_GRANT_WRITE_URI_PERMISSION or Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
      assert.match(b, /intent\.clipData = ClipData\.newRawUri\("", uri\)/);
      assert.match(b, /if \(w\.video\) intent\.putExtra\(MediaStore\.EXTRA_SIZE_LIMIT, w\.max\)/);
      assert.match(body(s, 'capture'), /req\.optLong\("max", DEFAULT_MAX\)/);
    };
    for (const [from, to] of [['.putExtra(MediaStore.EXTRA_OUTPUT, uri)', ''], ['intent.clipData = ClipData.newRawUri("", uri)', ''], ['Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION', 'Intent.FLAG_GRANT_READ_URI_PERMISSION'], ['MediaStore.EXTRA_SIZE_LIMIT, w.max', 'MediaStore.EXTRA_SIZE_LIMIT, DEFAULT_MAX']] as const) rejects(media, from, to, check);
  });
  it('отмена без файлов, результат потоковый, фото сжато, временный файл удаляется', () => {
    const check = (s: string) => {
      const b = body(s, 'onCaptureResult');
      assert.match(b, /resultCode != android\.app\.Activity\.RESULT_OK -> null/);
      assert.match(b, /w\.video -> data\?\.data/);
      assert.match(b, /if \(uri == null\) \{\s*w\.file\.delete\(\)[\s\S]*put\("done", true\)\.put\("cancelled", true\)[\s\S]*return@execute/);
      assert.match(b, /streamOne\(w\.proxy, w\.id, 0, uri,[^\n]*w\.max\)/);
      assert.match(b, /streamCompressed\(w\.proxy, w\.id, 0, uri,/);
      assert.match(b, /w\.file\.delete\(\)\s*cancelled\.remove\(w\.id\)/);
      assert.match(code(s), /PHOTO_MAX_SIDE\s*=\s*2560/); assert.match(code(s), /PHOTO_QUALITY\s*=\s*85/);
      assert.match(body(s, 'capture'), /dir\.listFiles\(\)\?\.forEach \{ it\.delete\(\) \}/);
      assert.match(code(s), /CAMERA_DIR\s*=\s*"cam"/);
    };
    rejects(media, 'w.file.delete()\n      cancelled.remove(w.id)', 'cancelled.remove(w.id)', check);
    rejects(media, 'w.file.delete()\n        reply(w.proxy, ok(w.id).put("done", true).put("cancelled", true))',
      'w.file.delete()\n        reply(w.proxy, ok(w.id).put("done", true))', check);
  });
  it('миниатюра просмотра ограничена 1440, не прежними 640 и не бесконечностью', () => {
    const check = (s: string) => assert.match(body(s, 'thumb'), /req\.optInt\("px", 320\)\.coerceIn\(64, 1440\)/);
    rejects(media, '.coerceIn(64, 1440)', '.coerceIn(64, 640)', check);
    rejects(media, '.coerceIn(64, 1440)', '', check);
  });
  it('R153 альбомы упорядочены: все медиа, все видео, камера, прочие; фото раньше видео', () => {
    const check = (s: string) => {
      const b = body(s, 'albums');
      assert.match(b, /LinkedHashMap<Long, Album>\(\)/);
      assert.match(b, /for \(video in listOf\(false, true\)\)/);
      assert.match(b, /MediaStore\.MediaColumns\.RELATIVE_PATH else "_data"/);
      assert.match(b, /MediaStore\.MediaColumns\.BUCKET_ID/); assert.match(b, /MediaStore\.MediaColumns\.BUCKET_DISPLAY_NAME/);
      assert.match(b, /DATE_ADDED\} DESC, \$\{BaseColumns\._ID\} DESC/);
      assert.match(b, /a\.count\+\+/); assert.match(b, /album\.count\+\+/);
      assert.match(b, /all\?\.let \{ put\(it, null\) \}\s*allVideos\?\.let \{ put\(it, "video"\) \}\s*camera\?\.let[\s\S]*for \(\(k, a\) in byId\) if \(k != camera\) put\(a, null\)/);
      assert.match(code(s), /"albums" -> work\.execute \{ albums\(proxy, id\) \}/);
    };
    rejects(media, 'for (video in listOf(false, true))', 'for (video in listOf(true, false))', check);
    rejects(media, 'if (k != camera) put(a, null)', 'put(a, null)', check);
  });
  it('R153 queryKind передаёт bucket параметром SQL, only video не читает фото', () => {
    const check = (s: string) => {
      assert.match(body(s, 'queryKind'), /if \(bucket != null\) \{\s*sel\.append\(" AND \$\{MediaStore\.MediaColumns\.BUCKET_ID\} = \?"\)\s*args\.add\(bucket\.toString\(\)\)/);
      const b = body(s, 'page');
      assert.match(b, /if \(onlyVideo\) emptyList\(\) else queryKind\(false, limit, bAdded, bId, bucket\)/);
      assert.match(b, /queryKind\(true, limit, bAdded, bId, bucket\)/);
    };
    rejects(media, 'if (onlyVideo) emptyList() else queryKind(false, limit, bAdded, bId, bucket)', 'queryKind(false, limit, bAdded, bId, bucket)', check);
    rejects(media, 'args.add(bucket.toString())', '', check);
  });
  it('R153 просмотр использует отдельную viewIo и shutdown закрывает её', () => {
    const check = (s: string) => {
      assert.match(code(s), /viewIo: ExecutorService = Executors\.newSingleThreadExecutor\(\)/);
      assert.match(code(s), /"open" -> \(if \(req\.optBoolean\("view", false\)\) viewIo else io\)\.execute \{ open\(proxy, id, req\) \}/);
      assert.match(body(s, 'shutdown'), /viewIo\.shutdownNow\(\)/);
    };
    rejects(media, 'viewIo.shutdownNow()', '', check);
    rejects(media, 'if (req.optBoolean("view", false)) viewIo else io', 'if (req.optBoolean("view", false)) io else io', check);
  });
  it('R154 camPerm маршрутизируется отдельно, отвечает camera и не запускает съёмку', () => {
    const check = (s: string) => {
      assert.match(code(s), /"camPerm" -> camPerm\(proxy, id\)/);
      const b = body(s, 'camPerm');
      assert.match(b, /if \(granted\(Manifest\.permission\.CAMERA\)\) \{\s*reply\(proxy, ok\(id\)\.put\("camera", true\)\)\s*return/);
      assert.match(b, /if \(captureWaiter != null \|\| camPermWaiter != null\) \{\s*reply\(proxy, err\(id, "busy"\)\)\s*return/);
      assert.match(b, /camPermWaiter = proxy to id\s*try \{\s*activity\.launchCameraPermission\(\)/);
      assert.match(b, /catch \(e: Exception\) \{[\s\S]*camPermWaiter = null\s*reply\(proxy, ok\(id\)\.put\("camera", false\)\)/);
      assert.doesNotMatch(b, /launchCapture\(/);
    };
    for (const [from, to] of [
      ['"camPerm" -> camPerm(proxy, id)', '"camPerm" -> capture(proxy, id, req)'],
      ['ok(id).put("camera", true)', 'ok(id).put("camera", false)'],
      ['captureWaiter != null || camPermWaiter != null', 'camPermWaiter != null'],
      ['camPermWaiter = proxy to id', '// waiter lost'],
      ['ok(id).put("camera", false)', 'err(id, "camera-denied")'],
    ] as const) rejects(media, from, to, check);
  });
  it('R154 onCameraPermission сначала завершает camPerm, сбрасывает waiter и не проваливается в capture', () => {
    const check = (s: string) => {
      const b = body(s, 'onCameraPermission');
      assert.match(b, /^\s*camPermWaiter\?\.let \{ \(proxy, id\) ->\s*camPermWaiter = null\s*reply\(proxy, this\.ok\(id\)\.put\("camera", ok\)\)\s*return\s*\}\s*val w = captureWaiter \?: return/);
      assert.match(b, /if \(w\.launched\) return/);
      assert.match(b, /if \(!ok\) \{\s*captureWaiter = null\s*reply\(w\.proxy, err\(w\.id, "camera-denied"\)\)\s*return\s*\}\s*launchCapture\(w\)/);
    };
    for (const [from, to] of [
      ['camPermWaiter?.let { (proxy, id) ->\n      camPermWaiter = null\n      reply(proxy, this.ok(id).put("camera", ok))\n      return\n    }\n    val w = captureWaiter ?: return',
        'val w = captureWaiter ?: return\n    camPermWaiter?.let { (proxy, id) ->\n      camPermWaiter = null\n      reply(proxy, this.ok(id).put("camera", ok))\n      return\n    }'],
      ['camPermWaiter?.let { (proxy, id) ->', 'captureWaiter?.let { (proxy, id) ->'],
      ['camPermWaiter = null\n      reply(proxy, this.ok(id)', 'reply(proxy, this.ok(id)'],
      ['.put("camera", ok))\n      return', '.put("camera", ok))'],
      ['this.ok(id).put("camera", ok)', 'this.ok(id).put("camera", true)'],
    ] as const) rejects(media, from, to, check);
  });
});
