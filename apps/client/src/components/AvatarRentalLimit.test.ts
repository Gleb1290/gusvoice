import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');
const walletSource = read('CoinWalletModal');
const adminSource = read('AdminPanel');
const now = Date.UTC(2026, 9, 19);
const day = 86_400_000;
type Element = { type: unknown; props: Record<string, unknown> };
type Props = Record<string, unknown>;
type Component = (props: Props) => unknown;

function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...elements(node.props.children)];
}
function text(tree: unknown): string {
  if (tree == null || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'object' && 'props' in tree) return text((tree as Element).props.children);
  return String(tree);
}

function fixture(file: 'CoinWalletModal' | 'AdminPanel', raw: string, initial: unknown[] = []) {
  let cursor = 0;
  const states = [...initial];
  const calls: unknown[] = [];
  const errors: string[] = [];
  const store = { user: { animatedAvatarUnlocked: true, animatedAvatarUntil: new Date(now + 45 * day).toISOString() }, setAuth() {} };
  const api = { adminSetEconomy: async (patch: unknown) => { calls.push(JSON.parse(JSON.stringify(patch))); } };
  const unused = (id: string) => () => { throw new Error(`непредметная граница ${id}`); };
  const jsx = (type: unknown, props: Props): Element => ({ type, props });
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared,
    react: {
      useState(value: unknown) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof value === 'function' ? (value as () => unknown)() : value;
        return [states[index], (next: unknown) => { states[index] = next; }];
      },
      useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../store': { useStore: (select: (s: typeof store) => unknown) => select(store) },
    '../adminApi': { adminApi: () => api },
    '../toast': { toast() {}, toastError: (error: unknown) => { errors.push(error instanceof Error ? error.message : String(error)); } },
    '../adminNav': { ADMIN_SECTIONS: [], adminSectionLabel: unused('adminSectionLabel'), adminSectionOf: unused('adminSectionOf') },
  };
  const dormant = new Set(['../api', '../benchMock', '../economy', '../economyClient', '../ledgerCsv', '../memberName',
    '../streakView', './Goose', './Icon', '../config', '../dialogChrome', './DmReports', './FederationPanel',
    './InstanceSettingsForms', './AdminPeerGroups', './SmtpForm', './SettingsShell', './Toggle', '../guestAtMark',
    '../confirm', '../androidBack']);
  const ast = ts.createSourceFile(`${file}.tsx`, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const id = node.moduleSpecifier.text;
    if (Object.hasOwn(deps, id)) continue;
    assert.equal(dormant.has(id), true, `описанный импорт ${file}: ${id}`);
    const bindings = node.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    deps[id] = Object.fromEntries(bindings.elements.filter(e => !e.isTypeOnly).map(e => [e.propertyName?.text ?? e.name.text, unused(`${id}:${e.name.text}`)]));
  }
  const module = { exports: {} };
  const componentName = file === 'CoinWalletModal' ? 'ShopSection' : 'EconomyTab';
  // Экспортируем только тестовую точку входа, но транспилируем/исполняем модуль целиком, не вырезанное тело.
  const code = ts.transpileModule(`${raw}\nexport const __r279 = ${componentName};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  class FixedDate extends Date { constructor(value?: string | number) { super(value ?? now); } static now() { return now; } }
  runInNewContext(code, { module, exports: module.exports, Date: FixedDate, Error,
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `описанный require ${id}`); return deps[id]; } });
  const component = (module.exports as { __r279: Component }).__r279;
  return { states, calls, errors, store, render(props: Props = {}) { cursor = 0; return component(props); } };
}

function wallet(raw: string, max: number | undefined, left: number) {
  const f = fixture('CoinWalletModal', raw);
  f.store.user.animatedAvatarUntil = new Date(now + left * day).toISOString();
  const tree = f.render({ serverId: 's', view: {
    wallet: { balance: 10000 }, currencyName: 'монет', canManage: false,
    shop: [{ item: 'animated-avatar', label: 'Аватар', hint: 'Аренда', priceMinutes: 100, priceCoins: 100, enabled: true,
      target: 'none', ...(max === undefined ? {} : { rentalMaxDays: max }) }],
  } });
  const button = elements(tree).find(e => e.type === 'button' && e.props.className === 'shop-buy');
  assert.ok(button, 'кнопка продления присутствует');
  return button;
}

test('R279 кошелёк старого сервера без rentalMaxDays использует 60 и показывает дату продления', () => {
  // Класс ошибки: отсутствие нового поля совместимости позволяет купить сверх обычного потолка или скрывает продление.
  const button = wallet(walletSource, undefined, 45);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, 'Больше чем на 60 дней вперёд не оплатить');
  const expected = new Date(now + 15 * day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  assert.equal(text(button), `Продлить с ${expected}`);
  assert.equal(wallet(walletSource, undefined, 30).props.disabled, false);
});

test('R279 кошелёк учитывает 90: остаток 55 разрешён, 65 запрещён с настоящим числом', () => {
  // Класс ошибки: клиент получает настройку, но передаёт в правило/подсказку старые 60.
  const yes = wallet(walletSource, 90, 55);
  assert.equal(yes.props.disabled, false);
  assert.equal(text(yes), 'Продлить');
  const no = wallet(walletSource, 90, 65);
  assert.equal(no.props.disabled, true);
  assert.equal(no.props.title, 'Больше чем на 90 дней вперёд не оплатить');
  assert.equal(wallet(walletSource, 90, 60).props.disabled, false);
});

function rentalForm(raw = adminSource, data: unknown = { rentalMaxDaysMin: 30, rentalMaxDaysLimit: 365 }) {
  const f = fixture('AdminPanel', raw, ['1500', '60', data, false]);
  const isRentalInput = (e: Element) => e.type === 'input' && e.props['aria-label'] === 'Потолок аренды аватара, дней вперёд';
  const input = () => elements(f.render()).find(isRentalInput);
  const save = () => {
    const row = elements(f.render()).find(e => e.type === 'div' && e.props.className === 'sbp-add' && elements(e).some(isRentalInput));
    return elements(row).find(e => e.type === 'button' && text(e) === 'Сохранить');
  };
  return { ...f, input, async set(value: string) {
    const field = input(); assert.ok(field);
    (field.props.onChange as (e: unknown) => void)({ target: { value } });
    const button = save(); assert.ok(button);
    (button.props.onClick as () => void)();
    await Promise.resolve(); await Promise.resolve();
  } };
}

test('R279 админка отклоняет 29, 366 и дробь до API, но обе границы сохраняет отдельно от цены', async () => {
  // Класс ошибки: форма позволяет бессмысленный срок или при изменении потолка одновременно сбрасывает цену.
  const f = rentalForm();
  assert.equal(f.input()!.props.min, 30); assert.equal(f.input()!.props.max, 365);
  for (const value of ['29', '366', '90.5', 'не число']) {
    await f.set(value);
    assert.equal(f.calls.length, 0);
    assert.match(f.errors.at(-1)!, /целое число дней от 30 до 365/);
  }
  await f.set('30'); await f.set('365');
  assert.deepEqual(f.calls, [{ avatarRentalMaxDays: 30 }, { avatarRentalMaxDays: 365 }]);
});

test('R279 админка соблюдает границы сервера, а без новых полей использует 30…365', async () => {
  // Класс ошибки: HTML-границы отображены, но обработчик сохраняет число вне разрешения сервера.
  const f = rentalForm(adminSource, { rentalMaxDaysMin: 40, rentalMaxDaysLimit: 120 });
  assert.equal(f.input()!.props.min, 40); assert.equal(f.input()!.props.max, 120);
  await f.set('39'); await f.set('121'); assert.equal(f.calls.length, 0);
  await f.set('40'); await f.set('120');
  assert.deepEqual(f.calls, [{ avatarRentalMaxDays: 40 }, { avatarRentalMaxDays: 120 }]);
  const old = rentalForm(adminSource, null);
  assert.equal(old.input()!.props.min, 30); assert.equal(old.input()!.props.max, 365);
  await old.set('60'); assert.deepEqual(old.calls, [{ avatarRentalMaxDays: 60 }]);
});
