/**
 * Проверить, что КАЖДЫЙ файл `*.test.ts` перечислен в `test`-скрипте своего пакета.
 *
 * 🔴 Зачем отдельная проверка. Тесты у нас запускаются явным списком файлов (`tsx --test a b c`), а
 * не по маске. Файл, забытый в этом списке, выглядит абсолютно нормально: он лежит рядом с модулем,
 * открывается, читается — и молча НЕ исполняется. Так и вышло 2026-08-22: четыре теста к разбору
 * срезов диагностики были написаны, отчитались «покрыто», а запускались ноль раз; поймал это Codex
 * глазами, а не прогон. Проверка глазами не масштабируется — поэтому она здесь.
 *
 * ⚠️ **Шаблон вместо перечня НЕ РАБОТАЕТ — проверено 01.09.2026, не гадание.** Идея заманчивая:
 * маска покрывает всё по построению, и проверка становится не нужна. Но раскрывать маску умеет
 * сам `node --test`, и только с Node 21+, а раннер CI стоит на **Node 20** — там она уходит в
 * бегунок как обычный путь, и он честно отвечает `Could not find .../src/[маска]`. Локально (Node
 * 24) при этом всё зелено. Так что перечень тут не пережиток, а единственный работающий способ;
 * вернуться к маске можно будет, когда раннер переедет на 21+.
 *
 * 🔴 Два перечня (30.10.2026, AGENTS.md §11 «тест-файл в гейте — ≤ 2 с»): `test` — гейт `checks` на каждый push,
 * `test:heavy` — тяжёлые файлы (Vite SSR-харнессы на `createServer` и всё, что дольше 2 с), их гоняет только
 * ночной `.gitea/workflows/heavy.yaml` и его ручной запуск перед тегом. Каждый файл обязан стоять РОВНО в одном
 * перечне: ни в одном — не запускается никогда; в обоих — тяжёлый файл снова тормозит гейт. Запись `test:heavy`
 * без файла на диске — тоже ошибка: ночной прогон упадёт на ней, а гейт этого не увидит.
 *
 * Запуск: `node scripts/check-tests-listed.mjs`. Ненулевой код возврата = есть незапускаемые тесты.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['packages/shared', 'packages/presence', 'packages/backend', 'packages/bot-sdk', 'packages/bot-voice', 'apps/client'];
// Tests outside `src/` still run through an owning package's explicit Node-20-compatible test list.
const EXTERNAL_TESTS = [
  { file: 'scripts/check-codemap.test.ts', pkg: 'apps/client', entry: '../../scripts/check-codemap.test.ts' },
  { file: 'scripts/check-tests-listed.test.ts', pkg: 'apps/client', entry: '../../scripts/check-tests-listed.test.ts' },
];

/** Все `*.test.ts` внутри каталога, рекурсивно, путями относительно самого пакета. */
function findTests(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...findTests(full, base));
    } else if (name.endsWith('.test.ts')) {
      // Разделитель пути берём кодом символа: обратный слеш в исходнике легко теряется
      // при переносе между инструментами, и проверка молча перестала бы находить файлы.
      out.push(full.slice(base.length + 1).split(String.fromCharCode(92)).join('/'));
    }
  }
  return out;
}

/** Имена файлов из скрипта: слова, оканчивающиеся на `.test.ts` (флаги бегунка отбрасываются). */
const listed = (script) => new Set(script.split(/\s+/).filter((w) => w.endsWith('.test.ts')));

let missing = 0;
for (const pkg of PACKAGES) {
  const scripts = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).scripts ?? {};
  const script = scripts.test ?? '';
  const gate = listed(script);
  const heavy = listed(scripts['test:heavy'] ?? '');
  const found = findTests(join(pkg, 'src'), pkg);
  for (const file of found) {
    const inGate = gate.has(file);
    if (!inGate && !heavy.has(file)) {
      console.error(`❌ ${pkg}/${file} НЕ перечислен ни в test, ни в test:heavy — он не запускается`);
      missing += 1;
    } else if (heavy.has(file) && inGate) {
      console.error(`❌ ${pkg}/${file} перечислен И в test, И в test:heavy — тяжёлый файл должен быть только в test:heavy`);
      missing += 1;
    }
  }
  const onDisk = new Set(found);
  for (const file of heavy) {
    if (!onDisk.has(file)) {
      console.error(`❌ ${pkg}: в test:heavy записан ${file}, а такого файла в src нет — ночной прогон на нём упадёт`);
      missing += 1;
    }
  }
}

for (const { file, pkg, entry } of EXTERNAL_TESTS) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    console.error(`❌ внешний тест ${file} из реестра не найден`);
    missing += 1;
    continue;
  }
  const script = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).scripts?.test ?? '';
  if (!script.split(/\s+/).includes(entry)) {
    console.error(`❌ ${pkg}/${entry} НЕ перечислен в скрипте test — внешний тест ${file} не запускается`);
    missing += 1;
  }
}

if (missing > 0) {
  console.error(`\nНезапускаемых файлов с тестами: ${missing}. Допишите их в "test" (или, если файл тяжёлый, в "test:heavy") своего пакета — ровно в один.`);
  process.exit(1);
}
console.log('Все файлы с тестами перечислены в скриптах своих пакетов (каждый — ровно в одном из test / test:heavy).');
