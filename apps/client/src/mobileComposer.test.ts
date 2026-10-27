import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const pane = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const classes = [...pane.matchAll(/className="att-btn\s+([\w-]+)"/g)].map((m) => m[1]);

describe('кнопки мобильного композера', () => {
  it('тест знает каждую разновидность att-btn из компонента', () => {
    // Ловит добавление новой кнопки, которую забыли распределить между строкой и шторкой телефона.
    assert.deepEqual([...new Set(classes)].sort(), ['attach', 'botcmd', 'emoji', 'plus', 'poll', 'sched', 'textfile', 'voice']);
  });

  it('скрепка скрыта по умолчанию и включается третьей только в мобильной раскладке', () => {
    // Ловит лишний плюс на десктопе и прыжок мобильной кнопки в неверное место строки.
    assert.match(css, /\.att-btn\.plus\s*\{\s*display:\s*none;/s);
    assert.match(css, /\.app\.m-content \.composer \.att-btn\.plus\s*\{[^}]*display:\s*inline-flex;[^}]*order:\s*3;/s);
  });

  it('файл, голосовое и опрос спрятаны в шторку, а эмодзи идёт первым', () => {
    // Ловит возврат переполненной строки на 411 px и исчезновение двери в кастомные эмодзи.
    assert.match(css, /\.att-btn\.attach,\s*\.app\.m-content \.composer \.att-btn\.voice,\s*\.app\.m-content \.composer \.att-btn\.poll\s*\{\s*display:\s*none;/s);
    assert.match(css, /\.app\.m-content \.composer \.att-btn\.emoji\s*\{\s*order:\s*1;/s);
  });

  it('R302 меню бота остаётся в строке телефона левее эмодзи и не попадает в скрытые кнопки', () => {
    // Дверь в команды не должна исчезать вместе со скрепкой: на телефоне она доступна и при набранном тексте.
    assert.match(css, /\.att-btn\s*\{[^}]*display:\s*inline-flex;/s);
    assert.match(css, /\.app\.m-content \.composer \.att-btn\.botcmd\s*\{[^}]*order:\s*0;/s);
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(',').map(selector => selector.trim());
      if (selectors.some(selector => /\.att-btn\.botcmd(?:\b|\s)/.test(selector))) {
        assert.doesNotMatch(rule[2], /display:\s*none\b|visibility:\s*hidden\b/, 'Меню не скрывается отдельным правилом');
      }
      if (selectors.some(selector => selector === '.app.m-content .composer .att-btn')) {
        assert.doesNotMatch(rule[2], /display:\s*none\b|visibility:\s*hidden\b/, 'общая мобильная кнопка не скрыта');
      }
    }
  });
});
