import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
const callLayerPath = 'apps/client/src/components/CallLayer.tsx';
const callAudioPath = 'apps/desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/CallAudio.kt';
const mainPath = 'apps/desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/MainActivity.kt';
const notifierPath = 'apps/desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/CallNotifier.kt';
const manifestPath = 'apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml';

function replaceRequired(source: string, before: string, after: string, label: string): string {
  assert.equal(source.split(before).length - 1, 1, `${label}: единственный якорь`);
  return source.replace(before, after);
}

function assertKilled(actual: unknown, expected: unknown, message: string) {
  assert.throws(() => assert.equal(actual, expected, message),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message)
      && error.operator === 'strictEqual' && Object.is(error.actual, actual) && Object.is(error.expected, expected),
    'the targeted source mutant must fail through a host AssertionError');
}

function isInsideApi31Gate(source: string, callIndex: number): boolean {
  const gate = 'if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {';
  const start = source.lastIndexOf(gate, callIndex);
  if (start < 0) return false;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i <= callIndex; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    if (depth === 0) return false;
  }
  return depth > 0;
}

function hostRoutingGuards(source: string) {
  return {
    activeCallFederation: source.includes('.url("${auth.apiUrl}/api/calls/active?fed=1")'),
    validatesHostIdentity: source.includes('creds.optString("instanceId") != hostId'),
    requiresHttps: source.includes('!apiBase.startsWith("https://")'),
    dispatchesDeclineToMatchingHost: /if \(host != null\) return declineAtHost\(context, auth, callId, active\.optString\("conversationId"\), host\.optString\("instanceId"\)\)/.test(source),
  };
}

