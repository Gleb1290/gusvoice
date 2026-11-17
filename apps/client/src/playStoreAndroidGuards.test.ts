import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const android = '../../desktop/src-tauri/gen/android/app/';
const gradle = read(`${android}build.gradle.kts`);
const manifest = read(`${android}src/play/AndroidManifest.xml`);
const fdroid = read(`${android}src/fdroid/java/tech/gusik/gusvoice/StorePush.kt`);
const workflow = read('../../../.gitea/workflows/android.yaml');
const rust = read('../../desktop/src-tauri/build.rs');

// Это статические стражи реальных Kotlin/XML/Rust/YAML, не попытка исполнить Android или CI на Windows.
function code(raw: string): string {
  return raw.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('/') ? ' '.repeat(token.length) : token);
}
function scope(raw: string, head: RegExp): { body: string; start: number; end: number } {
  const clean = code(raw), match = head.exec(clean);
  assert.ok(match, `найден исполняемый блок ${head}`);
  const start = match.index + match[0].length;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = start; let depth = 1;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return { body: clean.slice(start, token.index), start, end: token.index };
  }
  assert.fail('блок обязан закрываться');
}
function mutate(raw: string, from: string, to: string): string {
  assert.equal(raw.split(from).length, 2, `единственный якорь контрфакта ${from}`);
  return raw.replace(from, to);
}
function prove(raw: string, check: (s: string) => void, variants: Array<[string, string]>): void {
  check(raw);
  counterfact(() => { for (const [from, to] of variants) assert.throws(() => check(mutate(raw, from, to)), assert.AssertionError, `контрфакт ${from}`); });
}

