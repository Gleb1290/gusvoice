import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = '../../desktop/src-tauri/gen/android/app/src/main/';
const kotlin = (name: string) => readFileSync(new URL(`${root}java/tech/gusik/gusvoice/${name}.kt`, import.meta.url), 'utf8');
const call = kotlin('CallNotifier');
const push = kotlin('PushNotifier');
const manifest = readFileSync(new URL(`${root}AndroidManifest.xml`, import.meta.url), 'utf8');

// Только страж Kotlin/XML: никаких переводов Kotlin в JS, eval и фиктивной Android-среды.
// Строки остаются токенами, поэтому URL и JSON не превращаются в комментарии.
function code(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith('/') ? ' ' : token);
}

function block(source: string, start: RegExp): string {
  const clean = code(source);
  const match = start.exec(clean);
  assert.ok(match, `найден блок ${start}`);
  const offset = match.index + match[0].length;
  let depth = 1;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = offset;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(offset, token.index);
  }
  assert.fail('блок закрыт');
}

function body(source: string, name: string): string {
  return block(source, new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`));
}

function rejects(source: string, target: string, replacement: string, check: (source: string) => void): void {
  check(source);
  assert.equal(source.split(target).length - 1, 1, 'мутант изменяет одно место исходника');
  const changed = source.replace(target, replacement);
  assert.notEqual(changed, source);
  assert.throws(() => check(changed), assert.AssertionError, 'удаление защиты краснит именно этот страж');
}

describe('R119 входящий звонок Android: статические границы доверия и жизненного цикла', () => {
  it('CallStyle и fullScreenIntent находятся только в разрешённой ветке, отказ оставляет обе кнопки', () => {
    const check = (source: string) => {
      const post = body(source, 'post');
      assert.match(post, /val fullScreen = canFullScreen\(context\)/);
      const allowed = block(post, /if\s*\(fullScreen\)\s*\{/);
      assert.match(allowed, /builder\.setFullScreenIntent\(screenPi, true\)/);
      assert.match(allowed, /builder\.setStyle\(NotificationCompat\.CallStyle\.forIncomingCall\(person, declinePi, answerPi\)\)/);
      for (const term of ['setFullScreenIntent(', 'CallStyle.forIncomingCall(']) {
        assert.equal(post.split(term).length - 1, 1, 'вызов не продублирован вне FSI');
      }
      const fallback = block(post, /else\s*\{/);
      assert.match(fallback, /addAction\(R\.drawable\.ic_call_end, "Отклонить", declinePi\)/);
      assert.match(fallback, /addAction\(R\.drawable\.ic_stat_call, "Ответить", answerPi\)/);
      assert.ok(!fallback.includes('CallStyle') && !fallback.includes('setFullScreenIntent'));
    };
    rejects(call, 'if (fullScreen) {', 'if (true) {', check);
    rejects(call, 'builder.setFullScreenIntent(screenPi, true)', '', check);
    rejects(call, 'val fullScreen = canFullScreen(context)', 'val fullScreen = true', check);
    for (const action of ['builder.addAction(R.drawable.ic_call_end, "Отклонить", declinePi)', 'builder.addAction(R.drawable.ic_stat_call, "Ответить", answerPi)']) rejects(call, action, '', check);
    const style = 'builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, declinePi, answerPi))';
    rejects(call, style, '', check);
    // Перенос, а не только удаление: CallStyle без FSI Android не принимает.
    check(call);
    const moved = call.replace(style, '').replace('val n = builder.build()', `${style}\n    val n = builder.build()`);
    assert.throws(() => check(moved), assert.AssertionError);
  });

  it('до SDK 34 FSI разрешён, на SDK 34 и выше запрашивается системное право', () => {
    const check = (source: string) => {
      assert.match(body(source, 'canFullScreen'), /^\s*if \(Build\.VERSION\.SDK_INT < 34\) return true\s*val nm = context\.getSystemService\(Context\.NOTIFICATION_SERVICE\) as NotificationManager\s*return nm\.canUseFullScreenIntent\(\)/);
    };
    rejects(call, 'return nm.canUseFullScreenIntent()', 'return true', check);
    rejects(call, 'Build.VERSION.SDK_INT < 34', 'Build.VERSION.SDK_INT <= 34', check);
  });

  it('канал звонков, CATEGORY_CALL, повторяющийся звук и ограничение срока остаются у уведомления', () => {
    const check = (source: string) => {
      assert.match(code(source), /const val CHANNEL_ID = "gusvoice_calls"/);
      const post = body(source, 'post');
      assert.match(post, /NotificationCompat\.Builder\(context, CHANNEL_ID\)/);
      assert.match(post, /\.setCategory\(NotificationCompat\.CATEGORY_CALL\)/);
      assert.match(post, /val left = \(call\.until - System\.currentTimeMillis\(\)\)\.coerceAtLeast\(1_000L\)/);
      assert.match(post, /\.setTimeoutAfter\(left\)/);
      assert.match(post, /n\.flags = n\.flags or Notification\.FLAG_INSISTENT/);
      assert.match(body(source, 'ensureChannel'), /NotificationChannel\(CHANNEL_ID, "Звонки", NotificationManager\.IMPORTANCE_HIGH\)/);
    };
    for (const target of ['.setCategory(NotificationCompat.CATEGORY_CALL)', '.setTimeoutAfter(left)', 'n.flags = n.flags or Notification.FLAG_INSISTENT']) rejects(call, target, '', check);
    rejects(call, 'const val CHANNEL_ID = "gusvoice_calls"', 'const val CHANNEL_ID = "gusvoice_messages"', check);
    rejects(call, 'NotificationManager.IMPORTANCE_HIGH', 'NotificationManager.IMPORTANCE_LOW', check);
  });

  it('read своей беседы снимает только уже не звонящий id, прочтение чужой беседы не гасит звонок', () => {
    const check = (source: string) => {
      const read = body(source, 'onRead');
      assert.match(read, /current\(context\)\?\.takeIf \{ it\.dmId == dmId \} \?: return/);
      assert.match(read, /val still = try \{\s*stillRinging\(app, call\)/);
      assert.match(read, /if \(!still\) dismiss\(app, call\.callId\)/);
      assert.match(body(source, 'stillRinging'), /return active\.optString\("id"\) == call\.callId && active\.optString\("phase"\) == "ringing"/);
      assert.match(body(source, 'dismiss'), /if \(call != null && call\.callId == callId\)/);
    };
    for (const [target, replacement] of [
      ['if (!still) dismiss(app, call.callId)', 'dismiss(app, call.callId)'],
      ['active.optString("id") == call.callId && ', ''],
      [' && active.optString("phase") == "ringing"', ''],
      ['?.takeIf { it.dmId == dmId }', ''],
      ['call != null && call.callId == callId', 'call != null'],
    ]) rejects(call, target!, replacement!, check);
  });

  it('строгий UUID проверен до показа и запроса decline: ../x и abc не могут стать адресом', () => {
    const check = (source: string) => {
      // Полная грамматика из Kotlin: обе границы, только hex и длины 8-4-4-4-12.
      // Не запускаем JS-копию валидатора; это структурное доказательство отказа ../x/abc и допуска UUID.
      assert.ok(code(source).includes('private val CALL_ID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")'));
      assert.match(code(source), /fun validCallId\(callId: String\): Boolean = CALL_ID\.matches\(callId\)/);
      const show = body(source, 'show');
      assert.match(show, /if \(!validCallId\(callId\) \|\| dmId\.isEmpty\(\)\) return/);
      assert.ok(show.indexOf('!validCallId(callId)') < show.indexOf('save(context, call)'));
      const decline = body(source, 'decline');
      assert.match(decline, /^\s*if \(!validCallId\(callId\)\) return false/);
      assert.ok(decline.indexOf('!validCallId(callId)') < decline.indexOf('.url('));
    };
    rejects(call, 'if (!validCallId(callId) || dmId.isEmpty()) return', 'if (dmId.isEmpty()) return', check);
    rejects(call, 'if (!validCallId(callId)) return false', '', check);
    rejects(call, 'CALL_ID.matches(callId)', 'true', check);
    rejects(call, '[0-9a-fA-F]{12}$', '[0-9a-fA-F]+', check);
  });

  it('нет ts и опоздание 125 секунд не звонят; ровно 120 секунд ещё не отсечены', () => {
    const check = (source: string) => {
      assert.match(code(source), /const val RING_MS = 90_000L/);
      assert.match(code(source), /const val LATE_SLACK_MS = 30_000L/);
      const show = body(source, 'show');
      assert.match(show, /val ts = payload\.optLong\("ts", 0L\)\s*val now = System\.currentTimeMillis\(\)/);
      const stale = block(show, /if \(ts <= 0L \|\| now - ts > RING_MS \+ LATE_SLACK_MS\) \{/);
      assert.match(stale, /\breturn\s*$/);
      assert.ok(show.indexOf('ts <= 0L') < show.indexOf('post(context, call)'));
      assert.match(show, /until = \(ts \+ RING_MS\)\.coerceIn\(now \+ 5_000L, now \+ RING_MS\)/);
    };
    rejects(call, 'ts <= 0L || ', '', check);
    rejects(call, 'now - ts > RING_MS + LATE_SLACK_MS', 'now - ts >= RING_MS + LATE_SLACK_MS', check);
    rejects(call, 'const val LATE_SLACK_MS = 30_000L', 'const val LATE_SLACK_MS = 60_000L', check);
  });

  it('call приходит только расшифрованным и после foreground-отсева, read маршрутизируется до него', () => {
    const check = (source: string) => {
      const show = body(source, 'show');
      assert.match(show, /val encrypted = PushCrypto\.looksEncrypted\(message\)/);
      assert.match(show, /val clear = if \(encrypted\) PushCrypto\.decrypt\(context, message\) else message/);
      const read = block(show, /if \(payload\?\.optString\("type"\) == "read"\) \{/);
      assert.match(read, /CallNotifier\.onRead\(context, payload\.optString\("dmId"\)\)/);
      assert.match(read, /\breturn\s*$/);
      const fg = block(show, /if \(isAppInForeground\(context\)\) \{/);
      assert.match(fg, /\breturn\s*$/);
      const incoming = block(show, /if \(payload != null && payload\.optString\("type"\) == "call"\) \{/);
      const plain = block(incoming, /if \(!encrypted\) \{/);
      assert.match(plain, /\breturn\s*$/);
      assert.ok(incoming.indexOf('if (!encrypted)') < incoming.indexOf('CallNotifier.show('));
      assert.match(incoming, /if \(CallNotifier\.validCallId\(payload\.optString\("callId"\)\) && dmId\.isNotEmpty\(\)\) CallNotifier\.show/);
      assert.ok(show.indexOf('== "read"') < show.indexOf('if (isAppInForeground(context))'));
      assert.ok(show.indexOf('if (isAppInForeground(context))') < show.indexOf('== "call"'));
    };
    rejects(push, 'if (!encrypted) {', 'if (false) {', check);
    rejects(push, 'CallNotifier.onRead(context, payload.optString("dmId"))', '', check);
    check(push);
    const clean = code(push);
    const fg = block(clean, /if \(isAppInForeground\(context\)\) \{/);
    const fgBlock = `if (isAppInForeground(context)) {${fg}}`;
    assert.equal(clean.split(fgBlock).length - 1, 1);
    const moved = clean.replace(fgBlock, '').replace('if (payload != null && payload.optString("type") == "dm"', `${fgBlock}\nif (payload != null && payload.optString("type") == "dm"`);
    assert.throws(() => check(moved), assert.AssertionError);
  });

  it('экран поверх блокировки и action receiver не экспортированы; FSI permission объявлен явно', () => {
    const check = (source: string) => {
      const xml = source.replace(/<!--[\s\S]*?-->/g, '');
      assert.match(xml, /<uses-permission\s+android:name="android\.permission\.USE_FULL_SCREEN_INTENT"\s*\/>/);
      const entry = (tag: string, name: string) => {
        const entries = [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*?)>`, 'g'))].filter(m => m[1]!.includes(`android:name=".${name}"`));
        assert.equal(entries.length, 1);
        return entries[0]![1]!;
      };
      assert.match(entry('receiver', 'CallActionReceiver'), /android:exported="false"/);
      const activity = entry('activity', 'IncomingCallActivity');
      for (const attr of ['exported="false"', 'showWhenLocked="true"', 'turnScreenOn="true"']) assert.ok(activity.includes(`android:${attr}`));
    };
    rejects(manifest, '<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />', '', check);
    for (const name of ['CallActionReceiver', 'IncomingCallActivity']) {
      const tag = name === 'CallActionReceiver' ? 'receiver' : 'activity';
      const entry = new RegExp(`<${tag}\\b[^>]*android:name="\\.${name}"[^>]*>`).exec(manifest)?.[0];
      assert.ok(entry);
      rejects(manifest, entry, entry.replace('android:exported="false"', 'android:exported="true"'), check);
    }
    for (const attr of ['showWhenLocked', 'turnScreenOn']) rejects(manifest, `android:${attr}="true"`, '', check);
  });
});
