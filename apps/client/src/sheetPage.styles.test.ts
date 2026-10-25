import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Rule = { header: string; selectors: string[]; context: string[]; values: Map<string, string>; start: number; end: number };

function parse(raw: string): Rule[] {
  // Комментарии маскируются с сохранением позиций: ни пример в комментарии, ни фигурная скобка в строке не правило.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const stack: { header: string; start: number; nested: boolean }[] = [], found: Rule[] = [];
  let head = 0, quote = '';
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') {
      if (stack.length) stack[stack.length - 1].nested = true;
      stack.push({ header: css.slice(head, i).trim(), start: i + 1, nested: false });
      head = i + 1;
    } else if (char === '}') {
      const block = stack.pop(); assert.ok(block, 'сбалансированные скобки CSS');
      if (!block.nested) {
        const values = new Map<string, string>();
        for (const declaration of css.slice(block.start, i).split(';')) {
          const colon = declaration.indexOf(':');
          if (colon >= 0) values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
        }
        found.push({ header: block.header, selectors: block.header.split(',').map((s) => s.trim()),
          context: stack.map((parent) => parent.header), values, start: block.start, end: i });
      }
      head = i + 1;
    }
  }
  assert.equal(stack.length, 0, 'все CSS-блоки закрыты');
  return found;
}

function rule(rules: Rule[], selector: string, scope: 'global' | 'phone' | 'reduce' = 'global'): Rule {
  const matched = rules.filter((r) => r.selectors.includes(selector) && (scope === 'global'
    ? r.context.length === 0
    : r.context.some((c) => scope === 'phone' ? /^@media\s*\(max-width:\s*760px\)$/.test(c)
      : /^@media\s*\(prefers-reduced-motion:\s*reduce\)$/.test(c))));
  assert.equal(matched.length, 1, `одно реальное правило ${selector} (${scope})`);
  return matched[0];
}
const compact = (value: string | undefined) => value?.replace(/\s+/g, '');

function stacking(raw = source) {
  const rules = parse(raw);
  const page = Number(rule(rules, '.sheet-scrim.page').values.get('z-index'));
  const callbar = Number(rule(rules, '.call-bar.call-bar-top', 'phone').values.get('z-index'));
  assert.ok(Number.isInteger(page) && Number.isInteger(callbar), 'R258 слои заданы целыми числами');
  assert.ok(page < callbar, 'R258 экран сообщения ниже телефонной полосы звонка');
  assert.equal(page, 1000);
  assert.equal(callbar, 1001);
  assert.ok(Number(rule(rules, '.sheet-scrim').values.get('z-index')) > callbar,
    'R258 понижен только page, обычные листы не потеряли прежний верхний слой');
}

it('R258 полноэкранное сообщение остаётся под полосой звонка, обычный лист выше неё', () => {
  // Полоса с управлением звонком должна оставаться доступной над новым экраном.
  stacking();
});

it('R258 page занимает весь scrim без прежнего ограничения высоты и скруглённой шторки', () => {
  // Правильные DOM-классы без снятого max-height всё ещё рисовали бы короткий лист.
  const rules = parse(source), scrim = rule(rules, '.sheet-scrim'), pageScrim = rule(rules, '.sheet-scrim.page');
  assert.equal(scrim.values.get('position'), 'fixed'); assert.equal(scrim.values.get('inset'), '0');
  assert.equal(scrim.values.get('display'), 'flex');
  assert.equal(pageScrim.values.get('align-items'), 'stretch');
  assert.equal(pageScrim.values.get('background'), 'var(--bg)');
  assert.equal(pageScrim.values.get('animation'), 'none');
  const page = rule(rules, '.sheet.page');
  assert.equal(page.values.get('display'), 'flex'); assert.equal(page.values.get('flex-direction'), 'column');
  assert.equal(page.values.get('height'), '100%'); assert.equal(page.values.get('max-height'), 'none');
  assert.equal(page.values.get('overflow'), 'hidden'); assert.equal(page.values.get('border-radius'), '0');
  assert.equal(compact(page.values.get('padding')), '0var(--sa-r)0var(--sa-l)');
  assert.equal(page.values.get('box-shadow'), 'none');
  assert.match(rule(rules, '.sheet').values.get('max-height') ?? '', /vh$/);
});

