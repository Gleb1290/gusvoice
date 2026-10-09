import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../../apps/desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/ConversationNotifier.kt', import.meta.url), 'utf8');

// Это страж настоящего Kotlin, не модель алгоритма: Android/JVM-раннера в гейте нет.
function checkRepeatContract(raw: string): void {
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const message = code.slice(code.indexOf('fun onMessage('), code.indexOf('fun onRead('));
  assert.match(message, /val mid = payload\.optString\("mid"\)/);
  assert.match(message, /if\s*\(mid\.isNotEmpty\(\)\)/);
  const start = message.indexOf('for (i in 0 until items.length()) if (items.optJSONObject(i)?.optString("mid") == mid) {');
  assert.ok(start >= 0, 'повтор сопоставляется с mid существующей строки истории');
  const open = message.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; end < message.length && depth; end++) {
    if (message[end] === '{') depth++;
    if (message[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  const duplicate = message.slice(open + 1, end - 1);
  // Весь блок: cancel, post и unconditional return. Ни append/save, ни пропуск обычного дубля.
  assert.match(duplicate, /^\s*if\s*\(payload\.optInt\("repeat",\s*0\)\s*>\s*0\s*&&\s*!payload\.optBoolean\("silent"\)\)\s*\{\s*NotificationManagerCompat\.from\(context\)\.cancel\(notifId\(dmId\)\)\s*post\(context,\s*dmId,\s*load\(context,\s*dmId\),\s*silent\s*=\s*false,\s*alertOnce\s*=\s*false\)\s*\}\s*return\s*$/, 'дубль звонит только при repeat>0 без silent, без добавления истории, остальные дубли отбрасываются');
  assert.ok(message.indexOf('items.put(item)', end) >= end, 'новая строка добавляется только после раннего возврата дубля');
  const post = code.slice(code.indexOf('private fun post('));
  assert.match(post, /\.setOnlyAlertOnce\(alertOnce\)/, 'повтор может повторно подать звук');
  assert.match(post, /NotificationManagerCompat\.from\(context\)\.notify\(id,\s*builder\.build\(\)\)/, 'post действительно публикует уведомление');
}

test('R112 Android звонкий повтор обновляет уведомление без новой истории, обычный дубль отбрасывается', () => {
  checkRepeatContract(source);
});

test('R112 страж Android ловит звонок обычного или тихого дубля, отсутствие cancel и повторное добавление истории', () => {
  const mutants = [
    source.replace('payload.optInt("repeat", 0) > 0', 'true'),
    source.replace(' > 0 && !payload.optBoolean("silent")', ' > 0'),
    source.replace('NotificationManagerCompat.from(context).cancel(notifId(dmId))', ''),
    source.replace('silent = false, alertOnce = false)', 'silent = true, alertOnce = false)'),
    source.replace('silent = false, alertOnce = false)', 'silent = false, alertOnce = true)'),
    source.replace('        return\n      }', '        items.put(item)\n        return\n      }'),
    source.replace('        return\n      }', '      }'),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, source, 'контрфакт действительно меняет Kotlin');
    assert.throws(() => checkRepeatContract(mutant), /дубль звонит только/);
  }
});