describe('Android CallAudio: проводка вызова и защита Kotlin исходников', () => {
  it('кнопка динамика показана до микрофона только при audio && press; счётчик действий учитывает press', () => {
    const source = read(callLayerPath);
    const speaker = source.indexOf('label="Динамик"');
    const microphone = source.indexOf("label={muted ? 'Включить микрофон' : 'Микрофон'}");
    assert.ok(speaker >= 0 && microphone > speaker, 'speaker action must precede microphone action');
    assert.ok(source.lastIndexOf('{audio && press && (', speaker) >= 0,
      'no speaker control is rendered when native audio is unavailable or has no action');
    assert.ok(/const acts = 2 \+ \(press \? 1 : 0\)/.test(source), 'layout count includes the optional speaker action');

    const useAudioCall = source.indexOf('useCallAudio(!ended && (view === \'outgoing\' || view === \'active\'))');
    const firstNullReturn = source.indexOf('return null;', source.indexOf('if (!peer ||'));
    assert.ok(useAudioCall >= 0 && useAudioCall < firstNullReturn,
      'audio hook must run before the early null return, without enabling it for incoming calls');
    assert.equal(source.includes("useCallAudio(!ended && (view === 'incoming'"), false,
      'incoming call UI must not start the output-route integration');
  });

  it('Kotlin мост экспортирует четыре аннотированных метода, лениво создаёт сервис и останавливает только созданный', () => {
    const source = read(mainPath);
    for (const signature of [
      '@JavascriptInterface\n    fun callAudioStart(video: Boolean)',
      '@JavascriptInterface\n    fun callAudioStop()',
      '@JavascriptInterface\n    fun callAudioSelect(kind: String)',
      '@JavascriptInterface\n    fun callAudioState(): String',
    ]) assert.ok(source.includes(signature), `native bridge signature missing: ${signature}`);
    assert.ok(source.includes('private val callAudioLazy: Lazy<CallAudio> = lazy {'), 'activity context is accessed lazily');
    assert.ok(source.includes('if (callAudioLazy.isInitialized()) callAudio.stop()'), 'destroy must stop only an initialized lazy instance');
    // eager run создаёт CallAudio в конструкторе Activity; lazyOf сохраняет тип Lazy, но не отложенное создание.
    const prefix = 'private val callAudioLazy: Lazy<CallAudio> = lazy {';
    const start = source.indexOf(prefix), open = source.indexOf('{', start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) { if (source[end] === '{') depth++; else if (source[end] === '}') depth--; end++; }
    assert.equal(depth, 0, 'блок lazy целиком найден');
    const mutant = source.slice(0, start) + source.slice(start, end).replace(prefix, 'private val callAudioLazy: Lazy<CallAudio> = lazyOf(run {') + ')' + source.slice(end);
    assertKilled(mutant.includes(prefix), true, 'Activity создаёт CallAudio только лениво');
  });

  it('Android разрешение Bluetooth и все вызовы API31 остаются под защитой версии', () => {
    const manifest = read(manifestPath);
    assert.ok(manifest.includes('<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />'));
    const source = read(callAudioPath);
    assert.ok(source.includes('private const val FORCE_COMM_MODE = false'), 'Samsung ECNS regression stays disabled');
    assert.ok(/@RequiresApi\(Build\.VERSION_CODES\.S\)\s+private inner class Api31/.test(source),
      'API 31 listener interfaces stay isolated from API 30 and earlier');
    const api31Start = source.indexOf('private inner class Api31 {'), api31Open = source.indexOf('{', api31Start);
    assert.ok(api31Start >= 0); let depth = 1, api31End = api31Open + 1;
    while (depth && api31End < source.length) { if (source[api31End] === '{') depth++; else if (source[api31End] === '}') depth--; api31End++; }
    for (const match of source.matchAll(/AudioManager\.(?:OnCommunicationDeviceChangedListener|OnModeChangedListener)\s*\{/g))
      assert.ok(match.index > api31Open && match.index < api31End, 'интерфейс слушателя создаётся только в Api31');
    for (const call of ['addOnCommunicationDeviceChangedListener', 'addOnModeChangedListener', 'setCommunicationDevice', 'clearCommunicationDevice']) {
      const matches = [...source.matchAll(new RegExp(`am\\.${call}\\(`, 'g'))];
      assert.ok(matches.length > 0, `${call} остаётся реализован`);
      for (const match of matches) assert.ok(isInsideApi31Gate(source, match.index), `${call} каждый вызов защищён API31`);
    }
  });
});

describe('Android CallNotifier: отклонение входящего звонка соседа', () => {
  it('сначала ищет активный федеративный звонок, проверяет хозяина и отправляет decline его инстансу', () => {
    const source = read(notifierPath);
    const guards = hostRoutingGuards(source);
    assert.deepEqual(guards, {
      activeCallFederation: true,
      validatesHostIdentity: true,
      requiresHttps: true,
      dispatchesDeclineToMatchingHost: true,
    });
    assert.ok(source.includes('val active = try {\n      activeCall(context, auth)'),
      'decline first resolves the active call before choosing its home instance');
    assert.ok(source.includes('active?.takeIf { it.optString("id") == callId }?.optJSONObject("host")'),
      'only the matching active call may select remote-host routing');
    assert.ok(source.includes('.url("${auth.apiUrl}/api/conv/$dmId/fallback?for=call")'),
      'host session must come from the conversation fallback endpoint');
    assert.ok(source.includes('token.isEmpty()'), 'empty host session token is rejected');
    assert.ok(source.includes('.url("$apiBase/api/calls/$callId/decline")'), 'decline request targets the remote instance');
    assert.ok(source.includes('.header("Authorization", "Bearer $token")'), 'remote decline uses the guest session token');
    assert.ok(source.includes('.url("${auth.apiUrl}/api/calls/$callId/decline")'), 'non-federated calls retain the local decline endpoint');
    assert.ok(source.includes('.header("Authorization", "Bearer ${auth.token}")'), 'local decline retains the receiver token');
    assert.ok(source.includes('val active = activeCall(context, auth) ?: return false'),
      'stillRinging must share the federation-aware active-call lookup');
    assert.ok(source.includes('return active.optString("id") == call.callId && active.optString("phase") == "ringing"'),
      'stillRinging shares the same federation-aware active-call helper and checks both id and phase');

    const mutants = [
      [replaceRequired(source, '.url("${auth.apiUrl}/api/calls/active?fed=1")', '.url("${auth.apiUrl}/api/calls/active")', 'federated active call'), 'activeCallFederation', 'active endpoint includes fed=1'],
      [replaceRequired(source, 'creds.optString("instanceId") != hostId', 'false', 'host identity check'), 'validatesHostIdentity', 'only the matching host identity is trusted'],
      [replaceRequired(source, '|| !apiBase.startsWith("https://")', '', 'HTTPS guard'), 'requiresHttps', 'host session API base must use HTTPS'],
      [replaceRequired(source, 'if (host != null) return declineAtHost(context, auth, callId, active.optString("conversationId"), host.optString("instanceId"))', 'if (host != null) return false', 'remote decline branch'), 'dispatchesDeclineToMatchingHost', 'matching host receives decline'],
    ] as const;
    for (const [mutantSource, guardName, reason] of mutants) {
      const mutatedValue = hostRoutingGuards(mutantSource)[guardName];
      assertKilled(mutatedValue, true, reason);
    }
  });
});
