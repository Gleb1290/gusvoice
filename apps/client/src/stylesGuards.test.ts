import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

it('R132 подвал выбора пересылки прилипает к низу прокрутки, а не уходит под длинный список', () => {
  // В листе телефона кнопка отправки должна оставаться доступной при большом количестве бесед.
  const selector = '.fwd-foot';
  const verify = (source: string) => {
    const values = guardDeclarations(guardCssBlocks(source), selector);
    assert.equal(values.get('position'), 'sticky');
    assert.equal(values.get('bottom'), '0');
  };
  verify(css);
  const block = guardCssBlocks(css).slice().reverse().find(b => !b.header.startsWith('@')
    && splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has('position'));
  assert.ok(block);
  assert.throws(() => verify(mutateGuardDeclaration(block, 'position', 'static')), assert.AssertionError);
  assert.throws(() => verify(mutateGuardDeclaration(block, 'bottom', 'auto')), assert.AssertionError);
});

for (const selector of ['.modal.fwd-modal > .fwd-pick', '.fwd-pick > .fwd-list']) {
  it(`R132 ${selector}: колонка выбора сжимается в высоту, отдавая место подвалу`, () => {
    // Нулевой min-height нужен на обеих ступенях flex-цепочки: один несжимаемый предок уносит подвал за окно.
    const verify = (source: string) => {
      const values = guardDeclarations(guardCssBlocks(source), selector);
      assert.equal(values.get('flex'), '1 1 auto');
      assert.equal(values.get('min-height'), '0');
    };
    verify(css);
    const block = guardCssBlocks(css).slice().reverse().find(b => !b.header.startsWith('@')
      && splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has('min-height'));
    assert.ok(block);
    const marked = mutateGuardDeclaration(block, 'min-height', 'initial');
    assert.equal(marked.split('min-height: initial').length - 1, 1, 'помечена ровно нужная декларация');
    const removed = marked.replace('min-height: initial', '');
    assert.notEqual(removed, marked);
    assert.throws(() => verify(removed), assert.AssertionError);
    assert.throws(() => verify(mutateGuardDeclaration(block, 'flex', 'none')), assert.AssertionError);
  });
}

it('R125 имя папки ЛС переносится до двух строк, а не остаётся одной обрезанной', () => {
  const selector = '.dm-folders .dm-folder-name';
  const verify = (source: string) => {
    const values = guardDeclarations(guardCssBlocks(source), selector);
    assert.equal(values.get('-webkit-line-clamp'), '2'); assert.notEqual(values.get('white-space'), 'nowrap');
    assert.notEqual(values.get('font-size'), '10px', 'R130 подпись не сжимается до прежних 10px');
  };
  verify(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector)); assert.ok(block);
  assert.throws(() => verify(mutateGuardDeclaration(block, '-webkit-line-clamp', '1')), assert.AssertionError);
  for (const bad of ['font-size: 10px;', 'white-space: nowrap;']) {
    const mutant = css.replace(`${selector} {`, `${selector} { ${bad}`);
    assert.notEqual(mutant, css); assert.throws(() => verify(mutant), assert.AssertionError);
  }
});

it('R130 десктопная подпись папки допускает три строки, браузерная остаётся двухстрочной', () => {
  // Селектор desk не должен возвращать прежние две строки или менять браузерную раскладку.
  const selector = '.dm-folders.desk .dm-folder-name';
  const verify = (source: string) => {
    const blocks = guardCssBlocks(source);
    assert.equal(guardDeclarations(blocks, selector).get('-webkit-line-clamp'), '3');
    assert.equal(guardDeclarations(blocks, '.dm-folders .dm-folder-name').get('-webkit-line-clamp'), '2');
  };
  verify(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector)); assert.ok(block);
  assert.throws(() => verify(mutateGuardDeclaration(block, '-webkit-line-clamp', '2')), assert.AssertionError);
});

describe('R124 остаток наплывов — фактическая область CSS и специфичность', () => {
  const phoneMedia = '@media (max-width: 760px)';
  const landscapeMedia = '@media (orientation: landscape) and (max-height: 600px)';
  function scope(source: string, media?: string) {
    const blocks = guardCssBlocks(source);
    return media ? guardScope(blocks, media) : blocks;
  }
  function declaration(source: string, selector: string, property: string, media?: string) {
    const value = guardDeclarations(scope(source, media), selector).get(property);
    assert.ok(value, `${selector}: ${property} в нужной области`);
    return value;
  }
  function mutate(selector: string, property: string, transform: (old: string) => string | undefined, media?: string) {
    const block = scope(css, media).slice().reverse().find(b => !b.header.startsWith('@') && splitCss(b.header, ',').includes(selector)
      && guardDeclarations([b], selector).has(property));
    assert.ok(block);
    const old = declaration(css, selector, property, media); const next = transform(old);
    assert.notEqual(next, old);
    if (next !== undefined) return mutateGuardDeclaration(block, property, next);
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const matches = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m =>
      m[1].trim().replace(/\s+/g, ' ') === block.header && m[2] === block.body);
    assert.equal(matches.length, 1, 'удаляется свойство одного настоящего правила');
    const body = block.body.replace(new RegExp(`(^|;)\\s*${property}\\s*:[^;]+;?`), '$1');
    assert.notEqual(body, block.body);
    const at = matches[0].index + matches[0][0].indexOf('{') + 1;
    return clean.slice(0, at) + body + clean.slice(at + block.body.length);
  }
  function sides(padding: string) {
    const parts = splitCss(padding, ' ').filter(Boolean);
    assert.equal(parts.length, 4, 'четыре стороны, без разрыва вложенных calc/max');
    assert.match(parts[1], /var\(--sa-r\)/); assert.match(parts[3], /var\(--sa-l\)/);
  }
  it('R124 все четыре поповера выражений вычитают верх и низ из высоты видимого окна', () => {
    // Вариант expr не должен вернуть прежнюю высоту и спрятать последнюю строку под навигацией.
    const selectors = ['.emoji-pop', '.sticker-pop', '.emoji-pop.expr', '.sticker-pop.expr'];
    const verify = (source: string) => {
      for (const selector of selectors) {
        const height = declaration(source, selector, 'height');
        assert.match(height, /var\(--vh-px, 100dvh\)/);
        assert.match(height, /- var\(--sa-t\) - var\(--sa-b\)/);
      }
    };
    verify(css);
    for (const selector of selectors)
      assert.throws(() => verify(mutate(selector, 'height', old => old.replace(' - var(--sa-b)', ''))), assert.AssertionError);
  });
  it('R124 обычный лист и лист контекстного меню защищают правый и левый padding', () => {
    // Фон листа полноширинный, но его пункты должны оставаться доступными рядом с боковой панелью Android.
    for (const selector of ['.sheet', '.ctx-menu.sheet']) {
      const verify = (source: string) => sides(declaration(source, selector, 'padding'));
      verify(css);
      for (const side of ['l', 'r']) assert.throws(() => verify(mutate(selector, 'padding', old => old.replace(`var(--sa-${side})`, '0px'))), assert.AssertionError);
    }
  });
  it('R124 последнее телефонное правило рельса не обнуляет бока, окно по центру вычитает максимальную вставку дважды', () => {
    // Раннее корректное правило не спасает поздний padding:0 с тем же селектором.
    const verify = (source: string) => {
      const media = guardCssBlocks(source).filter(b => b.header === phoneMedia && guardDeclarations(b.children, '.modal.rail-modal').has('padding')).at(-1);
      assert.ok(media, 'последний media с рельсом найден');
      const padding = guardDeclarations(media.children, '.modal.rail-modal').get('padding'); assert.ok(padding);
      sides(padding);
      assert.match(declaration(source, '.modal.rail-modal', 'width'), /- 2 \* max\(var\(--sa-l\), var\(--sa-r\)\)/);
    };
    verify(css);
    assert.throws(() => verify(mutate('.modal.rail-modal', 'padding', () => '0', phoneMedia)), assert.AssertionError);
    assert.throws(() => verify(mutate('.modal.rail-modal', 'width', old => old.replace(' - 2 * max(var(--sa-l), var(--sa-r))', ''))), assert.AssertionError);
  });
  it('R124 окно создания прокручивается внутри безопасной высоты и не сжимает детей вместо прокрутки', () => {
    // flex-shrink без защиты ужмёт кнопки/поля так, что overflow:auto не даст ожидаемой прокрутки.
    const verify = (source: string) => {
      assert.match(declaration(source, '.modal.create-channel', 'max-height'), /- 2 \* max\(var\(--sa-t\), var\(--sa-b\)\)/);
      assert.equal(declaration(source, '.modal.create-channel', 'overflow-y'), 'auto');
      assert.equal(declaration(source, '.modal.create-channel > *', 'flex-shrink'), '0');
    };
    verify(css);
    assert.throws(() => verify(mutate('.modal.create-channel > *', 'flex-shrink', () => undefined)), assert.AssertionError);
  });
  it('R124 низкий ландшафт раскрывает галерею на 92dvh, текст доступа защищён более сильным селектором', () => {
    // Одиночный .gal-notice проигрывает поздней базе: важны два класса, а не случайное flex где-либо.
    const verify = (source: string) => {
      assert.equal(declaration(source, '.sheet:has(> .sheet-body > .gal)', 'height', landscapeMedia), '92dvh');
      assert.equal(declaration(source, '.gal .gal-notice > span', 'flex', landscapeMedia), '1 1 auto');
    };
    verify(css);
    const target = '.gal .gal-notice > span'; assert.equal(css.split(target).length - 1, 1);
    assert.throws(() => verify(css.replace(target, '.gal-notice > span')), assert.AssertionError);
  });
  it('R124 ряд разделов эмодзи можно прокрутить до последних вкладок при крупном шрифте', () => {
    // Скрытая полоса прокрутки не означает отсутствие горизонтального скролла.
    const verify = (source: string) => assert.equal(declaration(source, '.emoji-tabs', 'overflow-x'), 'auto');
    verify(css);
    assert.throws(() => verify(mutate('.emoji-tabs', 'overflow-x', () => 'hidden')), assert.AssertionError);
  });
  it('R124 кнопка опасного действия не переносится и не сжимается соседним текстом', () => {
    // Подпись действия должна оставаться целой, а пояснение уступать место кнопке.
    const verify = (source: string) => {
      assert.equal(declaration(source, '.danger-zone > button', 'white-space'), 'nowrap');
      assert.equal(declaration(source, '.danger-zone > button', 'flex-shrink'), '0');
    };
    verify(css);
    for (const property of ['white-space', 'flex-shrink'])
      assert.throws(() => verify(mutate('.danger-zone > button', property, () => undefined)), assert.AssertionError);
  });
  it('R124 длинный пункт контекстного листа переносится вместо обрезки в одну строку', () => {
    // В крупном кегле односложная метка не заменяет полное объяснение пункта.
    const verify = (source: string) => assert.equal(declaration(source, '.ctx-menu.sheet .ctx-label-main', 'white-space'), 'normal');
    verify(css);
    assert.throws(() => verify(mutate('.ctx-menu.sheet .ctx-label-main', 'white-space', () => 'nowrap')), assert.AssertionError);
  });
});

