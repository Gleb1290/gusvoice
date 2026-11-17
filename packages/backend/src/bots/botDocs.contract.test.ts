import assert from 'node:assert/strict';
import { mutantTest } from '../../../shared/test/counterfacts.js';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { it } from 'node:test';

// Только семь известных файлов; никакого обхода дерева, импорта приложения или исполнения исходника.
const DOCS = ['docs/bots.ru.md', 'docs/bots.md', 'docs/bots-llm.md'] as const;
const MANIFESTS = ['packages/bot-sdk/package.json', 'packages/bot-voice/package.json', 'packages/bot-sdk-py/pyproject.toml'] as const;
const RULES = 'packages/backend/src/bots/botRules.ts';
const MAX_FILE = 256 * 1024, MAX_TOTAL = 512 * 1024, MAX_LINES = 4096, MAX_LINE = 8192;
type Doc = typeof DOCS[number];
type Package = { name: string; version: string };
let ioCalls = 0, ioBytes = 0;
function setup(ok: unknown, label: string): asserts ok {
  if (!ok) throw new Error(`R371/setup/${label}`);
}
function budget(ok: unknown, label: string): asserts ok {
  if (!ok) throw new Error(`R371/budget/${label}`);
}
function readKnown(file: string): string {
  budget(++ioCalls <= 7, 'семь файлов');
  const fd = openSync(new URL(`../../../../${file}`, import.meta.url), 'r');
  try {
    const size = fstatSync(fd).size;
    budget(size <= MAX_FILE && size + ioBytes <= MAX_TOTAL, 'размер файлов');
    // Буфер ограничен ДО чтения; даже выросший файл не вызовет неограниченное readFile.
    const bytes = Buffer.alloc(size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    setup(count === size, `${file}: файл изменился или чтение неполное`);
    ioBytes += count;
    return bytes.subarray(0, count).toString('utf8').replace(/\r\n/g, '\n');
  } finally { closeSync(fd); }
}
const docTexts = Object.fromEntries(DOCS.map(file => [file, readKnown(file)])) as Record<Doc, string>;
const manifestTexts = MANIFESTS.map(readKnown);
const rulesText = readKnown(RULES);

function lines(text: string): string[] {
  budget(Buffer.byteLength(text) <= MAX_FILE, 'текст');
  const result = text.split('\n');
  budget(result.length <= MAX_LINES, 'строки');
  for (const line of result) budget(line.length <= MAX_LINE, 'длина строки');
  return result;
}
function only<T>(items: T[], label: string): T {
  setup(items.length === 1, `${label}: нужен единственный якорь, найдено ${items.length}`);
  return items[0]!;
}
function replaceOnce(text: string, before: string, after: string): string {
  const at = text.indexOf(before);
  setup(at >= 0 && text.indexOf(before, at + before.length) < 0, 'единственная замена');
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function wsLimit(text: string): number {
  const declaration = only(lines(text).filter(line => /^export const BOT_WS_PER_BOT\s*=/.test(line)), 'BOT_WS_PER_BOT');
  const value = /^export const BOT_WS_PER_BOT\s*=\s*(\d+);$/.exec(declaration)?.[1];
  setup(value !== undefined, 'BOT_WS_PER_BOT: числовая константа');
  const result = Number(value);
  setup(Number.isSafeInteger(result) && result > 0, 'BOT_WS_PER_BOT: положительное целое');
  return result;
}
function packages(texts: string[]): Package[] {
  setup(texts.length === 3, 'три манифеста');
  return texts.map((text, index) => {
    lines(text);
    let name: unknown, version: unknown;
    if (index < 2) {
      const value = JSON.parse(text) as { name?: unknown; version?: unknown };
      name = value.name; version = value.version;
    } else {
      const section = text.split(/^\[project\]\s*$/m)[1]?.split(/^\[/m)[0];
      setup(section !== undefined, 'pyproject: [project]');
      name = only(lines(section).filter(line => /^name\s*=/.test(line)), 'project.name').match(/^name\s*=\s*"([^"]+)"\s*$/)?.[1];
      version = only(lines(section).filter(line => /^version\s*=/.test(line)), 'project.version').match(/^version\s*=\s*"([^"]+)"\s*$/)?.[1];
    }
    setup(typeof name === 'string' && name.length > 0 && typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), `${MANIFESTS[index]}: имя и версия`);
    return { name, version };
  });
}
function sdkSection(text: string): string {
  const all = lines(text);
  const start = only(all.flatMap((line, index) => /^## (?:Официальный SDK|Official SDK|8c\. Official SDKs)\b/.test(line) ? [index] : []), 'раздел SDK');
  let end = start + 1;
  for (; end < all.length && !/^## /.test(all[end]!); end++) { /* Не более MAX_LINES. */ }
  return all.slice(start, end).join('\n');
}
function wsRow(text: string): string {
  return only(lines(text).filter(line => /^\|\s*(?:Потребителей событий на бота|Event consumers per bot|consumers per bot|WS per bot)\s*\|/i.test(line)), 'строка лимита потребителей');
}
function checkWs(file: Doc, text: string, expected: number): void {
  const cell = wsRow(text).split('|')[2]?.trim() ?? '';
  const number = /^(\d+)(?:\b|$)/.exec(cell)?.[1];
  assert.equal(number === undefined ? null : Number(number), expected, `R371/WS/${file}`);
}
function checkSdk(file: Doc, text: string, expected: Package[]): void {
  const section = sdkSection(text);
  const listed: string[] = [];
  for (const line of lines(section)) {
    const table = /^\|\s*`([^`]+)`\s*\((npm|PyPI)\)\s*\|/.exec(line);
    const bullet = /^- (npm|PyPI) `([^`]+)`/.exec(line);
    if (table) listed.push(`${table[2]}:${table[1]}`);
    if (bullet) listed.push(`${bullet[1]}:${bullet[2]}`);
  }
  assert.deepEqual(listed.sort(), expected.map((pkg, index) => `${index < 2 ? 'npm' : 'PyPI'}:${pkg.name}`).sort(), `R371/SDK_NAMES/${file}`);
  const shared = only(lines(section).filter(line => /^(?:Первая версия всех трёх|The first version of all three|Published, MIT, version)/.test(line)), 'общая версия SDK');
  const documented = /(?:Первая версия всех трёх — `|The first version of all three is `|Published, MIT, version )(\d+\.\d+\.\d+)/.exec(shared)?.[1];
  setup(documented !== undefined, 'число в общей версии SDK');
  for (const pkg of expected) assert.equal(documented, pkg.version, `R371/SDK_VERSION/${file}/${pkg.name}`);
  // В краткой справке дополнительно есть конкретный pin Python: он не должен отстать от общей версии.
  if (file === 'docs/bots-llm.md') {
    const pin = only(lines(section).filter(line => /^- Install:/.test(line)), 'установка SDK').match(/==(\d+\.\d+\.\d+)/)?.[1];
    setup(pin !== undefined, 'pin Python');
    assert.equal(pin, expected[2]!.version, `R371/SDK_PIN/${file}`);
  }
}
function checkReady(file: Doc, text: string): void {
  lines(text);
  const mentions = text.matchAll(/@gusvoice\/bot(?=[`'"\s),.;:]|$)/g);
  let seen = 0;
  for (const match of mentions) {
    budget(++seen <= MAX_LINES, 'упоминания SDK');
    const start = match.index!;
    const nearby = text.slice(Math.max(0, start - 320), start + match[0].length + 320);
    assert.equal(/готовится|being\s+prepared/iu.test(nearby), false, `R371/SDK_READY/${file}`);
  }
  setup(seen > 0, `${file}: упоминание @gusvoice/bot`);
}
function killed(check: () => void, message: string, actual: unknown, expected: unknown): void {
  // Ошибка чтения, парсинга, якоря или бюджета НЕ считается убийством контрфакта.
  assert.throws(check, error => error instanceof assert.AssertionError && error.message.startsWith(message)
    && error.actual === actual && error.expected === expected);
}
function nextVersion(version: string): string {
  const parts = version.split('.').map(Number);
  setup(parts.length === 3 && parts.every(Number.isSafeInteger), 'версия контрфакта');
  return `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
}
function bumpManifest(text: string, index: number, before: string, after: string): string {
  return replaceOnce(text, index < 2 ? `"version": "${before}"` : `version = "${before}"`, index < 2 ? `"version": "${after}"` : `version = "${after}"`);
}
const currentPackages = packages(manifestTexts);
const currentWs = wsLimit(rulesText);

for (const file of DOCS) {
  // Класс ошибки: одна из публикуемых справок обещает больше потребителей, чем разрешает сервер.
  it(`R371 ${file}: предел потребителей совпадает с кодом`, () => checkWs(file, docTexts[file], currentWs));
  // Класс ошибки: старая строка WS per bot | 3 вместо исправленного общего потребителя.
  mutantTest(`R371 ${file}: старый лимит трёх WS обнаруживается адресно`, () => {
    setup(currentWs !== 3, 'контрфакт 3 должен отличаться от текущего лимита');
    const changed = replaceOnce(docTexts[file], wsRow(docTexts[file]), '| WS per bot | 3 |');
    killed(() => checkWs(file, changed, currentWs), `R371/WS/${file}`, 3, currentWs);
  });
  // Класс ошибки: опечатка в имени или отставшая версия пакета вводит автора бота в заблуждение.
  it(`R371 ${file}: официальные имена и версии совпадают с манифестами`, () => checkSdk(file, docTexts[file], currentPackages));
  // Класс ошибки: опубликованный пакет всё ещё называют неготовым.
  it(`R371 ${file}: опубликованный SDK не обещан на будущее`, () => checkReady(file, docTexts[file]));
  for (const phrase of ['готовится', 'being prepared']) {
    // Класс ошибки: прежний статус SDK возвращён по-русски или по-английски.
    mutantTest(`R371 ${file}: статус «${phrase}» рядом с SDK обнаруживается адресно`, () => {
      const section = sdkSection(docTexts[file]);
      const changed = replaceOnce(docTexts[file], section, section.replace('@gusvoice/bot`', `@gusvoice/bot\` (${phrase})`));
      setup(changed !== docTexts[file], 'вставлен старый статус');
      killed(() => checkReady(file, changed), `R371/SDK_READY/${file}`, true, false);
    });
  }
}
for (let index = 0; index < MANIFESTS.length; index++) {
  // Класс ошибки: релиз любого из трёх SDK без обновления каждой публичной справки.
  mutantTest(`R371 ${MANIFESTS[index]}: повышение версии без правки документации обнаруживается`, () => {
    const old = currentPackages[index]!, version = nextVersion(old.version);
    const changed = manifestTexts.map((text, at) => at === index ? bumpManifest(text, index, old.version, version) : text);
    const expected = packages(changed);
    for (const file of DOCS) killed(() => checkSdk(file, docTexts[file], expected), `R371/SDK_VERSION/${file}/${old.name}`, old.version, version);
  });
}
// Класс ошибки: жёстко зашитая единица даёт ложную тревогу при согласованной смене контракта.
it('R371 согласованное изменение лимита в коде и трёх справках принимается', () => {
  const next = currentWs + 1;
  const changedRules = replaceOnce(rulesText, `export const BOT_WS_PER_BOT = ${currentWs};`, `export const BOT_WS_PER_BOT = ${next};`);
  for (const file of DOCS) {
    const row = wsRow(docTexts[file]);
    const cells = row.split('|'); cells[2] = ` ${next}: согласованный новый предел `;
    checkWs(file, replaceOnce(docTexts[file], row, cells.join('|')), wsLimit(changedRules));
  }
});
// Класс ошибки: фиксация 0.1.0 в тесте вместо сверки с настоящими манифестами.
it('R371 согласованное повышение версии всех трёх SDK и документации принимается', () => {
  const old = currentPackages[0]!.version, next = nextVersion(old);
  setup(currentPackages.every(pkg => pkg.version === old), 'общая версия всех трёх SDK');
  const expected = packages(manifestTexts.map((text, index) => bumpManifest(text, index, old, next)));
  for (const file of DOCS) {
    const section = sdkSection(docTexts[file]);
    const occurrences = section.split(old).length - 1;
    budget(occurrences > 0 && occurrences <= 4, 'замены версии в SDK');
    checkSdk(file, replaceOnce(docTexts[file], section, section.replaceAll(old, next)), expected);
  }
});
// Класс ошибки: проверка любого слова «готовится» во всей справке вместо статуса конкретного SDK.
it('R371 корректный текст о готовящемся обеде вдали от упоминаний SDK принимается', () => {
  for (const file of DOCS) checkReady(file, `Обед готовится; lunch is being prepared.\n${' '.repeat(640)}\n${docTexts[file]}`);
});
// Класс ошибки: поиск имени где угодно пропускает опечатку в перечне официальных пакетов.
mutantTest('R371 опечатка в официальном имени не маскируется правильными импортами ниже', () => {
  for (const file of DOCS) {
    const section = sdkSection(docTexts[file]);
    const changed = replaceOnce(docTexts[file], section, section.replace('@gusvoice/bot`', '@gusvoice/typo`'));
    setup(changed !== docTexts[file], 'искажён перечень SDK');
    assert.throws(() => checkSdk(file, changed, currentPackages), error => error instanceof assert.AssertionError && error.message.startsWith(`R371/SDK_NAMES/${file}`));
  }
});
