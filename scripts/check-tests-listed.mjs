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
 * Запуск: `node scripts/check-tests-listed.mjs`. Ненулевой код возврата = есть незапускаемые тесты.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['packages/shared', 'packages/presence', 'packages/backend', 'apps/client'];

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

let missing = 0;
for (const pkg of PACKAGES) {
  const script = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).scripts?.test ?? '';
  for (const file of findTests(join(pkg, 'src'), pkg)) {
    if (!script.includes(file)) {
      console.error(`❌ ${pkg}/${file} НЕ перечислен в скрипте test — он не запускается`);
      missing += 1;
    }
  }
}

if (missing > 0) {
  console.error(`\nНезапускаемых файлов с тестами: ${missing}. Допишите их в "test" своего пакета.`);
  process.exit(1);
}
console.log('Все файлы с тестами перечислены в скриптах своих пакетов.');