describe('R123 подгонка панели выбора при Android textZoom', () => {
  for (const [child, properties] of [
    ['.sel-bar-btn', ['flex-direction', 'gap', 'padding', 'min-height', 'font-size', 'line-height', 'border-radius']],
    ['.sel-bar-label', ['max-width', 'overflow', 'text-align', 'text-overflow', 'white-space', 'overflow-wrap']],
  ] as const) {
    it(`R123 ${child} в data-fit col имеет ровно те же свойства, что контейнер 20.5em`, () => {
      // Две копии нужны старому WebView; рассинхрон оставит крупный текст обрезанным только на Android.
      const base = `.app.m-content .composer.sel-bar ${child}`;
      const fitted = `.app.m-content .composer.sel-bar[data-fit="col"] ${child}`;
      const verify = (source: string) => {
        const blocks = guardCssBlocks(source);
        const container = guardDeclarations(guardScope(blocks, '@container (max-width: 20.5em)'), base);
        const actual = guardDeclarations(blocks, fitted);
        assert.deepEqual([...container.keys()].sort(), [...properties].sort(), 'полный набор контейнерного правила');
        assert.deepEqual([...actual].sort(), [...container].sort(), 'значения и набор свойств обеих копий совпадают');
      };
      verify(css);
      const block = guardCssBlocks(css).find(b => b.header === fitted); assert.ok(block);
      // Каждое свойство важно: проверка не должна сравнивать только flex-direction/white-space.
      for (const property of properties)
        assert.throws(() => verify(mutateGuardDeclaration(block, property, 'initial')), assert.AssertionError, property);
    });
  }
  it('R123 обе ступени data-fit скрывают число, обычная широкая панель сохраняет его', () => {
    // Первая ступень n должна экономить место без принудительного перехода к колонкам.
    const verify = (source: string) => {
      const blocks = guardCssBlocks(source);
      assert.equal(guardDeclarations(blocks, '.app.m-content .composer.sel-bar[data-fit] .sel-bar-n').get('display'), 'none');
      assert.notEqual(guardDeclarations(blocks, '.app.m-content .composer.sel-bar .sel-bar-n').get('display'), 'none');
    };
    verify(css);
    const rule = guardCssBlocks(css).find(b => b.header === '.app.m-content .composer.sel-bar[data-fit] .sel-bar-n'); assert.ok(rule);
    assert.throws(() => verify(mutateGuardDeclaration(rule, 'display', 'inline')), assert.AssertionError);
  });
});