function googleDependencies(raw: string): void {
  const dependencies = scope(raw, /\bdependencies\s*\{/).body;
  const play = scope(dependencies, /\bif\s*\(isPlayStore\)\s*\{/);
  for (const name of ['com.google.firebase:firebase-messaging:', 'com.google.android.gms:play-services-base:']) {
    const entries = [...dependencies.matchAll(/\bimplementation\("([^"\n]+)"\)/g)].filter(m => m[1]!.startsWith(name));
    assert.equal(entries.length, 1, `ровно одна настоящая зависимость ${name}`);
    assert.ok(entries[0]!.index! >= play.start && entries[0]!.index! < play.end, `${name} только внутри if(isPlayStore)`);
  }
}
function playSources(raw: string): void {
  const clean = code(raw);
  assert.match(clean, /^val isPlayStore\s*=\s*System\.getenv\("GV_STORE"\)\s*==\s*"play"\s*$/m);
  const sources = scope(scope(clean, /\bandroid\s*\{/).body, /\bsourceSets\s*\{/).body;
  assert.match(sources, /^\s*getByName\("main"\)\.java\.srcDir\(if \(isPlayStore\) "src\/play\/java" else "src\/fdroid\/java"\)\s*$/m);
  const overlays = [...sources.matchAll(/getByName\("(debug|release)"\)\.manifest\.srcFile\("src\/play\/AndroidManifest\.xml"\)/g)];
  assert.equal(overlays.length, 2, 'наложение есть у debug и release');
  const gate = scope(sources, /\bif\s*\(isPlayStore\)\s*\{/);
  assert.deepEqual(overlays.map(m => m[1]).sort(), ['debug', 'release']);
  for (const overlay of overlays) assert.ok(overlay.index! >= gate.start && overlay.index! < gate.end, 'Play-манифест не попадает в F-Droid');
}
const envKeys = ['GV_FIREBASE_APP_ID', 'GV_FIREBASE_API_KEY', 'GV_FIREBASE_PROJECT_ID', 'GV_FIREBASE_SENDER_ID', 'GV_FCM_RELAY'];
function requiredPlayEnv(raw: string): void {
  const clean = code(raw), keys = /\bval playEnvKeys\s*=\s*listOf\(([^)]*)\)/.exec(clean);
  assert.ok(keys);
  assert.deepEqual([...keys[1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]), envKeys);
  const env = scope(clean, /val playEnv:\s*Map<String, String>\s*=\s*if \(!isPlayStore\) emptyMap\(\) else playEnvKeys\.associateWith\s*\{\s*key\s*->/).body;
  assert.match(env, /val value\s*=\s*System\.getenv\(key\)\.orEmpty\(\)\.trim\(\)/);
  const empty = scope(env, /\bif\s*\(value\.isEmpty\(\)\)\s*\{/).body;
  assert.match(empty, /\bthrow\s+GradleException\s*\(/, 'пустое значение останавливает сборку, а не только печатает предупреждение');
}

function xmlTags(raw: string): Array<{ tag: string; attrs: Record<string, string>; text: string }> {
  return [...raw.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([\w-]+)\b([^<>]*)>/g)].map(m => ({
    tag: m[1]!, text: m[0], attrs: Object.fromEntries([...m[2]!.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(a => [a[1]!, a[2]!])),
  }));
}
const removedNodes = [
  ['service', 'tech.gusik.gusvoice.PushDistributorService'], ['receiver', 'tech.gusik.gusvoice.PushBootReceiver'],
  ...['FOREGROUND_SERVICE_DATA_SYNC', 'FOREGROUND_SERVICE_SPECIAL_USE', 'RECEIVE_BOOT_COMPLETED'].map(name => ['uses-permission', `android.permission.${name}`]),
];
function playManifest(raw: string): void {
  const tags = xmlTags(raw);
  for (const [tag, name] of removedNodes) {
    const found = tags.filter(t => t.tag === tag && t.attrs['android:name'] === name);
    assert.equal(found.length, 1, `единственный узел ${name}`);
    assert.equal(found[0]!.attrs['tools:node'], 'remove', `не сохранять встроенный распространитель/разрешение ${name}`);
  }
  const fcm = tags.filter(t => t.tag === 'service' && t.attrs['android:name'] === 'tech.gusik.gusvoice.FcmService');
  assert.equal(fcm.length, 1);
  assert.equal(fcm[0]!.attrs['android:exported'], 'false', 'сервис FCM не открыт чужим приложениям');
}
function noGoogleImports(raw: string): void {
  const imports = [...code(raw).matchAll(/^\s*import\s+([^\s;]+)/gm)].map(m => m[1]!);
  assert.equal(imports.some(name => name === 'com.google' || name.startsWith('com.google.')), false, 'F-Droid StorePush не зависит от Google');
}

type Step = { name: string; block: string; index: number };
function steps(raw: string): Step[] {
  const headers = [...raw.matchAll(/^ {6}- name: ([^\n]+)$/gm)];
  return headers.map((m, i) => ({ name: m[1]!.trim(), index: m.index!, block: raw.slice(m.index, headers[i + 1]?.index ?? raw.length) }));
}
function step(raw: string, name: string): Step {
  const found = steps(raw).filter(s => s.name === name); assert.equal(found.length, 1, `единственный шаг ${name}`); return found[0]!;
}
function script(s: Step): string {
  const run = /^ {8}run: \|\s*\n([\s\S]*)$/m.exec(s.block.replace(/^ *#.*$/gm, '')); assert.ok(run, `скрипт шага ${s.name}`);
  return run[1]!.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
}
const names = {
  build: 'Build signed APK', native: 'Нативка выровнена на 16 KB', archive: 'Keep the APK for a manual dry-run (no store touched)',
  publish: 'Publish to F-Droid repo', aab: 'Keep the Play AAB (store=play, never published)',
};
function nativeOrder(raw: string): void {
  const build = step(raw, names.build), native = step(raw, names.native);
  assert.ok(build.index < native.index, 'проверяется уже собранная нативка');
  for (const name of [names.archive, names.publish, names.aab]) assert.ok(native.index < step(raw, name).index, 'непроверенный артефакт не сохраняется и не публикуется');
}
function fdroidOnly(raw: string): void {
  for (const name of [names.archive, names.publish]) {
    const condition = /^ {8}if:\s*([^\n]+)$/m.exec(step(raw, name).block);
    assert.ok(condition, `условие публикации ${name}`);
    assert.match(condition[1]!, /(?:^|\s|\()github\.event\.inputs\.store\s*!=\s*'play'(?:\s|$|\))/);
  }
}
function nativeGuard(raw: string): void {
  const run = script(step(raw, names.native));
  assert.match(run, /^\s*aligns=\$\("\$READELF" -lW "\$so" \| awk '\$1 == "LOAD" \{ print \$NF \}'\)$/m);
  assert.match(run, /^\s*if \[ \$\(\(min\)\) -lt \$\(\(0x4000\)\) \]; then\s*\n\s*echo [^\n]*\n\s*bad=1/m);
  assert.match(run, /^\[ "\$bad" = 0 \] \|\| exit 1\s*$/m);
  assert.match(run, /^\s*if "\$ZIPALIGN" -c -P 16 -v 4 "\$ART" > "\$LOG" 2>&1; then\s*$/m);
  assert.match(run, /^done < <\(find "\$TMP" -type f -name '\*\.so' \| sort\)\s*$/m);
}
function playBuild(raw: string): void {
  const run = script(step(raw, names.build));
  const branch = /^if \[ "\$STORE" = play \]; then\n([\s\S]*?)^else\n([\s\S]*?)^fi\s*$/m.exec(run);
  assert.ok(branch, 'настоящие разные рукава Play и F-Droid');
  assert.match(branch[1]!, /^\s*export GV_STORE=play\s*$/m);
  assert.match(branch[1]!, /^\s*pnpm tauri android build --aab(?:\s|$)/m);
  assert.match(branch[2]!, /^\s*pnpm tauri android build --apk(?:\s|$)/m);
  assert.doesNotMatch(branch[2]!, /\bexport GV_STORE=play\b/);
}
function androidLinker(raw: string): void {
  const clean = code(raw), main = scope(clean, /\bfn main\(\)\s*\{/).body;
  const androidBlock = scope(main, /if std::env::var\("CARGO_CFG_TARGET_OS"\)\.as_deref\(\) == Ok\("android"\)\s*\{/);
  const flags = [...main.matchAll(/println!\("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384"\);/g)];
  assert.equal(flags.length, 1, 'линкер получает единственный настоящий флаг размера страниц');
  assert.ok(flags[0]!.index! >= androidBlock.start && flags[0]!.index! < androidBlock.end, 'флаг относится к Android, не Windows/комментарию');
}

describe('R330 Play и F-Droid остаются разными Android-сборками', () => {
  it('Firebase и Play Services попадают только в isPlayStore; снятие условия ловится', () => {
    prove(gradle, googleDependencies, [['if (isPlayStore) {\n        implementation("com.google.firebase:', 'if (true) {\n        implementation("com.google.firebase:']]);
  });
  it('GV_STORE выбирает ровно один набор Kotlin и включает оба наложения манифеста только для Play', () => {
    prove(gradle, playSources, [
      ['System.getenv("GV_STORE") == "play"', 'true'],
      ['srcDir(if (isPlayStore)', 'srcDir(if (true)'],
      ['"src/play/java" else "src/fdroid/java"', '"src/fdroid/java" else "src/play/java"'],
      ['if (isPlayStore) {\n            // Наложение', 'if (true) {\n            // Наложение'],
    ]);
  });
  it('каждый обязательный Firebase/FCM env проверяется и пустой приводит к GradleException', () => {
    prove(gradle, requiredPlayEnv, [
      ...envKeys.map(key => [`"${key}",`, ''] as [string, string]),
      ['if (value.isEmpty()) {', 'if (false) {'],
      ['throw GradleException(\n            "GV_STORE=play: env $key is empty.', 'println(\n            "GV_STORE=play: env $key is empty.'],
    ]);
  });
  it('Play-манифест удаляет встроенный push и три разрешения, а сервис FCM не экспортирует', () => {
    playManifest(manifest);
    counterfact(() => {
      for (const [, name] of removedNodes) {
        const tag = xmlTags(manifest).find(t => t.attrs['android:name'] === name)!;
        assert.throws(() => playManifest(mutate(manifest, tag.text, tag.text.replace('tools:node="remove"', 'tools:node="merge"'))), assert.AssertionError);
      }
      assert.throws(() => playManifest(mutate(manifest, 'android:exported="false"', 'android:exported="true"')), assert.AssertionError);
    });
  });
  it('F-Droid StorePush не импортирует Google, даже если комментарий рассказывает про FCM', () => {
    prove(fdroid, noGoogleImports, [['import android.content.Context', 'import android.content.Context\nimport com.google.firebase.messaging.FirebaseMessaging']]);
  });
});

describe('R330 CI не выпускает невыровненную нативку и не публикует Play в F-Droid', () => {
  it('страж 16 KB стоит после сборки, до обоих F-Droid-шагов и архива Play AAB', () => {
    nativeOrder(workflow);
    counterfact(() => {
      const block = step(workflow, names.native).block;
      const without = mutate(workflow, block, '');
      const moved = mutate(without, '      - name: Build signed APK', block + '      - name: Build signed APK');
      assert.throws(() => nativeOrder(moved), assert.AssertionError);
    });
  });
  it('оба F-Droid-шага отдельно запрещают store=play; потеря любого условия краснеет', () => {
    fdroidOnly(workflow);
    counterfact(() => {
      for (const name of [names.archive, names.publish]) {
        const original = step(workflow, name).block;
        const changed = original.replace(/github\.event\.inputs\.store != 'play'\s*&&\s*|\s*&&\s*github\.event\.inputs\.store != 'play'/, '');
        assert.notEqual(changed, original);
        assert.throws(() => fdroidOnly(mutate(workflow, original, changed)), assert.AssertionError);
      }
    });
  });
  it('каждый LOAD требует 0x4000, zipalign проверяет -P 16, плохой результат завершает шаг кодом один', () => {
    prove(workflow, nativeGuard, [
      ['-lt $((0x4000))', '-lt $((0x1000))'], ['[ "$bad" = 0 ] || exit 1', '[ "$bad" = 0 ] || exit 0'],
      ['"$ZIPALIGN" -c -P 16 -v 4', '"$ZIPALIGN" -c -P 4 -v 4'],
    ]);
  });
  it('только Play-рукав экспортирует GV_STORE=play и действительно строит AAB, не APK', () => {
    prove(workflow, playBuild, [['export GV_STORE=play', 'export GV_STORE=fdroid'],
      ['pnpm tauri android build --aab', 'pnpm tauri android build --apk']]);
  });
  it('Rust передаёт флаг страницы 16384 именно Android; смена OS и исчезновение флага обнаруживаются', () => {
    prove(rust, androidLinker, [
      ['== Ok("android")', '== Ok("windows")'],
      ['println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");', '// println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");'],
    ]);
  });
});
