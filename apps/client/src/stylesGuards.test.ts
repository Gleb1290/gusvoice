import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('стражи дорогих и слишком сильных правил CSS', () => {
  it('каждая бесконечная анимация учтена списком остановки перед полноэкранной игрой', () => {
    // Ловит новое вечное украшение, которое продолжит будить DWM и отнимать видеокарту у игры.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const infinite = withoutComments.match(/animation\s*:[^;{}]*\binfinite\b/g) ?? [];
    assert.equal(infinite.length, 14);
    const guarded = [
      '.auth-badge', '.inst-update-steps li.now::before', '.stream-card-live .live-dot',
      '.dot-connected.reconnecting', '.goose-bob', '.voice-rec-dot',
      '.update-progress-bar.indeterminate', '.update-shimmer', '.sk', '.typing-dots span',
      '.ss-card.skeleton', '.crowned-name', '.confirm-spin', '.goose-bonus',
    ];
    for (const selector of guarded) {
      assert.equal(css.includes(`html.gv-game-fg ${selector}`), true, `game: ${selector}`);
      assert.equal(css.includes(`html.gv-lite ${selector}`), true, `lite: ${selector}`);
    }
  });

  it('общий hover кнопки не получает вес обычного псевдокласса', () => {
    // Ловит медовую заливку базы, которая перебивает собственный фон любой кнопки-компонента.
    assert.doesNotMatch(css, /(^|[,\n]\s*)button:hover\b/m);
    assert.match(css, /button:where\(:hover\)/);
  });
});