describe('R122 полноэкранные слои — фон до края, управление внутри вставок', () => {
  const declarations = (source: string, selector: string) => guardDeclarations(guardCssBlocks(source), selector);
  const value = (source: string, selector: string, property: string) => {
    const found = declarations(source, selector).get(property);
    assert.ok(found, `${selector}: есть ${property}`);
    return found;
  };
  function four(source: string, selector: string, property: string) {
    // Пробелы внутри calc/max не разделяют стороны shorthand; проверяем именно нужную сторону.
    const parts = splitCss(value(source, selector, property), ' ').filter(Boolean);
    assert.ok(parts.length >= 1 && parts.length <= 4);
    return [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
  }
  const reference = (expression: string, side: string) => assert.ok(expression.includes(`var(--sa-${side})`),
    `сторона ${side} сохраняет собственную вставку: ${expression}`);
  function lateral(source: string, selector: string, property: string) {
    const sides = four(source, selector, property);
    reference(sides[1], 'r'); reference(sides[3], 'l');
  }
  function mutate(selector: string, property: string, transform: (old: string) => string) {
    const blocks = guardCssBlocks(css);
    const block = blocks.slice().reverse().find(b => !b.header.startsWith('@') && splitCss(b.header, ',').includes(selector)
      && guardDeclarations([b], selector).has(property));
    assert.ok(block, 'контрфакт адресует реальную декларацию нужного селектора');
    const old = value(css, selector, property); const next = transform(old);
    assert.notEqual(next, old, 'контрфакт действительно меняет значение');
    return mutateGuardDeclaration(block, property, next);
  }
  it('R122 верхний и нижний токены корня используют максимум browser/native, удалённый токен не проходит', () => {
    // Один корректный env в другом месте не спасает отсутствующий общий токен у всех новых панелей.
    const verify = (source: string) => {
      for (const [side, token, native] of [['top', 't', 'sat'], ['bottom', 'b', 'sab']])
        assert.equal(value(source, ':root', `--sa-${token}`), `max(env(safe-area-inset-${side}), var(--gv-${native}, 0px))`);
      checkNativeInsets(source, ['top', 'bottom']);
    };
    verify(css);
    const root = guardCssBlocks(css).find(b => b.header === ':root' && guardDeclarations([b], ':root').has('--sa-b'));
    assert.ok(root);
    const body = root.body.replace(/--sa-b\s*:[^;]+;/, ''); assert.notEqual(body, root.body);
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(clean.split(root.body).length - 1, 1);
    assert.throws(() => verify(clean.replace(root.body, body)), assert.AssertionError);
  });
  it('R122 фон просмотрщика, камеры и редактора остаётся inset 0, вставки не сдвигают весь слой', () => {
    // Защищаем полноэкранное затемнение: сдвиг фона оставит открытый чат под системными полосами.
    const verify = (source: string) => {
      for (const selector of ['.lightbox', '.cam-screen', '.photo-editor']) assert.equal(value(source, selector, 'inset'), '0');
    };
    verify(css);
    assert.throws(() => verify(mutate('.lightbox', 'inset', () => 'var(--sa-t) 0 0 0')), assert.AssertionError);
  });
  it('R122 шапка и обе стрелки просмотра защищают свою сторону, не зеркальную', () => {
    // Выход стрелки «следующее» под панель справа делает навигацию недоступной в ландшафте.
    const verify = (source: string) => {
      lateral(source, '.lb-top', 'padding');
      reference(value(source, '.lb-nav.prev', 'left'), 'l');
      reference(value(source, '.lb-nav.next', 'right'), 'r');
    };
    verify(css);
    assert.throws(() => verify(mutate('.lb-nav.next', 'right', old => old.replace('var(--sa-r)', '0px'))), assert.AssertionError);
  });
  it('R122 сцена держит четыре поля, видео до 600px сохраняет боковые вставки после фото-override', () => {
    // Позднее обнуление полей фото не должно обнулить поля родного видеоплеера с его кнопками.
    const sides = four(css, '.lb-stage', 'padding');
    for (const [index, side] of ['t', 'r', 'b', 'l'].entries()) reference(sides[index], side);
    const phone = guardScope(guardCssBlocks(css), '@media (max-width: 600px)');
    const video = guardDeclarations(phone, '.lb-stage.video');
    assert.equal(video.get('padding-left'), 'var(--sa-l)'); assert.equal(video.get('padding-right'), 'var(--sa-r)');
    const relevant = phone.filter(b => splitCss(b.header, ',').some(s => s === '.lb-stage' || s === '.lb-stage.video'));
    assert.equal(relevant.at(-1)?.header, '.lb-stage.video', 'последний override — видео с более сильным селектором');
  });
  it('R122 нижняя полоса и подпись подняты над навигацией, ширина вычитает обе боковые вставки', () => {
    // Центрированные панели защищаются ограничением ширины, а не сдвигом left:50%.
    const verify = (source: string) => {
      checkNativeInsets(source, ['bottom']);
      for (const selector of ['.lb-bottom', '.lb-caption']) {
        reference(value(source, selector, 'bottom'), 'b');
        const width = value(source, selector, 'max-width');
        assert.match(width, /- var\(--sa-l\) - var\(--sa-r\)/);
      }
    };
    verify(css);
    for (const selector of ['.lb-bottom', '.lb-caption'])
      assert.throws(() => verify(mutate(selector, 'bottom', old => old.replace('var(--sa-b)', '0px'))), assert.AssertionError);
    assert.throws(() => verify(mutate('.lb-bottom', 'bottom', old => old.replace('var(--sa-b)', 'env(safe-area-inset-bottom)'))), assert.AssertionError);
  });
  it('R122 верх камеры, управление съёмкой и просмотр кадра имеют оба боковых padding', () => {
    // Ни один из трёх режимов камеры не должен потерять кнопку у бокового выреза.
    const verify = (source: string) => {
      for (const selector of ['.cam-top', '.cam-bottom', '.cam-preview-bar']) lateral(source, selector, 'padding');
    };
    verify(css);
    assert.throws(() => verify(mutate('.cam-top', 'padding', old => old.replace('var(--sa-l)', '0px'))), assert.AssertionError);
  });
  it('R122 сцена редактора защищена боковыми margin, полоса инструментов — padding', () => {
    // Margin сцены и padding кнопок выполняют разные задачи; var на неверной стороне не считается защитой.
    lateral(css, '.pe-stage', 'margin'); lateral(css, '.pe-bar', 'padding');
  });
  it('R122 кнопки псевдополного экрана остаются над низом и внутри обеих боковых вставок', () => {
    // Сам показ экрана полноразмерный, безопасные поля нужны его интерактивным кнопкам.
    const selector = '.screen-viewer.pseudo-fs .screen-controls';
    const verify = (source: string) => {
      for (const [property, side] of [['padding-left', 'l'], ['padding-right', 'r'], ['padding-bottom', 'b']])
        reference(value(source, selector, property), side);
    };
    verify(css);
    assert.throws(() => verify(mutate(selector, 'padding-bottom', old => old.replace('var(--sa-b)', '0px'))), assert.AssertionError);
  });
  it('R122 телефонный звонок защищает четыре поля, четыре угла превью и кнопку сворачивания', () => {
    // Разные углы обязаны учитывать соответствующие стороны, а не один общий top для любого положения.
    const verify = (source: string) => {
      const sides = four(source, '.call-scrim.phone .call-screen', 'padding');
      for (const [index, side] of ['t', 'r', 'b', 'l'].entries()) reference(sides[index], side);
      for (const corner of ['tl', 'tr', 'bl', 'br']) {
        const selector = `.call-scrim.phone .call-preview.${corner}`;
        reference(value(source, selector, corner[0] === 't' ? 'top' : 'bottom'), corner[0]);
        reference(value(source, selector, corner[1] === 'l' ? 'left' : 'right'), corner[1]);
      }
      reference(value(source, '.call-min', 'left'), 'l');
      const top = value(source, '.call-min', 'top');
      checkNativeInsets(top, ['top']); assert.match(top, /max\(env\(safe-area-inset-top\)/);
    };
    verify(css);
    assert.throws(() => verify(mutate('.call-scrim.phone .call-screen', 'padding', old => old.replace('var(--sa-t)', '0px'))), assert.AssertionError);
  });
});

describe('R120 ландшафт — боковые вставки корня и неподвижных панелей', () => {
  const phone = '@media (max-width: 760px)';
  const desktop = '@media (min-width: 761px)';
  const scope = (source: string, media?: string) => media ? guardScope(guardCssBlocks(source), media) : guardCssBlocks(source);
  function check(source: string, selector: string, property: string, value: string, media?: string) {
    assert.equal(guardDeclarations(scope(source, media), selector).get(property), value, `${selector}: ${property}`);
  }
  function checkSide(source: string, selector: string, property: string, side: 'l' | 'r', media?: string) {
    assert.ok((guardDeclarations(scope(source, media), selector).get(property) ?? '').includes(`var(--sa-${side})`),
      `${selector}: ${property} учитывает боковую вставку ${side}`);
  }
  function withoutDeclaration(selector: string, property: string, media?: string) {
    const block = scope(css, media).slice().reverse().find(b => !b.header.startsWith('@')
      && splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has(property));
    assert.ok(block, `${selector}: мутант адресует существующую декларацию`);
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const matches = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m =>
      m[1].trim().replace(/\s+/g, ' ') === block.header && m[2] === block.body);
    assert.equal(matches.length, 1, 'удаляется декларация ровно одного реального блока');
    const changed = block.body.replace(new RegExp(`(^|;)\\s*${property}\\s*:[^;]+;?`), '$1');
    assert.notEqual(changed, block.body);
    const at = matches[0].index + matches[0][0].indexOf('{') + 1;
    return clean.slice(0, at) + changed + clean.slice(at + block.body.length);
  }
  it('корень выбирает максимум браузерной и нативной вставки с обеих сторон', () => {
    // Голый env возвращает ноль на старом WebView и прячет элементы под вырезом.
    const verify = (source: string) => {
      check(source, ':root', '--sa-l', 'max(env(safe-area-inset-left), var(--gv-sal, 0px))');
      check(source, ':root', '--sa-r', 'max(env(safe-area-inset-right), var(--gv-sar, 0px))');
      checkNativeInsets(source, ['left', 'right']);
    };
    verify(css);
    const block = scope(css).find(b => b.header === ':root' && guardDeclarations([b], ':root').has('--sa-l')); assert.ok(block);
    assert.throws(() => verify(mutateGuardDeclaration(block, '--sa-l', 'env(safe-area-inset-left)')), assert.AssertionError);
  });
  it('обе раскладки приложения оставляют место слева и справа', () => {
    // Правило вне media защищает и телефон, и широкую телефонную раскладку в ландшафте.
    const verify = (source: string) => {
      check(source, '.app', 'padding-left', 'var(--sa-l)');
      check(source, '.app', 'padding-right', 'var(--sa-r)');
    };
    verify(css);
    assert.throws(() => verify(withoutDeclaration('.app', 'padding-right')), assert.AssertionError);
  });
  it('раскладка шире 760 также защищена сверху и снизу нативными вставками', () => {
    // Широкий ландшафт телефона должен сохранять status bar, несмотря на десктопную сетку.
    const verify = (source: string) => {
      check(source, '.app', 'padding-top', 'max(env(safe-area-inset-top), var(--gv-sat, 0px))', desktop);
      check(source, '.app', 'padding-bottom', 'max(env(safe-area-inset-bottom), var(--gv-sab, 0px))', desktop);
    };
    verify(css);
    const blocks = guardCssBlocks(css); const media = blocks.find(b => b.header === desktop); assert.ok(media);
    assert.ok(media.children.some(b => b.header === '.app'));
    const app = media.children.find(b => b.header === '.app'); assert.ok(app);
    const changed = media.body.replace(`.app {${app.body}}`, ''); assert.notEqual(changed, media.body);
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = clean.indexOf(media.body); assert.ok(at >= 0); assert.equal(clean.indexOf(media.body, at + 1), -1);
    const mutant = clean.slice(0, at) + changed + clean.slice(at + media.body.length);
    assert.throws(() => verify(mutant), assert.AssertionError);
  });
  it('голосовой док учитывает обе стороны на ПК, участников справа и телефонный override', () => {
    // Override участников и телефонный override не должны отменить безопасный отступ базового дока.
    const verify = (source: string) => {
      for (const media of [undefined, phone]) {
        checkSide(source, '.voice-dock', 'left', 'l', media);
        checkSide(source, '.voice-dock', 'right', 'r', media);
      }
      check(source, '.app.has-members .voice-dock', 'right', 'calc(var(--sa-r) + 220px)');
    };
    verify(css);
    for (const [selector, media] of [['.voice-dock', undefined], ['.voice-dock', phone], ['.app.has-members .voice-dock', undefined]] as const)
      assert.throws(() => verify(withoutDeclaration(selector, 'right', media)), assert.AssertionError);
  });
  it('ручка боковой панели, тосты и обновление не заходят под боковую системную область', () => {
    // Fixed-панели не наследуют padding корня; каждой нужен собственный безопасный якорь.
    checkSide(css, '.sidebar-resizer', 'left', 'l');
    checkSide(css, '.toast-stack', 'right', 'r');
    checkSide(css, '.update-panel', 'right', 'r');
  });
  it('телефонные звонок, кнопки шапки, создание ЛС и профиль имеют безопасные боковые якоря', () => {
    // Каждая кнопка и полоса проверяется в телефонном media, а не по случайному var где-либо в CSS.
    const verify = (source: string) => {
      for (const selector of ['.call-bar.call-bar-top', '.call-chip', '.mobile-profile']) {
        checkSide(source, selector, 'left', 'l', phone);
        checkSide(source, selector, 'right', 'r', phone);
      }
      checkSide(source, '.app.m-content .mobile-back', 'left', 'l', phone);
      checkSide(source, '.app.m-content.has-members .mobile-members-btn', 'right', 'r', phone);
      checkSide(source, '.dm-fab', 'right', 'r', phone);
    };
    verify(css);
    for (const selector of ['.dm-fab', '.call-bar.call-bar-top'])
      assert.throws(() => verify(withoutDeclaration(selector, 'right', phone)), assert.AssertionError);
  });
  it('полноширинные фон навигации и панель участников оставляют безопасное место содержимому', () => {
    // Их фон намеренно до края: боковые вставки находятся в padding, не в left/right.
    const verify = (source: string) => {
      check(source, '.mobile-nav', 'left', '0', phone); check(source, '.mobile-nav', 'right', '0', phone);
      check(source, '.mobile-nav', 'padding-left', 'var(--sa-l)', phone);
      check(source, '.mobile-nav', 'padding-right', 'var(--sa-r)', phone);
      const panel = '.app.m-members-open > .members-panel';
      check(source, panel, 'left', '0', phone); check(source, panel, 'right', '0', phone);
      check(source, panel, 'padding', 'calc(max(env(safe-area-inset-top), var(--gv-sat, 0px)) + var(--m-callbar-h, 0px)) calc(6px + var(--sa-r)) calc(58px + max(env(safe-area-inset-bottom), var(--gv-sab, 0px))) calc(6px + var(--sa-l))', phone);
    };
    verify(css);
    assert.throws(() => verify(withoutDeclaration('.mobile-nav', 'padding-right', phone)), assert.AssertionError);
  });
  it('ни одна боковая env-вставка не обходится без соответствующего нативного max', () => {
    // Проверка всего дерева ловит новое голое env даже вне перечисленных неподвижных панелей.
    checkNativeInsets(css, ['left', 'right']);
    for (const side of ['left', 'right']) {
      const native = side === 'left' ? '--gv-sal' : '--gv-sar';
      const from = `max(env(safe-area-inset-${side}), var(${native}, 0px))`;
      const mutant = css.replace(from, `env(safe-area-inset-${side})`); assert.notEqual(mutant, css);
      assert.throws(() => checkNativeInsets(mutant, ['left', 'right']), assert.AssertionError);
    }
  });
});

// Контрфакты меняют декларацию настоящего CSS, не отдельную фикстуру с желаемым ответом.
function mutateGuardDeclaration(block: GuardCssBlock, property: string, value: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declaration = new RegExp(`(^|;)\\s*${property}\\s*:[^;]+`, 'g');
  const changed = block.body.replace(declaration, `$1 ${property}: ${value}`);
  assert.notEqual(changed, block.body, `мутант меняет ${property}`);
  const matches = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m =>
    m[1].trim().replace(/\s+/g, ' ') === block.header && m[2] === block.body);
  assert.equal(matches.length, 1, 'мутант адресует ровно один реальный блок по селектору и декларациям');
  const match = matches[0];
  const bodyAt = match.index + match[0].indexOf('{') + 1;
  const mutant = clean.slice(0, bodyAt) + changed + clean.slice(bodyAt + block.body.length);
  assert.notEqual(mutant, clean);
  return mutant;
}

