import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createElement as el } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { SettingsWindow, SettingsRail, RailItem, RailAnchor, SettingsSearch, SettingsHead } from './SettingsShell';

for (const [variant, classes] of [['user', 'modal admin rail-modal settings-modal'], ['server', 'modal admin rail-modal server-rail'], ['channel', 'modal channel-settings rail-modal channel-rail'], ['admin', 'modal admin rail-modal admin-rail']] as const) {
  it(`окно ${variant} сохраняет классы, доступность и порядок рельса, содержимого и внешнего слоя`, () => {
    const html = render(el(SettingsWindow, { variant, picked: true, onClose: () => {}, titleId: 'title', rail: el('aside', null, 'rail'), children: 'body', outside: el('footer', null, 'outside') }));
    assert.ok(html.includes(`class="${classes} picked"`)); assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="title" tabindex="-1"/);
    assert.match(html, /class="modal-overlay"/); assert.ok(html.indexOf('<aside>') < html.indexOf('class="set-main"'));
    assert.match(html, /<div class="set-main">body<\/div><\/div><footer>outside<\/footer>/);
  });
}
it('рельс с поиском меняет шапку, имена и глифы сохраняют подсказку и tablist', () => {
  const base = { title: 'Имя', label: 'Разделы', onClose: () => {}, children: 'items' };
  const named = render(el(SettingsRail, { ...base, named: true }));
  assert.match(named, /set-rail-title/); assert.match(named, /class="rail-title-text" title="Имя"/);
  const searched = render(el(SettingsRail, { ...base, glyph: el('b', null, 'glyph'), search: 'search' }));
  assert.match(searched, /set-rail-head/); assert.match(searched, /class="ch-settings-title" title="Имя"/);
  assert.match(searched, /role="tablist" aria-label="Разделы" aria-orientation="vertical"/);
});
it('раздел всегда сообщает selected, optional атрибуты не появляются сами, обе точки подписаны', () => {
  const plain = render(el(RailItem, { icon: 'settings', label: 'x' }));
  assert.match(plain, /role="tab" aria-selected="false"/); assert.doesNotMatch(plain, /aria-controls|tabindex/);
  const active = render(el(RailItem, { icon: 'settings', label: 'x', active: true, changed: true, unseen: true, 'aria-controls': 'panel', tabIndex: 0 }));
  assert.match(active, /aria-selected="true" aria-controls="panel" tabindex="0"/);
  assert.match(active, /set-rail-item active/); assert.match(active, /aria-label="есть изменения"/); assert.match(active, /set-dot new/);
  assert.match(active, /aria-label="есть непросмотренное"/);
});
it('якорь и поиск сохраняют свои умолчания и принимают пользовательские подписи', () => {
  assert.match(render(el(RailAnchor, { on: true, unseen: true, children: 'x' })), /set-rail-anchor on/);
  assert.match(render(el(RailAnchor, { unseen: true, children: 'x' })), /aria-label="не просмотрено"/);
  const plain = render(el(SettingsSearch)); assert.match(plain, /placeholder="Поиск" aria-label="Поиск по настройкам"/); assert.match(plain, /<kbd>Ctrl K<\/kbd>/);
  const custom = render(el(SettingsSearch, { placeholder: 'Найти', 'aria-label': 'Поиск x', shortcut: 'F3' }));
  assert.match(custom, /placeholder="Найти" aria-label="Поиск x"/); assert.match(custom, /<kbd>F3<\/kbd>/);
});
it('шапка различает отсутствующий и пустой sub, действия перед крестиком', () => {
  const base = { title: 'T', titleId: 'title', onBack: () => {}, onClose: () => {} };
  assert.doesNotMatch(render(el(SettingsHead, base)), /set-head-sub/);
  assert.match(render(el(SettingsHead, { ...base, sub: '' })), /set-head-sub/);
  const html = render(el(SettingsHead, { ...base, changed: '2 из 14', actions: el('b', null, 'ACT') }));
  assert.match(html, /set-head-mark/); assert.match(html, /· 2 из 14/); assert.match(html, /aria-label="К разделам"/);
  assert.ok(html.indexOf('ACT') < html.indexOf('class="icon-close"'));
});
it('четыре окна используют общую оболочку и не возвращают копии рельса', () => {
  for (const [file, variant] of [['UserSettingsModal', 'user'], ['ServerSettingsModal', 'server'], ['ChannelSettingsModal', 'channel'], ['AdminPanel', 'admin']]) {
    const src = readFileSync(new URL(`./${file}.tsx`, import.meta.url), 'utf8');
    assert.match(src, /<SettingsWindow/); assert.ok(src.includes(`variant="${variant}"`));
    assert.doesNotMatch(src, /className="(?:set-rail|set-head|rail-modal)(?:[ "-])/);
  }
});
it('окна разделов не вводят своих углов, фокус программного окна не рисует рамку', () => {
  // Ловит возвращение четырёх расходящихся рамок вместо общей оболочки.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.modal\.[\w-]+/.test(m[1]!)) continue;
    for (const d of m[2]!.matchAll(/(?:^|;)\s*border-radius:\s*([^;]+)/g)) {
      assert.equal(d[1]!.trim(), '0', m[1]);
      assert.match(m[1]!, /rail-modal/);
      // В этом единственном обнулении сверяем также внешний media, не только декларацию.
      const before = css.slice(0, m.index); assert.ok(before.lastIndexOf('@media (max-width: 760px)') > before.lastIndexOf('@media (min-width:'));
    }
  }
  assert.match(css, /\.modal\[tabindex=['"]-1['"]\]:focus\s*\{\s*outline:\s*none/);
});
// Общие CSS-пины радиусов/теней удалены по §11: они запрещали форму иллюстраций,
// не проверяя поведение оболочки настроек. Поведенческие проверки оболочки выше сохранены.
