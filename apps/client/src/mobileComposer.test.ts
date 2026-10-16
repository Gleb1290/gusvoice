import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const pane = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const classes = [...pane.matchAll(/className="att-btn\s+([\w-]+)"/g)].map((m) => m[1]);

describe('кнопки мобильного композера', () => {
  it('тест знает каждую разновидность att-btn из компонента', () => {
    // Ловит добавление новой кнопки, которую забыли распределить между строкой и шторкой телефона.
    assert.deepEqual([...new Set(classes)].sort(), ['attach', 'emoji', 'plus', 'poll', 'sched', 'textfile', 'voice']);
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
});