describe('R118 узкие экраны — правила с областью действия и контрфактами', () => {
  const landscapeMedia = '@media (orientation: landscape) and (max-height: 600px)';
  const phoneMedia = '@media (max-width: 760px)';
  function checkDeclaration(source: string, scope: (blocks: GuardCssBlock[]) => GuardCssBlock[], selector: string, property: string, value: string) {
    assert.equal(guardDeclarations(scope(guardCssBlocks(source)), selector).get(property), value, `${selector}: ${property}`);
  }
  function pair(scope: (blocks: GuardCssBlock[]) => GuardCssBlock[], selector: string, property: string, value: string, bad: string) {
    const check = (source: string) => checkDeclaration(source, scope, selector, property, value);
    check(css);
    const block = scope(guardCssBlocks(css)).slice().reverse().find(b => !b.header.startsWith('@') && splitCss(b.header, ',').includes(selector)
      && guardDeclarations([b], selector).has(property));
    assert.ok(block, 'правило найдено в нужной области');
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), { name: 'AssertionError' });
  }
  it('ссылка и обёртка вложения не шире пузыря даже при сохранённой пиксельной ширине', () => {
    for (const selector of ['.att-img-link', '.att-img-wrap']) pair(b => b, selector, 'max-width', '100%', 'none');
  });
  it('длинный статус ЛС обрезается многоточием в одной строке, подпись не шире шапки', () => {
    for (const [property, value, bad] of [['overflow', 'hidden', 'visible'], ['text-overflow', 'ellipsis', 'clip'], ['white-space', 'nowrap', 'normal']])
      pair(b => b, '.dm-who-status', property, value, bad);
    pair(b => b, '.dm-who .dm-who-sub', 'max-width', '100%', 'none');
  });
  it('низкий ландшафт галереи имеет четыре колонки и квадратные строки с тремя зазорами', () => {
    const scope = (b: GuardCssBlock[]) => guardScope(b, landscapeMedia);
    pair(scope, '.gal-grid', 'grid-template-columns', 'repeat(4, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))');
    pair(scope, '.gal-grid', 'grid-auto-rows', 'calc((100cqw - 3 * var(--sp-1)) / 4)', 'calc((100cqw - 2 * var(--sp-1)) / 3)');
  });
  it('камера и системный выбор в ландшафте занимают один ряд с весом выше базовой кнопки', () => {
    const scope = (b: GuardCssBlock[]) => guardScope(b, landscapeMedia);
    // Два класса и button у override сильнее позднего button.gal-system/button.gal-cam.
    for (const selector of ['.gal-grid > button.gal-cam', '.gal-grid > button.gal-system']) {
      pair(scope, selector, 'grid-row', 'span 1', 'span 2');
      const check = (source: string) => checkDeclaration(source, scope, selector, 'grid-row', 'span 1');
      check(css);
      const mutant = css.replace(selector, selector.replace('.gal-grid > ', ''));
      assert.notEqual(mutant, css);
      assert.throws(() => check(mutant), { name: 'AssertionError' });
    }
  });
  it('на узком телефоне сегменты делят ширину по подписи и не сжимают самое длинное слово', () => {
    // R119: крупный шрифт требует этих правил во всём телефонном media, не только до 359px.
    const scope = (b: GuardCssBlock[]) => guardScope(b, phoneMedia);
    pair(scope, '.settings-modal .seg button', 'min-width', 'min-content', '0');
    pair(scope, '.settings-modal .seg button', 'flex', '1 1 auto', '1 1 0');
    pair(scope, '.settings-modal .seg', 'flex-wrap', 'wrap', 'nowrap');
  });
  it('удаление аккаунта на телефоне ставит пояснение и полноширинную кнопку столбцом', () => {
    const scope = (b: GuardCssBlock[]) => guardScope(b, phoneMedia);
    pair(scope, '.settings-modal .danger-zone:has(> .muted)', 'flex-direction', 'column', 'row');
    pair(scope, '.settings-modal .danger-zone:has(> .muted) > button.leave', 'width', '100%', 'auto');
  });
  it('при ширине до 379 число не выталкивает кнопки панели выделения за экран', () => {
    pair(b => guardScope(b, '@media (max-width: 379px)'), '.app.m-content .composer.sel-bar .sel-bar-n', 'display', 'none', 'inline');
    const check = (source: string) => checkDeclaration(source, b => guardScope(b, '@media (max-width: 379px)'),
      '.app.m-content .composer.sel-bar .sel-bar-n', 'display', 'none');
    check(css);
    const mutant = css.replace('@media (max-width: 379px)', '@media (max-width: 359px)');
    assert.notEqual(mutant, css);
    assert.throws(() => check(mutant), { name: 'AssertionError' });
  });
});

