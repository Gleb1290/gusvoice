import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function rule(raw: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...raw.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.equal(matches.length, 1, `один адресный CSS-блок ${selector}`); return matches[0][1];
}
function lite(raw = source) {
  const block = rule(raw, 'html.gv-lite .tgp .tgp-bgimg,\nhtml.gv-lite .tgp .tgp-bar-bg');
  assert.match(block, /(?:^|[;\n])\s*display:\s*none\s*;/);
}
// Класс ошибки: оптимизированный режим оставляет тяжёлые слои размытия профиля.
it('R176 html gv-lite скрывает и фон аватара и фон компактной полосы display none', () => lite());
// Класс ошибки: правило gv-lite удалено или отключён только один слой.
it('R176 мутанты удаления правила и потери слоя компактной шапки обнаруживаются адресным CSS', () => {
  const anchor = 'html.gv-lite .tgp .tgp-bgimg,\nhtml.gv-lite .tgp .tgp-bar-bg {\n  display: none;\n}';
  assert.equal(source.split(anchor).length - 1, 1); lite();
  assert.throws(() => lite(source.replace(anchor, '')), assert.AssertionError);
  assert.throws(() => lite(source.replace(anchor, 'html.gv-lite .tgp .tgp-bgimg {\n  display: none;\n}')), assert.AssertionError);
});
// Класс ошибки: фоновый аватар перестал быть размытым или стал перехватывать действия.
it('R176 фон аватара размыт затемнён и не ловит нажатия, полоса проявляется при collapsed', () => {
  const image = rule(source, 'img.tgp-bgimg');
  assert.match(image, /filter:\s*blur\(32px\)\s+saturate\(0\.65\)\s+brightness\(0\.5\)/);
  assert.match(image, /pointer-events:\s*none/);
  assert.match(rule(source, '.tgp-bar-bg'), /opacity:\s*0\s*;/);
  assert.match(rule(source, '.tgp.collapsed .tgp-bar-bg'), /opacity:\s*1\s*;/);
});