it('R258 шапка учитывает вырез и звонок, а прокрутка тела — нижнюю безопасную вставку', () => {
  // env() не измеряем в happy-dom: проверяем исходные формулы, иначе вырез или CallBar закроют стрелку.
  const rules = parse(source), bar = rule(rules, '.sheet-page-bar');
  const height = bar.values.get('--sheet-page-bar') ?? '';
  assert.match(height, /env\(safe-area-inset-top\)/);
  assert.match(height, /var\(--gv-sat,\s*0px\)/);
  assert.match(height, /var\(--m-callbar-h,\s*0px\)/);
  assert.equal(compact(height), 'calc(56px+max(env(safe-area-inset-top),var(--gv-sat,0px))+var(--m-callbar-h,0px))',
    'вырез берётся по max, а высота звонка добавляется, не вычитается');
  assert.equal(bar.values.get('height'), 'var(--sheet-page-bar)');
  assert.equal(bar.values.get('flex'), '0 0 auto');
  assert.equal(compact(bar.values.get('padding')), 'calc(var(--sheet-page-bar)-56px)4px0');
  const back = rule(rules, '.sheet-page-bar .sheet-back');
  assert.equal(back.values.get('position'), 'static');
  assert.equal(back.values.get('width'), '48px'); assert.equal(back.values.get('height'), '48px');
  const title = rule(rules, '.sheet-page-title');
  assert.equal(title.values.get('min-width'), '0'); assert.equal(title.values.get('text-overflow'), 'ellipsis');
  assert.equal(title.values.get('overflow'), 'hidden'); assert.equal(title.values.get('white-space'), 'nowrap');
  const body = rule(rules, '.sheet.page .sheet-body');
  assert.equal(body.values.get('flex'), '1 1 auto');
  assert.equal(body.values.get('min-height'), '0'); assert.equal(body.values.get('overflow-y'), 'auto');
  assert.equal(body.values.get('overscroll-behavior'), 'contain');
  assert.match(body.values.get('padding') ?? '', /env\(safe-area-inset-bottom\)/);
  assert.match(body.values.get('padding') ?? '', /var\(--gv-sab,\s*0px\)/);
  assert.equal(compact(body.values.get('padding')), '07pxcalc(var(--sp-3)+max(env(safe-area-inset-bottom),var(--gv-sab,0px)))');
});

it('R258 page въезжает сбоку, но при reduced-motion не анимируется', () => {
  // Обычный sheetUp дал бы ощущение шторки вместо самостоятельного экрана.
  const rules = parse(source);
  assert.match(rule(rules, '.sheet.page').values.get('animation') ?? '', /^sheetPageIn\s/);
  assert.equal(rule(rules, '.sheet.page', 'reduce').values.get('animation'), 'none');
  const from = rules.filter((r) => r.header === 'from' && r.context.includes('@keyframes sheetPageIn'));
  assert.equal(from.length, 1);
  assert.match(from[0].values.get('transform') ?? '', /^translateX\(/);
});

it('R258 контрфакт z-index 1002 ловится даже рядом с комментарием про правильный 1000', () => {
  // Ищем декларацию живого селектора: пример или устаревший комментарий не должен защитить регрессию.
  stacking();
  const target = rule(parse(source), '.sheet-scrim.page');
  const body = source.slice(target.start, target.end);
  assert.equal([...body.matchAll(/\bz-index\s*:\s*\d+/g)].length, 1);
  const changed = source.slice(0, target.start) + body.replace(/(\bz-index\s*:\s*)\d+/, (_match, prefix: string) => `${prefix}1002`)
    + source.slice(target.end);
  for (const raw of [changed, `${changed}\n/* .sheet-scrim.page { z-index: 1000; } */`]) {
    assert.throws(() => stacking(raw), (e: unknown) => e instanceof assert.AssertionError
      && e.message.startsWith('R258 экран сообщения ниже телефонной полосы звонка'));
  }
});