it('R119 панель выделения является inline-size контейнером для крупного шрифта', () => {
  const selector = '.app.m-content .composer.sel-bar';
  const scope = (source: string) => guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
  const check = (source: string) => assert.equal(guardDeclarations(scope(source), selector).get('container-type'), 'inline-size');
  check(css);
  const block = scope(css).find(b => b.header === selector && guardDeclarations([b], selector).has('container-type'));
  assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'container-type', 'normal')), assert.AssertionError);
});

it('R119 пороги панели выделения зависят от em: сначала скрыто число, затем кнопки столбцом', () => {
  // При системном крупном шрифте px-порог не сработает: требуется ширина контейнера в единицах шрифта.
  const check = (source: string) => {
    const blocks = guardCssBlocks(source);
    assert.equal(guardDeclarations(guardScope(blocks, '@container (max-width: 22.5em)'),
      '.app.m-content .composer.sel-bar .sel-bar-n').get('display'), 'none');
    const small = guardScope(blocks, '@container (max-width: 20.5em)');
    assert.equal(guardDeclarations(small, '.app.m-content .composer.sel-bar .sel-bar-btn').get('flex-direction'), 'column');
    assert.equal(guardDeclarations(small, '.app.m-content .composer.sel-bar .sel-bar-label').get('white-space'), 'normal');
  };
  check(css);
  for (const threshold of ['22.5', '20.5']) {
    const from = `@container (max-width: ${threshold}em)`;
    assert.ok(css.includes(from));
    assert.throws(() => check(css.replace(from, `@container (max-width: ${threshold}px)`)), assert.AssertionError);
  }
  for (const [header, selector, property, bad] of [
    ['@container (max-width: 22.5em)', '.app.m-content .composer.sel-bar .sel-bar-n', 'display', 'inline'],
    ['@container (max-width: 20.5em)', '.app.m-content .composer.sel-bar .sel-bar-btn', 'flex-direction', 'row'],
  ]) {
    const block = guardScope(guardCssBlocks(css), header).find(b => b.header === selector);
    assert.ok(block); assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
});

it('R119 длинный email переносится целиком, а не прячется многоточием', () => {
  const check = (source: string) => {
    const value = guardDeclarations(guardCssBlocks(source), '.acc-email-val');
    assert.equal(value.get('overflow-wrap'), 'anywhere');
    assert.notEqual(value.get('text-overflow'), 'ellipsis', 'email не обрезается');
  };
  check(css);
  const block = guardCssBlocks(css).find(b => b.header === '.acc-email-val'); assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'overflow-wrap', 'normal')), assert.AssertionError);
  const mutant = css.replace('.acc-email-val {', '.acc-email-val { text-overflow: ellipsis;');
  assert.notEqual(mutant, css); assert.throws(() => check(mutant), assert.AssertionError);
});

