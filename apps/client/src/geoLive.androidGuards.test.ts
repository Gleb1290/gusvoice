import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const android = new URL('../../desktop/src-tauri/gen/android/app/src/main/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, android), 'utf8').replace(/\r\n/g, '\n');
const rawService = read('java/tech/gusik/gusvoice/LiveLocationService.kt');
const rawBridge = read('java/tech/gusik/gusvoice/MainActivity.kt');
const manifest = read('AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');

function locationSettingsBridge(source = rawBridge) {
  const code = comments(source), bridge = [...code.matchAll(/\binner\s+class\s+NativeBridge\b/g)];
  assert.equal(bridge.length, 1, 'проверяется настоящий класс NativeBridge');
  const body = balanced(code, code.indexOf('{', bridge[0].index!), '{', '}');
  for (const signature of ['locationEnabled\\(\\): Boolean', 'openLocationSettings\\(\\): Boolean']) {
    assert.equal(new RegExp(`@JavascriptInterface\\s+fun ${signature}`).test(body), true,
      `R230-location-interface:${signature}: метод доступен странице`);
  }
  assert.equal(method(body, 'locationEnabled').includes('LocationManagerCompat.isLocationEnabled(lm)'), true,
    'R230-location-read: состояние спрашивается у системы');
  assert.equal(method(body, 'openLocationSettings').includes('startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))'), true,
    'R230-location-open: кнопка открывает именно настройки геолокации');
}
it('R230 Android мост читает системную геолокацию и открывает её настройки через JavascriptInterface', () => {
  // Без доступного JS метода клиент навсегда принимает выключенный GPS за отсутствие нового APK.
  locationSettingsBridge();
});
it('R230 контрфакт метод геолокации без аннотации не подменяется таким же текстом комментария', () => {
  // Публичное Kotlin имя само по себе не делает метод доступным странице WebView.
  locationSettingsBridge();
  const from = '@JavascriptInterface\n    fun locationEnabled(): Boolean';
  assert.equal(rawBridge.split(from).length - 1, 1);
  const changed = rawBridge.replace(from, '// @JavascriptInterface\n    fun locationEnabled(): Boolean');
  assert.throws(() => locationSettingsBridge(changed), e => e instanceof assert.AssertionError
    && e.message.startsWith('R230-location-interface:locationEnabled') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
it('R230 контрфакт общие настройки вместо геолокации ловятся внутри метода моста', () => {
  // Уход в общий экран настроек не выполняет обещание кнопки «Включить».
  locationSettingsBridge();
  const from = 'startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))';
  assert.equal(rawBridge.split(from).length - 1, 1);
  assert.throws(() => locationSettingsBridge(rawBridge.replace(from, 'startActivity(Intent(Settings.ACTION_SETTINGS))')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R230-location-open:')
      && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});

// Только лексическое снятие комментариев: строки и Kotlin-интерполяция остаются видимыми проверке журналирования.
function comments(source: string) {
  let out = '', quote = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) { out += c; if (c === '\\') out += source[++i] ?? ''; else if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; out += c; }
    else if (source.slice(i, i + 2) === '//') { while (i < source.length && source[i] !== '\n') i++; out += '\n'; }
    else if (source.slice(i, i + 2) === '/*') { const end = source.indexOf('*/', i + 2); assert.notEqual(end, -1); i = end + 1; out += ' '; }
    else out += c;
  }
  return out;
}
function balanced(source: string, at: number, open: string, close: string) {
  assert.equal(source[at], open); let depth = 0, quote = false;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if (c === open) depth++; else if (c === close && --depth === 0) return source.slice(at + 1, i);
  }
  assert.fail('закрытая область Kotlin найдена полностью');
}
function method(source: string, name: string) {
  const code = comments(source), matches = [...code.matchAll(new RegExp(`\\bfun\\s+${name}\\s*\\(`, 'g'))];
  assert.equal(matches.length, 1, `единственный метод ${name}`);
  const begin = code.indexOf('{', matches[0].index!); assert.ok(begin >= 0);
  return balanced(code, begin, '{', '}');
}
function foreground(source = rawService) {
  const body = method(source, 'onStartCommand');
  const first = body.indexOf('if (!foreground) goForeground()');
  const stops = [...body.matchAll(/\b(?:stopSelf|stopFromNotification|shutDown)\s*\(/g)].map(m => m.index!);
  assert.equal(first >= 0 && stops.length >= 2 && stops.every(at => at > first), true,
    'R225-native-first: старт переднего плана раньше обеих веток остановки');
  assert.match(method(source, 'goForeground'), /startForeground\(NOTIF_ID, n, ServiceInfo\.FOREGROUND_SERVICE_TYPE_LOCATION\)/);
  assert.match(method(source, 'shutDown'), /stopSelf\(\)/);
}
function logs(source = rawService) {
  const code = comments(source), calls = [...code.matchAll(/\bLog\.[vdiewtf]+\s*\(/g)].map(m => balanced(code, code.indexOf('(', m.index), '(', ')'));
  assert.ok(calls.length > 0, 'проверяются реальные вызовы Log, не комментарии');
  const sensitive = calls.filter(call => {
    const withoutStrings = call.replace(/"(?:\\.|[^"\\])*"/g, '""');
    return /\b(?:token|json|req)\b|\bs\.apiUrl\b/.test(withoutStrings)
      || /\$\{?\s*(?:s\.)?token\b|\$s\b/.test(call);
  });
  assert.equal(sensitive.length, 0, 'R225-native-log: токен, входной JSON и запрос не попадают в журнал');
  assert.equal(/\bSharedPreferences\b|\bgetSharedPreferences\s*\(/.test(code), false, 'R225-native-disk: записи токена не переживают процесс на диске');
}
it('R225 Android служба имеет location-тип и разрешение переднего плана без фонового доступа', () => {
  const services = [...manifest.matchAll(/<service\b[^>]*\bandroid:name="\.LiveLocationService"[^>]*\/>/g)];
  assert.equal(services.length, 1); assert.match(services[0][0], /android:foregroundServiceType="location"/);
  assert.match(services[0][0], /android:exported="false"/);
  assert.match(manifest, /<uses-permission\b[^>]*android:name="android\.permission\.FOREGROUND_SERVICE_LOCATION"/);
  assert.equal(/<uses-permission\b[^>]*android:name="android\.permission\.ACCESS_BACKGROUND_LOCATION"/.test(manifest), false);
});
it('R225 Android сначала выводит службу на передний план, включая команду Остановить', () => foreground());
it('R225 Android журнал не содержит токен, а память службы не сохраняется в SharedPreferences', () => logs());
it('R225 четыре метода геопозиции доступны JS и делегируют настоящей службе', () => {
  const code = comments(rawBridge);
  for (const signature of ['startLiveLocation\\(json: String\\): Boolean', 'stopLiveLocation\\(messageId: String\\)',
    'stopAllLiveLocations\\(\\)', 'liveLocationIds\\(\\): String']) assert.match(code, new RegExp(`@JavascriptInterface\\s+fun ${signature}`));
  assert.match(code, /fun startLiveLocation\(json: String\): Boolean = LiveLocationService\.start\(this@MainActivity, json\)/);
  assert.match(method(rawBridge, 'stopLiveLocation'), /LiveLocationService\.stop\(messageId\)/);
  assert.match(method(rawBridge, 'stopAllLiveLocations'), /LiveLocationService\.stopAll\(\)/);
  assert.match(code, /fun liveLocationIds\(\): String = LiveLocationService\.idsJson\(\)/);
});
it('R225 нативная остановка снимает подписку и забывает все сессии, истечение включает точный срок', () => {
  assert.match(method(rawService, 'stopAll'), /sessions\.clear\(\)/);
  assert.match(method(rawService, 'stopAll'), /instance\?\.shutDown\(\)/);
  assert.match(method(rawService, 'shutDown'), /stopListening\(\)/);
  assert.match(method(rawService, 'dropExpired'), /it\.until <= now/);
  assert.match(method(rawService, 'onStartCommand'), /return START_NOT_STICKY/);
});
for (const [name, from, to, check, prefix, actual, expected] of [
  ['старт после остановки', 'if (!foreground) goForeground()', 'if (false) goForeground()', foreground, 'R225-native-first:', false, true],
  ['прямая остановка раньше старта', 'if (!foreground) goForeground()', 'stopSelf()\n    if (!foreground) goForeground()', foreground, 'R225-native-first:', false, true],
  ['токен в журнале', 'live location: send failed: ${e.javaClass.simpleName}', 'live location: send failed: ${s.token}', logs, 'R225-native-log:', 1, 0],
  ['токен аргументом без интерполяции', 'Log.w(TAG, "live location: send failed: ${e.javaClass.simpleName}")', 'Log.w(TAG, s.token)', logs, 'R225-native-log:', 1, 0],
  ['сессии на диске', 'private val sessions = ConcurrentHashMap<String, Session>()', 'private val sessions = ConcurrentHashMap<String, Session>(); val disk: SharedPreferences? = null', logs, 'R225-native-disk:', true, false],
] as const) it(`R225 строгий Android-контрфакт: ${name}`, () => {
  check(); assert.equal(rawService.split(from).length - 1, 1);
  assert.throws(() => check(rawService.replace(from, to)), e => e instanceof assert.AssertionError
    && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
});