// Узкий разбор дерева блоков: вложенный @supports не считается безусловным правилом media.
interface GuardCssBlock { header: string; body: string; children: GuardCssBlock[] }
function guardCssBlocks(source: string): GuardCssBlock[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: GuardCssBlock[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf('{', cursor);
    if (open < 0) break;
    let end = open + 1, depth = 1;
    while (end < clean.length && depth) {
      if (clean[end] === '{') depth++;
      else if (clean[end] === '}') depth--;
      end++;
    }
    assert.equal(depth, 0, 'CSS блок сбалансирован');
    const header = clean.slice(cursor, open).trim().replace(/\s+/g, ' ');
    const body = clean.slice(open + 1, end - 1);
    blocks.push({ header, body, children: header.startsWith('@') ? guardCssBlocks(body) : [] });
    cursor = end;
  }
  return blocks;
}
function guardScope(blocks: GuardCssBlock[], header: string) {
  return blocks.filter(b => b.header === header).flatMap(b => b.children);
}
function guardDeclarations(blocks: GuardCssBlock[], selector: string) {
  const values = new Map<string, string>();
  for (const block of blocks) if (!block.header.startsWith('@') && splitCss(block.header, ',').includes(selector)) {
    for (const declaration of splitCss(block.body, ';')) {
      const colon = declaration.indexOf(':');
      if (colon >= 0) values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
  }
  return values;
}
const roundBubbleSelector = 'html:not([data-kb]) .message.bub .bubble.sticker:has(.round-msg.playing)';
const roundPhoneMedia = '@media (max-width: 760px) and (orientation: portrait)';
function checkRoundPhone(source: string) {
  const phone = guardScope(guardCssBlocks(source), roundPhoneMedia);
  const supported = guardScope(phone, '@supports (container-type: inline-size) and selector(:has(*))');
  assert.ok(supported.length, 'современное правило ограничено supports внутри телефона');
  const bubble = guardDeclarations(supported, roundBubbleSelector);
  assert.equal(bubble.get('max-width'), 'none', 'пузырь не ограничивает играющий кружок');
  assert.equal(bubble.get('container-type'), 'inline-size', 'пузырь является контейнером кружка');
  assert.equal(bubble.get('flex'), '1 1 0', 'пузырь занимает свободную ширину строки');
  assert.equal(bubble.get('min-width'), '0', 'пузырь может сжаться внутри строки');
  const round = guardDeclarations(supported, `${roundBubbleSelector} .round-msg.playing`).get('--round') ?? '';
  assert.deepEqual(splitCss(round.slice(round.indexOf('(') + 1, -1), ','), ['100cqw', '480px'], 'кружок ограничен контейнером и 480px');
  assert.match(round, /^min\(/);
  assert.equal(guardDeclarations(supported, 'html:not([data-kb]) .message.bub.mine .bubble.sticker:has(.round-msg.playing) .attachments').get('justify-content'), 'flex-end', 'свой кружок у правого края');
  const fallback = guardDeclarations(phone, 'html:not([data-kb]) .round-msg.playing').get('--round') ?? '';
  assert.match(fallback, /^min\(/);
  const args = splitCss(fallback.slice(fallback.indexOf('(') + 1, -1), ',');
  assert.equal(args[1], '480px', 'старый WebView сохраняет потолок');
  assert.match(args[0] ?? '', /^calc\(\s*100vw\s*-\s*28px\s*\)$/, 'старый WebView сохраняет размер без контейнера');
}

it('R114 играющий кружок телефона помещается в контейнер строки, свой справа, старый WebView с запасным размером', () => {
  // Наличие cqw где-нибудь в файле не спасает кружок вне supports или пузырь со старым max-width.
  checkRoundPhone(css);
  const rule = guardScope(guardScope(guardCssBlocks(css), roundPhoneMedia), '@supports (container-type: inline-size) and selector(:has(*))')
    .find(b => b.header === roundBubbleSelector);
  assert.ok(rule);
  for (const [from, to, message] of [
    ['max-width: none;', 'max-width: 80%;', /пузырь не ограничивает/],
    ['container-type: inline-size;', '', /пузырь является контейнером/],
  ] as const) {
    const mutatedBody = rule.body.replace(from, to);
    assert.notEqual(mutatedBody, rule.body);
    const mutant = css.replace(rule.body, mutatedBody);
    assert.notEqual(mutant, css);
    assert.throws(() => checkRoundPhone(mutant), message);
  }
  const viewportRound = css.replace('min(100cqw, 480px)', 'min(100vw, 480px)');
  assert.notEqual(viewportRound, css);
  assert.throws(() => checkRoundPhone(viewportRound), /кружок ограничен контейнером/);
});

it('R116 рост кружка ограничен портретом без клавиатуры, низкий ландшафт имеет собственный потолок', () => {
  // Проверяем область действия CSS, а не размеры HappyDOM: он не выполняет раскладку.
  const check = (source: string) => {
    checkRoundPhone(source);
    const blocks = guardCssBlocks(source);
    const portrait = blocks.find(b => b.header === roundPhoneMedia);
    assert.ok(portrait);
    const visit = (rows: GuardCssBlock[]) => {
      for (const b of rows) {
        if (!b.header.startsWith('@') && b.header.includes('.round-msg.playing'))
          for (const selector of splitCss(b.header, ',')) assert.ok(selector.startsWith('html:not([data-kb]) '), 'каждый растущий селектор запрещён с клавиатурой');
        visit(b.children);
      }
    };
    visit(portrait.children);
    const landscape = guardScope(blocks, '@media (orientation: landscape) and (max-height: 500px)');
    assert.equal(guardDeclarations(landscape, '.round-msg').get('--round'), 'min(240px, 60vh)', 'низкий ландшафт ограничивает круг высотой');
  };
  check(css);
  for (const [from, to, message] of [
    [roundPhoneMedia, '@media (max-width: 760px)', /supports внутри телефона/],
    ['html:not([data-kb]) .round-msg.playing', '.round-msg.playing', /min|клавиатурой/],
    [roundBubbleSelector, roundBubbleSelector.replace('html:not([data-kb]) ', ''), /пузырь не ограничивает/],
    ['@media (orientation: landscape) and (max-height: 500px)', '@media (orientation: portrait) and (max-height: 500px)', /низкий ландшафт/],
  ] as const) {
    const mutant = css.replace(from, to); assert.notEqual(mutant, css);
    assert.throws(() => check(mutant), message);
  }
});

function checkSelectionPhone(source: string) {
  const blocks = guardCssBlocks(source);
  const narrow = guardScope(blocks, '@media (max-width: 379px)');
  assert.equal(guardDeclarations(narrow, '.app.m-content .composer.sel-bar .sel-bar-n').get('display'), 'none', 'узкий телефон скрывает только число');
  const tiny = guardScope(blocks, '@media (max-width: 345px)');
  assert.equal(guardDeclarations(tiny, '.app.m-content .composer.sel-bar').get('gap'), 'var(--sp-1)');
  const button = guardDeclarations(tiny, '.app.m-content .composer.sel-bar .sel-bar-btn');
  assert.equal(button.get('font-size'), '13px');
  assert.equal(button.get('gap'), 'var(--sp-1)');
  assert.equal(button.get('padding'), '0 var(--sp-1)');
  assert.notEqual(guardDeclarations(blocks, '.app.m-content .composer.sel-bar .sel-bar-n').get('display'), 'none', 'широкий экран не теряет число');
}
it('R114 узкая панель выделения скрывает число до 379px и уменьшает кнопки до 345px', () => {
  checkSelectionPhone(css);
  const withoutNarrow = css.replace(/@media\s*\(max-width:\s*379px\)/, '@media (max-width: 300px)');
  assert.notEqual(withoutNarrow, css);
  assert.throws(() => checkSelectionPhone(withoutNarrow), /узкий телефон скрывает только число/);
});

function checkContextCeiling(source: string) {
  const value = guardDeclarations(guardCssBlocks(source), '.ctx-menu:not(.sheet)').get('max-height') ?? '';
  const calc = cssCalls(value).find(c => c.name === 'calc' && c.start === 0 && c.end === value.length);
  assert.ok(calc, 'потолок меню вычислен через calc');
  // Минусы внутри имён var/env вложены в скобки и не являются операторами вычитания.
  const terms = splitCss(calc.body, '-');
  assert.deepEqual(terms.slice(0, 2), ['var(--vh-px, 100dvh)', '16px']);
  assert.equal(terms.length, 4, 'потолок меню вычитает обе системные вставки');
  for (const [index, side] of [[2, 'top'], [3, 'bottom']] as const) {
    checkNativeInsets(terms[index], [side]);
    assert.match(terms[index], /^max\(/, `потолок вычитает ${side} целиком`);
  }
}
it('R114 потолок якорного меню вычитает верхнюю и нижнюю native вставки из высоты окна', () => {
  checkContextCeiling(css);
  const rule = /\.ctx-menu:not\(\.sheet\)\s*\{[^{}]*\}/.exec(css);
  assert.ok(rule);
  for (const side of ['top', 'bottom']) {
    const nativeVar = side === 'top' ? 'sat' : 'sab';
    const mutantBody = rule[0].replace(new RegExp(`-\\s*max\\(env\\(safe-area-inset-${side}\\),\\s*var\\(--gv-${nativeVar},\\s*0px\\)\\)`), '');
    assert.notEqual(mutantBody, rule[0]);
    assert.throws(() => checkContextCeiling(css.replace(rule[0], mutantBody)), /потолок меню вычитает обе/);
  }
});

it('строка сетки приложения ограничена высотой окна, телефон запрещает выделение интерфейса, но сохраняет поля', () => {
  // Без minmax композер выезжал за экран; без исключения поля невозможно копировать текст набора.
  const { base, media } = mediaParts();
  assert.equal(declarationsIn(base, '.app').get('grid-template-rows'), 'minmax(0, 1fr)');
  const phone = media.filter(m => m.query === '@media (max-width: 760px)').map(m => m.body).join('\n');
  assert.equal(declarationsIn(phone, 'body').get('user-select'), 'none');
  assert.equal(declarationsIn(phone, 'body').get('-webkit-touch-callout'), 'none');
  for (const selector of ['input', 'textarea', "[contenteditable]:not([contenteditable='false'])"]) assert.equal(declarationsIn(phone, selector).get('user-select'), 'text');
  assert.throws(() => assert.equal(declarationsIn(base.replace('grid-template-rows: minmax(0, 1fr);', ''), '.app').get('grid-template-rows'), 'minmax(0, 1fr)'), assert.AssertionError);
});

const lastDeclarations = (selector: string) => {
  const result = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (block[1].split(',').some(s => s.trim() === selector)) {
    for (const declaration of block[2].split(';')) { const at = declaration.indexOf(':'); if (at >= 0) result.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim()); }
  }
  return result;
};

function mediaParts(source = css) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let base = ''; let cursor = 0;
  const media: { query: string; body: string }[] = [];
  for (;;) {
    const start = clean.indexOf('@media', cursor);
    if (start < 0) { base += clean.slice(cursor); break; }
    base += clean.slice(cursor, start);
    const open = clean.indexOf('{', start); let end = open + 1; let depth = 1;
    while (end < clean.length && depth) { if (clean[end] === '{') depth++; if (clean[end] === '}') depth--; end++; }
    assert.equal(depth, 0, 'media-блок имеет закрывающую скобку');
    media.push({ query: clean.slice(start, open).replace(/\s+/g, ' ').trim(), body: clean.slice(open + 1, end - 1) });
    cursor = end;
  }
  return { base, media };
}

it('телефон резервирует высоту полосы звонка в app и сдвигает назад ниже микрофона', () => {
  const check = (source: string) => {
    const phone = mediaParts(source).media.filter(m => m.query === '@media (max-width: 760px)').map(m => m.body).join('\n');
    const top = declarationsIn(phone, '.app').get('padding-top') ?? '';
    const calc = cssCalls(top).find(c => c.name === 'calc' && c.start === 0 && c.end === top.length);
    assert.ok(calc, 'app резервирует место звонка через calc');
    const parts = splitCss(calc.body, '+');
    assert.equal(parts.length, 2, 'app резервирует место звонка отдельным слагаемым');
    assert.match(parts[1], /^var\(\s*--m-callbar-h\s*,\s*0px\s*\)$/, 'app резервирует место звонка');
    checkNativeInsets(parts[0], ['top']);
    assert.match(declarationsIn(phone, '.app.m-content .mobile-back').get('top') ?? '', /var\(--m-callbar-h, 0px\)/, 'назад ниже полосы звонка');
  };
  check(css);
  const noPadding = css.replace(/(\.app\s*\{[^}]*padding-top:\s*calc\()max\(env\(safe-area-inset-top\), var\(--gv-sat, 0px\)\) \+ var\(--m-callbar-h, 0px\)(\);)/g,
    '$1max(env(safe-area-inset-top), var(--gv-sat, 0px))$2');
  assert.notEqual(noPadding, css); assert.throws(() => check(noPadding), /app резервирует место звонка/);
  const oldTop = css.replace(/(\.app\.m-content \.mobile-back\s*\{[^}]*?top:)\s*[^;]+;/, '$1 env(safe-area-inset-top);');
  assert.notEqual(oldTop, css); assert.throws(() => check(oldTop), /назад ниже полосы звонка/);
});

function splitCss(body: string, separator: string): string[] {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (!depth && body[i] === separator) { parts.push(body.slice(start, i).trim()); start = i + 1; }
  }
  assert.equal(depth, 0, 'CSS выражение сбалансировано');
  return [...parts, body.slice(start).trim()];
}
function cssCalls(source: string) {
  const calls: { name: string; start: number; end: number; body: string }[] = [];
  for (const match of source.matchAll(/\b(calc|max|env|var)\s*\(/g)) {
    const open = match.index + match[0].length - 1; let end = open + 1, depth = 1;
    while (end < source.length && depth) { if (source[end] === '(') depth++; else if (source[end] === ')') depth--; end++; }
    assert.equal(depth, 0, 'CSS функция сбалансирована');
    calls.push({ name: match[1], start: match.index, end, body: source.slice(open + 1, end - 1) });
  }
  return calls;
}
function checkNativeInsets(source: string, sides = ['top', 'bottom', 'left', 'right']) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, ''); const calls = cssCalls(clean);
  const vars: Record<string, string> = { top: '--gv-sat', right: '--gv-sar', bottom: '--gv-sab', left: '--gv-sal' };
  const sideOf = (body: string) => splitCss(body, ',')[0].replace('safe-area-inset-', '');
  const envs = calls.filter(c => c.name === 'env' && sides.includes(sideOf(c.body)));
  assert.ok(envs.length > 0, 'проверяются реальные системные вставки');
  for (const env of envs) {
    const side = sideOf(env.body);
    assert.ok(calls.some(c => {
      if (c.name !== 'max' || c.start > env.start || c.end < env.end) return false;
      const args = splitCss(c.body, ',');
      return args.length === 2 && args[0] === clean.slice(env.start, env.end)
        && new RegExp(`^var\\(\\s*${vars[side]}\\s*,\\s*0px\\s*\\)$`).test(args[1]);
    }), `вставка ${side} защищена своим native max`);
  }
}

it('старый WebView получает все четыре вставки через native max, не голый env', () => {
  // Старый WebView не знает системной панели; browser env без native fallback прячет интерфейс под ней.
  checkNativeInsets(css);
  const changed = css.replace(/max\(env\(safe-area-inset-bottom\),\s*var\(--gv-sab,\s*0px\)\)/, 'env(safe-area-inset-bottom)');
  assert.notEqual(changed, css);
  assert.throws(() => checkNativeInsets(changed), /вставка bottom защищена своим native max/);
  assert.throws(() => checkNativeInsets(changed.replace('env(safe-area-inset-bottom)', 'env(safe-area-inset-bottom, 0px)')),
    /вставка bottom защищена своим native max/, 'fallback внутри env не заменяет нативную вставку');
  const bareTop = css.replace(/max\(env\(safe-area-inset-top\),\s*var\(--gv-sat,\s*0px\)\)/, 'env(safe-area-inset-top)');
  assert.notEqual(bareTop, css);
  assert.throws(() => checkNativeInsets(bareTop), /вставка top защищена своим native max/);
});
function declarationsIn(source: string, selector: string) {
  const result = new Map<string, string>();
  for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (block[1].split(',').some(s => s.trim() === selector)) {
    for (const declaration of block[2].split(';')) { const at = declaration.indexOf(':'); if (at >= 0) result.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim()); }
  }
  return result;
}

it('угловая реакция скрыта без наведения и на телефоне, правила полосы не захватывают вложенные кнопки', () => {
  // Широкий селектор ломал кнопки ReactionBar, а видимая corner мешает касательному меню.
  const { base, media } = mediaParts();
  assert.equal(declarationsIn(base, '.msg-react.corner').get('visibility'), 'hidden');
  assert.ok(media.some(m => declarationsIn(m.body, '.app.m-content .msg-react.corner').get('display') === 'none !important'), 'телефон явно скрывает corner');
  assert.ok(declarationsIn(base, '.msg-actions > button').size > 0, 'стиль только прямых кнопок');
  assert.ok(declarationsIn(base, '.msg-actions > .msg-react > button').size > 0, 'кнопка реакции имеет явный уровень');
  assert.equal(declarationsIn(base, '.msg-actions button').size, 0);
  assert.ok(media.some(m => m.query === '@media (hover: hover)' && declarationsIn(m.body, '.msg-react:hover > .msg-react-pop').size > 0), 'раскрытие полосы ограничено hover');
});

it('подсказка горячих клавиш скрыта у касания, а причина жалобы сохраняет переводы строк', () => {
  // Телефон не должен обещать несуществующую клавиатуру; склеенные причины должны читаться по строкам.
  const { base, media } = mediaParts();
  assert.equal(declarationsIn(base, '.set-search kbd').get('white-space'), 'nowrap');
  const touch = media.find(m => m.query === '@media (hover: none) and (pointer: coarse)');
  assert.ok(touch, 'есть отдельное правило для устройства без hover');
  assert.equal(declarationsIn(touch.body, '.set-search kbd').get('display'), 'none');
  assert.equal(lastDeclarations('.fed-report-reason').get('white-space'), 'pre-line');
});

it('время поверх фото перехватывает тап только в узкой раскладке с грубым указателем', () => {
  // На ПК время должно пропускать мышь в фото, на телефоне — давать контекстное меню вместо открытия просмотра.
  const { base, media } = mediaParts();
  assert.equal(declarationsIn(base, '.message.bub .bub-meta.over').get('pointer-events'), 'none');
  const touch = media.find(m => m.query === '@media (pointer: coarse) and (max-width: 760px)');
  assert.ok(touch, 'телефонный media-блок найден вместе с вложенными правилами');
  assert.equal(declarationsIn(touch.body, '.message.bub .bub-meta.over').get('pointer-events'), 'auto');
});

it('масштабируется фото, а не страница; кнопка отправки не отнимает выделение поля', () => {
  // Нативный щипок страницы и выделение кнопки прятали экранную клавиатуру на телефоне.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta[^>]*name="viewport"[^>]*content="[^"]*user-scalable=no/);
  assert.equal(lastDeclarations('.composer .send-btn').get('user-select'), 'none');
  assert.equal(lastDeclarations('.lb-stage').get('touch-action'), 'none');
});

it('кнопки перехода и подтверждение пересылки привязаны к низу обёртки ленты', () => {
  // Старый отступ от всего чата поднимал кнопки при открытой клавиатуре или полосе ответа.
  assert.equal(lastDeclarations('.jump-down').get('bottom'), 'var(--sp-3)');
  assert.equal(lastDeclarations('.fwd-done').get('bottom'), 'var(--sp-3)');
  assert.equal(lastDeclarations('.jump-down.jump-back').get('bottom'), 'calc(var(--sp-3) + 46px)');
});

it('время и аватар пузыря не захватываются при выделении текста сообщения', () => {
  // Иначе копирование текста прихватывает метаданные и создаёт неожиданную область выделения.
  for (const selector of ['.message.bub .bub-meta', '.message.bub > .bub-ava']) assert.equal(lastDeclarations(selector).get('user-select'), 'none', selector);
});

it('меню отправки не выделяет слово под долгим нажатием, верх просмотрщика учитывает строку состояния', () => {
  // Иначе Android выделяет текст удержанного меню, а кнопки просмотра оказываются под системной строкой.
  assert.equal(lastDeclarations('.gal-hold').get('-webkit-user-select'), 'none', 'WebView не выделяет меню жестом удержания');
  assert.equal(lastDeclarations('.gal-hold').get('user-select'), 'none', 'обычный движок тоже отключает выделение текста меню');
  assert.match(lastDeclarations('.lb-top').get('height') ?? '', /env\(safe-area-inset-top\)/, 'кнопки просмотрщика начинаются ниже safe area');
});

it('телефонное подтверждение остаётся компактным по центру, а не полноэкранным листом', () => {
  // Более специфичный старый мобильный селектор может вернуть растянутое окно несмотря на новый класс.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const media = clean.slice(clean.lastIndexOf('@media (max-width: 620px) {', clean.indexOf('.modal-overlay.confirm-overlay > .confirm')));
  assert.match(media, /\.modal-overlay\.confirm-overlay\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/);
  assert.equal(lastDeclarations('.modal-overlay.confirm-overlay > .confirm').get('height'), 'auto');
  assert.equal(lastDeclarations('.modal-overlay.confirm-overlay > .confirm').get('border-radius'), 'var(--r-4)');
});

it('переход к цитате подсвечивает весь пузырь отдельным слоем, а не старой анимацией строки', () => {
  // Вспышка старой строки не совпадала с границами новых пузырей и оставляла края без подсветки.
  assert.equal(lastDeclarations('.message.bub.jump-hit').get('animation'), 'none');
  const overlay = lastDeclarations('.message.bub.jump-hit:not(.picked)::before');
  assert.match(overlay.get('background') ?? '', /color-mix\(in srgb, var\(--text\)/);
  assert.equal(overlay.get('pointer-events'), 'none');
  assert.equal(lastDeclarations('.messages .message.bub.jump-hit:not(.picked)::before').get('inset'), '0 calc(-1 * var(--sp-5))');
});

it('размеры ЛС и подвалов остаются в desktop/TG-границах, телефонные фиксы эмулятора не откатываются', () => {
  // Эти размеры влияют на раскладку всего списка и поля: процентный/устаревший размер даёт реальный переполз контента.
  assert.match(css, /--dm-row-h:\s*62px;/);
  assert.match(css, /--bubble-max-w:\s*430px;/);
  assert.equal(lastDeclarations('.dm-row .dm-st.read').get('color'), 'var(--accent)');
  assert.match(lastDeclarations('.call-min').get('top') ?? '', /env\(safe-area-inset-top\)/);
  assert.equal(lastDeclarations('.channels.dm-narrow .self-bar .self-actions').get('flex-direction'), 'column');
  assert.doesNotMatch(lastDeclarations('.channels.dm-narrow .self-bar .self-actions').get('display') ?? '', /none/);
  const { media } = mediaParts();
  const phone = media.filter((m) => m.query === '@media (max-width: 760px)').map((m) => m.body).join('\n');
  assert.equal(declarationsIn(phone, '.settings-modal .seg button').get('white-space'), 'normal');
  assert.equal(lastDeclarations('.ctx-stack > .send-preview').get('width'), 'max-content');
  assert.match(lastDeclarations('.toast-stack').get('bottom') ?? '', /96px.*safe-area-inset-bottom/);
  assert.equal(lastDeclarations('.settings-modal .settings-row:not(.col)').get('margin'), '0 calc(-1 * var(--sp-3))');
  assert.ok(media.some((m) => m.query === '@media (max-width: 760px)' && /\.modal\.rail-modal,[\s\S]*?height:\s*100dvh/.test(m.body)),
    'на телефоне лист настроек растянут по динамической высоте viewport');
  const downloads = readFileSync(new URL('./components/DownloadsList.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(downloads, /isMobile\(\)\s*\?\s*'Файлы, скачанные в этом приложении\./,
    'подпись загрузок описывает приложение телефона, а не браузерную вкладку');
});

describe('раунд 11 — тихое время и список бесед', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Последняя декларация одинакового селектора выигрывает: наличие старой правильной не спасает новую неверную.
  const body = (selector: string) => {
    const declarations = new Map<string,string>();
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim() === selector) {
      for (const d of m[2].split(';')) { const at=d.indexOf(':'); if(at>=0) declarations.set(d.slice(0,at).trim(),d.slice(at+1).trim()); }
    }
    return [...declarations].map(([name,value])=>`${name}: ${value}`).join(';');
  };
  it('мета обеих тем имеет собственные токены, прочитано наследует цвет', () => {
    // Ловит возврат медовых ✓✓ и холодного моноширинного времени.
    for (const [token, values] of [['bubble-in-meta',['#8c8991','#76747c']],['bubble-out-meta',['#a59886','#716453']]] as const) {
      assert.deepEqual([...clean.matchAll(new RegExp(`--${token}:\\s*([^;]+);`,'g'))].map(m=>m[1].trim()), values);
    }
    assert.equal([...clean.matchAll(/--bubble-accent-text:/g)].length,2);
    const meta=body('.message.bub .bub-meta');
    for (const declaration of ['font-family: var(--font-ui)','font-size: 10.5px','font-weight: 500','line-height: normal','color: var(--bubble-in-meta)']) assert.ok(meta.includes(declaration),declaration);
    assert.match(body('.message.bub.mine .bubble .bub-meta'),/color:\s*var\(--bubble-out-meta\)/);
    assert.match(body('.message.bub .bubble .bub-meta.over'),/color:\s*var\(--media-meta-ink\)/);
    assert.match(body('.message.bub .bubble.emoji .bub-meta-row .bub-meta,\n.message.bub .bubble.sticker .bub-meta-row .bub-meta'),/color:\s*var\(--bubble-in-meta\)/);
    assert.match(body('.message.bub .bub-st.failed'),/color:\s*var\(--danger\)/);
    assert.match(body('.message.bub .bub-st.read'),/color:\s*inherit/);
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].includes('.bub-st.read')) assert.doesNotMatch(m[2],/--bubble-accent-text/);
    const icon=body('.message.bub .bub-st .gv-icon'); assert.match(icon,/width:\s*14px/); assert.match(icon,/height:\s*14px/); assert.match(icon,/stroke-width:\s*1\.5/);
  });
  it('телефон не перебивает новые клетки, поле 16px, row-gap стоит после gap', () => {
    // Ловит специфичность старой мобильной разметки и увеличение WebView при фокусе.
    assert.doesNotMatch(clean,/\.app\.m-list\s+\.(?:dm-time|dm-meta|dm-main|dm-badge)\b/);
    assert.match(body('input.sheet-search'),/font-size:\s*16px/);
    const gaps=[...clean.matchAll(/\.app\.m-list \.dm-row\s*\{([^{}]*)\}/g)];
    let rowAt=-1,gapAt=-1;
    gaps.forEach((m,i)=>{ if(/row-gap:\s*var\(--sp-1\)/.test(m[1])) rowAt=i; if(/(?:^|;)\s*gap:/.test(m[1])) gapAt=i; });
    assert.ok(rowAt>gapAt,'row-gap позже ПОСЛЕДНЕГО gap');
    assert.match(body('.set-search kbd'),/white-space:\s*nowrap/);
  });
  it('ошибка не заменяет бейдж, ПК окно не вводит углы и имеет собственный кегль', () => {
    // Ловит прежний ! вместо unread и наследование мобильного листа на ПК.
    assert.doesNotMatch(clean,/\.dm-fail\b|\.dm-row\.failed \.dm-preview/);
    assert.match(body('.dm-row .dm-st.failed'),/color:\s*var\(--danger\)/);
    const modal=body('.modal.dm-compose'); assert.match(modal,/width:\s*min\(440px, calc\(100vw - 32px\)\)/);
    assert.match(modal,/max-height:\s*min\(560px, 85vh\)/); assert.doesNotMatch(modal,/border-radius:/);
    assert.match(body('.dm-compose > input.sheet-search'),/font-size:\s*14px/);
    assert.match(body('.dm-compose-list'),/gap:\s*var\(--sp-1\)/);
  });
});

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
