import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function popupCssFailure(prefix: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix) &&
    error.operator === 'strictEqual' && error.actual === actual && error.expected === expected;
}
function popupReplyCase(raw = css) {
  const declarations = guardDeclarations(guardCssBlocks(raw), '.nfp-reply-btn');
  assert.equal(declarations.size > 0, true, 'R233-reply-rule: кнопка ответа имеет живой CSS');
  assert.equal(declarations.get('text-transform')?.toLowerCase().replace(/\s*!important$/, '') === 'uppercase', false,
    'R233-reply-case: ответ не превращается в обрезанный верхний регистр');
}
it('R233 кнопка ответа уведомления сохраняет обычный регистр русского текста', () => {
  // Happy-dom не рассчитывает uppercase и обрезание: проверяется реальная декларация кнопки.
  popupReplyCase();
});
it('R233 возврат uppercase в кнопке ответа обнаруживается независимо от правильного комментария', () => {
  popupReplyCase();
  const anchor = '.nfp-reply-btn {';
  assert.equal(css.split(anchor).length - 1, 1);
  for (const value of ['uppercase', 'UPPERCASE !important']) {
    popupReplyCase();
    assert.throws(() => popupReplyCase(css.replace(anchor, `${anchor}\n  text-transform: ${value};`) +
      '\n/* .nfp-reply-btn { text-transform: none; } */'), popupCssFailure('R233-reply-case:', true, false));
  }
});
function popupActions(raw = css) {
  const blocks = guardCssBlocks(raw);
  const hidden = guardDeclarations(blocks, '.nfp-actions');
  assert.equal(hidden.get('position'), 'absolute', 'R233-actions-position: действия лежат поверх текста без изменения его ширины');
  assert.equal(hidden.get('opacity'), '0', 'R233-actions-hidden: до наведения текст не закрыт действиями');
  assert.equal(hidden.get('pointer-events'), 'none', 'R233-actions-pass: скрытые действия не перехватывают нажатие карточки');
  for (const selector of ['.nfp-card:hover .nfp-actions', '.nfp-actions:focus-within']) {
    const shown = guardDeclarations(blocks, selector);
    assert.equal(shown.get('opacity'), '1', `R233-actions-visible: ${selector}`);
    assert.equal(shown.get('pointer-events'), 'auto', `R233-actions-clickable: ${selector}`);
  }
}
it('R233 действия скрыты и пропускают нажатие до наведения, при hover и клавиатурном фокусе видны и доступны', () => {
  // Пара скрыто/доступно не позволяет спрятать кнопку навсегда ради свободного превью.
  popupActions();
});
it('R233 контрфакты постоянно видимых невидимо кликабельных и недоступных по hover действий ловятся адресным CSS', () => {
  const blocks = guardCssBlocks(css);
  const base = blocks.filter(block => block.header === '.nfp-actions');
  const hover = blocks.filter(block => splitCss(block.header, ',').includes('.nfp-card:hover .nfp-actions'));
  assert.equal(base.length, 1);
  assert.equal(hover.length, 1);
  const cases = [
    [base[0], 'position', 'static', 'R233-actions-position:', 'absolute'],
    [base[0], 'opacity', '1', 'R233-actions-hidden:', '0'],
    [base[0], 'pointer-events', 'auto', 'R233-actions-pass:', 'none'],
    [hover[0], 'opacity', '0', 'R233-actions-visible: .nfp-card:hover', '1'],
    [hover[0], 'pointer-events', 'none', 'R233-actions-clickable: .nfp-card:hover', 'auto'],
  ] as const;
  for (const [block, property, actual, prefix, expected] of cases) {
    popupActions();
    assert.throws(() => popupActions(mutateGuardDeclaration(block, property, actual)), popupCssFailure(prefix, actual, expected));
  }
});
function popupRootPadding(raw = css) {
  const declarations = guardDeclarations(guardCssBlocks(raw), '.nfp-root');
  assert.equal(declarations.size > 0, true, 'R233-root-rule: корень стопки имеет живой CSS');
  assert.equal([...declarations.keys()].some(property => /^padding(?:-|$)/.test(property)), false,
    'R233-root-padding: отступ от экрана задаёт окно, а не невидимое поле стопки');
}
it('R233 корень стопки уведомлений не добавляет padding к размеру прозрачного окна', () => {
  popupRootPadding();
});
it('R233 скрытые поля корня ловятся и в shorthand и по отдельной стороне включая логическую', () => {
  const anchor = '.nfp-root {';
  assert.equal(css.split(anchor).length - 1, 1);
  for (const property of ['padding', 'padding-top', 'padding-inline-start']) {
    popupRootPadding();
    assert.throws(() => popupRootPadding(css.replace(anchor, `${anchor}\n  ${property}: 7px;`)),
      popupCssFailure('R233-root-padding:', true, false));
  }
});

function dmListTrack(source = css) {
  assert.equal(guardDeclarations(guardCssBlocks(source), '.dm-list').get('grid-template-columns'), 'minmax(0, 1fr)',
    'R230-dm-track: колонка списка допускает сжатие длинных вкладок');
}
it('R230 список бесед сжимает единственную колонку вместо расширения всего экрана вкладками', () => {
  // Happy-dom не меряет grid: проверяем реальное итоговое объявление, а не выдуманные clientWidth.
  dmListTrack();
});
it('R230 контрфакт auto-min колонки списка ловится даже при правильном тексте в комментарии', () => {
  // Возврат неявного минимума раздвигал поиск и строки файлов на телефоне S20.
  dmListTrack();
  const blocks = guardCssBlocks(css).filter(b => b.header === '.dm-list' && guardDeclarations([b], '.dm-list').has('grid-template-columns'));
  assert.equal(blocks.length, 1);
  const changed = mutateGuardDeclaration(blocks[0], 'grid-template-columns', '1fr');
  assert.throws(() => dmListTrack(changed + '\n/* .dm-list { grid-template-columns: minmax(0, 1fr); } */'), e => e instanceof assert.AssertionError
    && e.message.startsWith('R230-dm-track:') && e.operator === 'strictEqual' && e.actual === '1fr' && e.expected === 'minmax(0, 1fr)');
});

it('R200 голосовая панель телефона имеет свой selector в760px и не заимствует зелёный фон звонка ЛС', () => {
  // Класс ошибки: .call-bar делилась двумя разными панелями, из-за чего голосовая сцена окрашивалась в зелёный.
  const check = (raw: string) => {
    const blocks = guardCssBlocks(raw), phone = guardScope(blocks, '@media (max-width: 760px)');
    const rules = phone.filter(b => splitCss(b.header, ',').includes('.voice-call-bar'));
    assert.equal(rules.length, 1, 'голосовая панель находится в телефонном media');
    const declarations = guardDeclarations(phone, '.voice-call-bar');
    assert.equal(declarations.get('display'), 'flex');
    assert.equal(guardDeclarations(blocks, '.voice-call-bar').size, 0, 'мобильный layout не становится глобальным');
    for (const [name, value] of declarations) if (name.startsWith('background')) assert.equal(value.includes('--green'), false, 'голосовая панель не получает зелёный фон');
  };
  check(css); const anchor = '.voice-call-bar {'; assert.equal(css.split(anchor).length - 1, 1);
  assert.throws(() => check(css.replace(anchor, '.call-bar {')), e => e instanceof assert.AssertionError && e.message.includes('находится в телефонном media'));
  assert.throws(() => check(css.replace(anchor, anchor + '\nbackground: var(--green);')), e => e instanceof assert.AssertionError && e.message.includes('не получает зелёный фон'));
});

it('R194 индикатор copying использует общую останавливаемую крутилку без пятнадцатой вечной анимации', () => {
  // Класс ошибки: новая заглушка постоянно будит GPU поверх игровых и лёгких режимов.
  const check = (source: string) => {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((clean.match(/animation\s*:[^;{}]*\binfinite\b/g) ?? []).length, 14, 'всего четырнадцать вечных анимаций');
    const spin = guardDeclarations(guardCssBlocks(clean), '.confirm-spin.att-spin');
    assert.equal(spin.get('border-right-color'), 'transparent');
    for (const prefix of ['html.gv-game-fg', 'html.gv-lite']) assert.equal(clean.includes(`${prefix} .confirm-spin`), true);
  };
  check(css); const anchor = '.confirm-spin.att-spin {\n'; assert.equal(css.split(anchor).length - 1, 1, 'единственный selector крутилки');
  assert.throws(() => check(css.replace(anchor, `${anchor}  animation: extra-spin 1s linear infinite;\n`)),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('всего четырнадцать вечных анимаций'));
});

describe('R183 вложения поиска не раздвигают ленту', () => {
  it('список вкладки вида допускает сжатие до ширины ленты, возврат auto обнаруживается', () => {
    // Длинная ссылка не должна превратить grid-ячейку списка в полосу 1207 px; layout happy-dom не измеряется.
    const selector = '.dms-kind-hits';
    const check = (raw = css) => assert.equal(guardDeclarations(guardCssBlocks(raw), selector).get('min-width'), '0', 'min-width найденных вложений 0');
    check(); const block = guardCssBlocks(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'min-width', 'auto')), e => e instanceof assert.AssertionError && e.message.includes('найденных вложений'));
  });
  it('вкладки видов листаются вбок вместо сжатия или обрезания, числовая подмена обнаруживается', () => {
    // Последние виды должны оставаться доступными на узком телефоне.
    const selector = '.dms-scopes.dms-kinds';
    const check = (raw = css) => assert.equal(guardDeclarations(guardCssBlocks(raw), selector).get('overflow-x'), 'auto', 'вкладки листаются вбок');
    check(); const block = guardCssBlocks(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'overflow-x', 'hidden')), e => e instanceof assert.AssertionError && e.message.includes('листаются вбок'));
  });
});

describe('R179 затенение ленты под телефонной капсулой', () => {
  const selector = '.app.m-dmlist:not(.in-voice) .mobile-nav::before';
  const media = '@media (max-width: 760px)';
  const gradient = 'linear-gradient(to bottom, color-mix(in srgb, var(--bg-2) 0%, transparent) 0, color-mix(in srgb, var(--bg-2) 34%, transparent) 20px, color-mix(in srgb, var(--bg-2) 62%, transparent) 40px, color-mix(in srgb, var(--bg-2) 81%, transparent) 60px, color-mix(in srgb, var(--bg-2) 81%, transparent) 100%)';
  const value = (raw: string) => {
    const blocks = guardCssBlocks(raw), phone = guardScope(blocks, media);
    assert.equal(guardDeclarations(blocks, selector).size, 0, 'затенение не становится глобальным правилом ПК');
    const rule = phone.filter(b => b.header === selector);
    assert.equal(rule.length, 1, 'один телефонный слой ленты вне голоса');
    return { block: rule[0], declarations: guardDeclarations(phone, selector) };
  };
  const check = (raw = css) => {
    const { declarations: d } = value(raw);
    assert.equal(d.get('pointer-events'), 'none', 'затенение пропускает касания');
    assert.equal(d.get('z-index'), '-1', 'затенение лежит за капсулой');
    assert.equal(d.get('background')?.replace(/\s+/g, ''), gradient.replace(/\s+/g, ''), 'градиент цвета ленты сохраняет остановки и альфу 0.81 до низа');
  };
  it('слой существует только у ленты вне голоса на телефоне, лежит за капсулой и не ловит касания', () => {
    // Глобальное правило или слой над капсулой меняет другие экраны и блокирует её кнопки.
    check(); const { declarations: d } = value(css);
    for (const [property, expected] of [['content', "''"], ['position', 'absolute'], ['left', '0'], ['right', '0'], ['bottom', '0'], ['height', 'var(--m-nav-h)']])
      assert.equal(d.get(property), expected, property);
    const phone = guardScope(guardCssBlocks(css), media);
    assert.equal(guardDeclarations(phone, '.app.m-dmlist .mobile-nav::before').size, 0, 'голос не получает соседнее безусловное правило');
  });
  it('первые 60 px плавно переходят от прозрачного к 0.81 цвета bg-2, остаток сохраняет 0.81', () => {
    // Нельзя подменить плавный переход непрозрачной плашкой или фоном другого экрана.
    check(); const background = value(css).declarations.get('background')!;
    const stops = [...background.matchAll(/var\(--bg-2\) (\d+)%, transparent\) (\d+(?:px|%)?)/g)].map(m => [Number(m[1]) / 100, m[2]]);
    assert.deepEqual(stops, [[0, '0'], [.34, '20px'], [.62, '40px'], [.81, '60px'], [.81, '100%']]);
  });
  it('контрфакты голоса перехвата касаний верхнего слоя и полной непрозрачности обнаруживаются адресным CSS', () => {
    // Все четыре контрфакта меняют настоящее правило, а не отдельную строку с ожидаемым ответом.
    check(); const { block } = value(css); const anchor = `${selector} {`;
    assert.equal(css.split(anchor).length - 1, 1, 'уникальный якорь селектора');
    assert.throws(() => check(css.replace(anchor, '.app.m-dmlist .mobile-nav::before {')),
      e => e instanceof assert.AssertionError && e.message.includes('один телефонный слой'));
    for (const [property, replacement, message] of [
      ['pointer-events', 'auto', 'пропускает касания'], ['z-index', '1', 'за капсулой'],
      ['background', gradient.replaceAll('81%', '100%'), 'альфу 0.81'],
    ]) assert.throws(() => check(mutateGuardDeclaration(block, property, replacement)),
      e => e instanceof assert.AssertionError && e.message.includes(message));
  });
});

describe('R181 телефонная шапка и архив', () => {
  const phone = (raw: string) => guardScope(guardCssBlocks(raw), '@media (max-width: 760px)');
  it('имя собеседника 18 medium не наследует прежние 800, обе числовые подмены обнаруживаются', () => {
    // Ширина имени влияет на доступность статуса; проверяется нужный телефонный блок, не глобальная похожая строка.
    const selector = '.app.m-content .dm-who > strong';
    const check = (raw = css) => {
      const d = guardDeclarations(phone(raw), selector);
      assert.equal(d.get('font-size'), '18px', 'телефонное имя 18');
      assert.equal(d.get('font-weight'), '500', 'телефонное имя medium 500');
    };
    check(); const block = phone(css).find(b => b.header === selector); assert.ok(block);
    for (const [prop, value, target] of [['font-weight', '800', 'medium 500'], ['font-size', '20px', 'имя 18']])
      assert.throws(() => check(mutateGuardDeclaration(block, prop, value)), e => e instanceof assert.AssertionError && e.message.includes(target));
  });
  it('шапка без участников оставляет поля 58 и 6 с безопасными вставками и промежуток 6', () => {
    // Лишние 64/16 обрезали статус; поле для кнопки участников менять этим правилом нельзя.
    const selector = '.app.m-content:not(.has-members) .chat > .chat-top > .channel-topbar';
    const check = (raw = css) => {
      const d = guardDeclarations(phone(raw), selector);
      assert.equal(d.get('padding-left'), 'calc(58px + var(--sa-l, 0px))', 'поле слева 58 с native-safe вставкой');
      assert.equal(d.get('padding-right'), 'calc(6px + var(--sa-r, 0px))', 'поле справа 6 с native-safe вставкой');
      assert.equal(d.get('column-gap'), '6px', 'промежуток пилюль 6');
      assert.equal(guardDeclarations(guardCssBlocks(raw), selector).size, 0, 'узкое правило не стало общим для ПК');
    };
    check(); const block = phone(css).find(b => b.header === selector); assert.ok(block);
    for (const [prop, bad, target] of [['padding-left', 'calc(64px + var(--sa-l, 0px))', 'поле слева 58'], ['padding-right', 'calc(16px + var(--sa-r, 0px))', 'поле справа 6']])
      assert.throws(() => check(mutateGuardDeclaration(block, prop, bad)), e => e instanceof assert.AssertionError && e.message.includes(target));
  });
  it('архив прячет капсулу только при gv-listarchive на экране списка, возврат селектора обнаруживается', () => {
    // Архив не должен показывать нижние вкладки поверх своего списка, остальные экраны сохраняют навигацию.
    const selector = ':root.gv-listarchive .app.m-list .mobile-nav';
    const check = (raw = css) => assert.equal(guardDeclarations(phone(raw), selector).get('display'), 'none', 'капсула скрыта в архиве');
    check(); const block = phone(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'display', 'flex')), e => e instanceof assert.AssertionError && e.message.includes('капсула скрыта'));
  });
});

describe('R163–R164 сцена без случайного переноса и невидимых кнопок', () => {
  it('сетка задаёт колонки явно, резервирует полосу и безопасно центрирует ряды', () => {
    const check = (source: string) => {
      const d = guardDeclarations(guardCssBlocks(source), '.stage-grid');
      assert.equal(d.get('display'), 'grid');
      assert.equal(d.get('grid-template-columns'), 'repeat(var(--tile-cols, 1), var(--tile-w, 156px))');
      assert.equal(d.get('grid-auto-rows'), 'var(--tile-h, var(--stage-tile-h))');
      assert.equal(d.get('align-content'), 'safe center');
      assert.equal(d.get('scrollbar-gutter'), 'stable');
      assert.equal(d.has('flex-wrap'), false);
    };
    check(css);
    const block = guardCssBlocks(css).find(b => b.header === '.stage-grid'); assert.ok(block);
    for (const [prop, bad] of [['display', 'flex'], ['grid-template-columns', 'none'], ['scrollbar-gutter', 'auto']])
      assert.throws(() => check(mutateGuardDeclaration(block, prop, bad)), assert.AssertionError);
  });
  it('кнопки зрителя не занимают места скрытыми, ряд не переносится и сохраняет высоту', () => {
    const d = guardDeclarations(guardCssBlocks(css), '.screen-controls');
    assert.equal(d.get('flex-wrap'), 'nowrap');
    assert.equal(d.get('min-height'), 'calc(38px + 2 * var(--sp-3))');
    assert.equal(guardDeclarations(guardCssBlocks(css), '.screen-controls > :not(.screen-title)').get('display'), 'none');
    for (const prefix of ['.screen-viewer:focus-within', '.screen-viewer.ctl-on'])
      assert.equal(guardDeclarations(guardCssBlocks(css), `${prefix} .screen-controls > :not(.screen-title, .screen-spacer)`).get('display'), 'inline-flex');
  });
  it('hover зрителя раскрывает кнопки только на устройстве с наведением, телефон не прячет ползунок', () => {
    const blocks = guardCssBlocks(css);
    const selector = '.screen-viewer:hover .screen-controls > :not(.screen-title, .screen-spacer)';
    assert.equal(guardDeclarations(blocks, selector).size, 0);
    assert.equal(guardDeclarations(guardScope(blocks, '@media (hover: hover)'), selector).get('display'), 'inline-flex');
    const visit = (items: GuardCssBlock[]) => {
      for (const block of items) {
        if (!block.header.startsWith('@') && block.header.includes('.screen-controls .stream-vol'))
          assert.notEqual(guardDeclarations([block], block.header).get('display'), 'none', 'мобильный ползунок не прячется');
        visit(block.children);
      }
    };
    visit(blocks);
  });
});

describe('R161 выпадающее меню раскрывается от кнопки и уважает меньше движения', () => {
  it('карточка и пункты имеют отдельные анимации с задержками из DOM', () => {
    // Наличие keyframes без привязки к drop не даёт нужного раскрытия карточки.
    const check = (source: string) => {
      const blocks = guardCssBlocks(source);
      const card = guardDeclarations(blocks, '.ctx-stack.drop > .ctx-menu');
      assert.equal(card.get('transform-origin'), 'top right');
      assert.equal(card.get('animation'), 'ctxDropIn var(--drop-ms, 230ms) ease-in-out both');
      assert.equal(guardDeclarations(blocks, '.ctx-stack.drop > .ctx-menu > *').get('animation'), 'ctxDropItem 180ms ease-out var(--drop-at, 0ms) both');
      const keyframes = blocks.find(b => b.header === '@keyframes ctxDropIn'); assert.ok(keyframes);
      assert.equal(guardDeclarations(keyframes.children, 'from').get('clip-path'), 'inset(0 0 100% 0)');
      assert.equal(guardDeclarations(keyframes.children, 'to').get('opacity'), '1');
    };
    check(css);
    const block = guardCssBlocks(css).find(b => b.header === '.ctx-stack.drop > .ctx-menu'); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'animation', 'none')), assert.AssertionError);
  });
  it('reduced-motion гасит и карточку drop и её пункты с нужной специфичностью', () => {
    const check = (source: string) => {
      const blocks = guardScope(guardCssBlocks(source), '@media (prefers-reduced-motion: reduce)');
      for (const selector of ['.ctx-stack.drop > .ctx-menu', '.ctx-stack.drop > .ctx-menu > *'])
        assert.equal(guardDeclarations(blocks, selector).get('animation'), 'none', selector);
    };
    check(css);
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const reduced = guardCssBlocks(css).find(b => b.header === '@media (prefers-reduced-motion: reduce)' && b.body.includes('.ctx-stack.drop')); assert.ok(reduced);
    for (const selector of ['.ctx-stack.drop > .ctx-menu,', '.ctx-stack.drop > .ctx-menu > *,']) {
      assert.equal(reduced.body.split(selector).length - 1, 1);
      assert.throws(() => check(clean.replace(reduced.body, reduced.body.replace(selector, ''))), assert.AssertionError);
    }
  });
});

describe('R158 низ поля не считает системную вставку дважды', () => {
  const phone = (source: string) => guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
  const composer = '.app.m-content .composer:not(.sel-bar)';
  it('поле имеет нижний отступ ровно 9, без повторной safe area', () => {
    // Иначе клавиатура отодвигается на вторую высоту системной панели.
    const check = (source: string) => {
      const values = guardDeclarations(phone(source), composer);
      assert.equal(values.get('margin'), '6px 12px 9px');
      assert.equal(values.get('padding'), '0');
      assert.doesNotMatch(values.get('margin') ?? '', /safe-area|--gv-sab/);
    };
    check(css);
    const block = phone(css).find(b => guardDeclarations([b], composer).has('margin')); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'margin', '6px 12px calc(8px + max(env(safe-area-inset-bottom), var(--gv-sab, 0px)))')), assert.AssertionError);
  });
  it('системную нижнюю вставку сохраняет обёртка беседы, не само поле', () => {
    const check = (source: string) => assert.equal(guardDeclarations(phone(source), '.app.m-chat').get('padding-bottom'), 'max(env(safe-area-inset-bottom), var(--gv-sab, 0px))');
    check(css);
    const block = phone(css).find(b => guardDeclarations([b], '.app.m-chat').has('padding-bottom')); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'padding-bottom', '0')), assert.AssertionError);
  });
});

describe('R170 капсула навигации, поиск с лентой и разрыв меню', () => {
  const phone = (raw: string) => guardScope(guardCssBlocks(raw), '@media (max-width: 760px)');
  const scope = (raw: string, fallback = false) => fallback ? guardScope(phone(raw), '@supports not (backdrop-filter: blur(1px))') : phone(raw);
  function pair(selector: string, property: string, expected: string, bad: string, fallback = false) {
    const check = (raw: string) => assert.equal(guardDeclarations(scope(raw, fallback), selector).get(property), expected, `${selector}: ${property}`);
    check(css);
    const block = scope(css, fallback).filter(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has(property)).at(-1);
    assert.ok(block, `${selector}: ${property}`);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
  it('плавающая капсула 56 на 328 имеет поля, пилюлю и оба свойства размытия', () => {
    // Полноширинный фон вместо отдельной капсулы перекрывал бы ленту по краям.
    for (const [prop, value, bad] of [['height', '56px', '58px'], ['max-width', '328px', '100%'],
      ['border-radius', 'var(--r-pill)', '10px'], ['margin', '0 var(--sp-3)', '0'],
      ['padding', 'var(--sp-2)', '0'], ['background', 'var(--glass-bg)', 'var(--bg)'],
      ['backdrop-filter', 'var(--glass-blur)', 'none'], ['-webkit-backdrop-filter', 'var(--glass-blur)', 'none']])
      pair('.mnav-capsule', prop, value, bad);
  });
  it('касания вокруг капсулы проходят к списку, сама капсула нажимается и учитывает вставки', () => {
    // pointer-events на всей полосе оставляли бы невидимую преграду поверх последних строк.
    pair('.mobile-nav', 'pointer-events', 'none', 'auto'); pair('.mnav-capsule', 'pointer-events', 'auto', 'none');
    pair('.mobile-nav', 'padding-bottom', 'calc(var(--sp-3) + max(env(safe-area-inset-bottom), var(--gv-sab, 0px)))', 'var(--sp-3)');
    pair('.mobile-nav', 'padding-left', 'var(--sa-l)', '0'); pair('.mobile-nav', 'padding-right', 'var(--sa-r)', '0');
    pair(':root', '--m-nav-h', 'calc(72px + max(env(safe-area-inset-bottom), var(--gv-sab, 0px)))', '58px');
  });
  it('стекло принадлежит навигации и имеет светлую обводку, fallback и экономный режим', () => {
    // Наследование только от беседы потеряло бы стекло на экране списка и профиля.
    pair('.mobile-nav', '--glass-bg', 'color-mix(in srgb, var(--bg-3) 76%, transparent)', 'var(--bg-3)');
    pair('.mobile-nav', '--glass-blur', 'blur(24px) saturate(3)', 'none');
    pair('.mobile-nav', '--sh-glass', 'inset 0 0.55px 0 rgba(255, 255, 255, 0.125), inset 0 -0.55px 0 rgba(255, 255, 255, 0.08)', 'none');
    pair(':root[data-theme=\'light\'] .mobile-nav', '--sh-glass', 'inset 0 0.55px 0 #fff, inset 0 -0.55px 0 #fff, 0 0 1px rgba(0, 0, 0, 0.125)', 'none');
    for (const fallback of [false, true]) {
      const selector = fallback ? '.mobile-nav' : 'html.gv-lite .mobile-nav';
      pair(selector, '--glass-bg', 'var(--bg-3)', 'transparent', fallback);
      pair(selector, '--glass-blur', 'none', 'blur(24px)', fallback);
    }
  });
  it('список ЛС идёт под капсулой, запас прокрутки остаётся внутри списка, поиск скрывает капсулу', () => {
    // Отступ одновременно на app и на ленте забирает лишнюю высоту; без отступа ленты последняя строка недоступна.
    pair('.app.m-dmlist:not(.in-voice)', 'padding-bottom', '0', 'var(--m-nav-h)');
    pair('.app.m-dmlist:not(.in-voice) .channels > .dm-list', 'padding-bottom', 'calc(var(--m-nav-h) + 88px)', '88px');
    pair('.app.m-dmlist:not(.in-voice) .channels > .dm-list', 'scroll-padding-bottom', 'var(--m-nav-h)', '0');
    pair(':root.gv-listsearch .app.m-list .mobile-nav', 'display', 'none', 'flex');
  });
  it('активное поле поиска липнет сверху, выбор скрывает поле с сохранением места', () => {
    // Поле должно уезжать с лентой обычно и оставаться видимым только во время ввода.
    pair('.dm-find-zone', 'opacity', 'var(--find-a, 1)', '1');
    for (const [prop, value, bad] of [['position', 'sticky', 'static'], ['top', '0', '8px'],
      ['opacity', '1', '0'], ['background', 'var(--bg-2)', 'transparent']]) pair('.dm-find-zone.on', prop, value, bad);
    pair('.dm-find-zone.pick', 'visibility', 'hidden', 'visible');
    assert.notEqual(guardDeclarations(phone(css), '.dm-find-zone.pick').get('display'), 'none', 'скрытие не схлопывает место и scrollTop');
  });
  it('значок поиска не увеличивает шапку, поле сохраняет высоту 48', () => {
    // Без отрицательных полей кнопка увеличивает шапку ровно в момент исчезновения поля и дёргает список.
    pair('.app.m-list .dm-list-head .dm-find-btn', 'margin-block', '-12px', '0');
    pair('.app.m-list .dm-find .sheet-search', 'height', '48px', '56px');
    pair('.app.m-list .dm-find .dm-find-clear', 'height', '46px', '48px');
  });
  it('разрыв групп выпадающего меню на телефоне имеет высоту 8 и фон окна', () => {
    // Тонкая линия из меню ПК не соответствует отдельной группе действий телефона.
    const selector = '.ctx-stack.drop > .ctx-menu > .ctx-divider';
    pair(selector, 'height', '8px', '1px'); pair(selector, 'background', 'var(--bg)', 'var(--border)');
    pair(selector, 'margin', '0 calc(-1 * var(--sp-2))', '0');
  });
  it('размеры капсулы, скрытие навигации поиском и sticky поиска ограничены телефоном', () => {
    // Наличие корректного media не спасает от утечки такого же правила в десктопную область.
    const check = (raw: string) => {
      const global = guardCssBlocks(raw);
      assert.equal(guardDeclarations(global, '.mnav-capsule').has('height'), false);
      assert.equal(guardDeclarations(global, ':root.gv-listsearch .app.m-list .mobile-nav').has('display'), false);
      assert.equal(guardDeclarations(global, '.dm-find-zone.on').has('position'), false);
    };
    check(css);
    for (const declaration of ['.mnav-capsule { height: 56px; }', ':root.gv-listsearch .app.m-list .mobile-nav { display: none; }', '.dm-find-zone.on { position: sticky; }'])
      assert.throws(() => check(css + '\n' + declaration), assert.AssertionError);
  });
});

describe('R169 телефонные размеры Telegram и плоские настройки', () => {
  const phone = (raw: string) => guardScope(guardCssBlocks(raw), '@media (max-width: 760px)');
  function pair(selector: string, property: string, expected: string, bad: string, mobile = true) {
    const blocks = (raw: string) => mobile ? phone(raw) : guardCssBlocks(raw);
    const check = (raw: string) => assert.equal(guardDeclarations(blocks(raw), selector).get(property), expected, `${selector}: ${property}`);
    check(css);
    const block = blocks(css).filter(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has(property)).at(-1);
    assert.ok(block, `${selector}: ${property}`);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
  it('плавающая Далее имеет круг 48 и липкий сторож нулевой высоты', () => {
    // Высота сторожа или pointer-events на нём перекрыли бы последнего участника списка.
    for (const [prop, value, bad] of [['width', '48px', '56px'], ['height', '48px', '56px'],
      ['border-radius', 'var(--r-circle)', '10px'], ['pointer-events', 'auto', 'none']]) pair('.group-fab', prop, value, bad, false);
    for (const [prop, value, bad] of [['position', 'sticky', 'static'], ['height', '0', '48px'],
      ['bottom', '-8px', '0'], ['margin-top', '56px', '0'], ['pointer-events', 'none', 'auto']]) pair('.group-fab-dock', prop, value, bad, false);
  });
  it('телефонный звонок сохраняет контейнер 204, имя 28 и внутренний аватар 135 против 96 на ПК', () => {
    // Контейнер пульса и сама картинка — разные размеры; проверка только одного не ловит рассинхронизацию.
    for (const prop of ['width', 'height']) pair('.call-scrim.phone .call-ava', prop, '204px', '200px', false);
    pair('.call-scrim.phone .call-name', 'font-size', '28px', '24px', false);
    const raw = readFileSync(new URL('./components/CallLayer.tsx', import.meta.url), 'utf8');
    const check = (text: string) => {
      const ast = ts.createSourceFile('CallLayer.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let size: string | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'Avatar') {
          const attr = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'size');
          if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) size = attr.initializer.expression?.getText(ast);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast); assert.equal(size, 'phone ? 135 : 96');
    };
    check(raw); const anchor = 'size={phone ? 135 : 96}'; assert.equal(raw.split(anchor).length - 1, 1);
    assert.throws(() => check(raw.replace(anchor, 'size={96}')), assert.AssertionError);
  });
  it('точка онлайна телефона 10 смещена внутрь аватара на 1 справа и 3 снизу', () => {
    // Правильный диаметр при старой позиции всё равно рисует точку за краем аватара.
    pair('.app.m-list .dm-row .mp-dot-wrap', 'right', '1px', '-1px');
    pair('.app.m-list .dm-row .mp-dot-wrap', 'bottom', '3px', '-1px');
    const raw = readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8');
    const check = (text: string) => {
      const ast = ts.createSourceFile('DmSidebar.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let diameter: string | undefined; let binding = false;
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'DM_ONLINE_DOT_PHONE') diameter = node.initializer?.getText(ast);
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'StatusDot') {
          const size = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'size');
          if (size && ts.isJsxAttribute(size) && size.initializer?.getText(ast) === '{phone ? DM_ONLINE_DOT_PHONE : 12}') binding = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(ast); assert.equal(diameter, '10'); assert.equal(binding, true);
    };
    check(raw); const anchor = 'const DM_ONLINE_DOT_PHONE = 10;'; assert.equal(raw.split(anchor).length - 1, 1);
    assert.throws(() => check(raw.replace(anchor, 'const DM_ONLINE_DOT_PHONE = 12;')), assert.AssertionError);
  });
  it('волна телефона имеет столбик 2 и зазор 1 без второго gap', () => {
    // Одновременные gap и margin увеличат шаг и неверно заполнят измеренную ширину.
    pair('.message.bub .voice-wave.tg-bars', 'gap', '0', '1px', false);
    for (const prop of ['width', 'min-width']) pair('.message.bub .voice-wave.tg-bars .voice-bar', prop, '2px', '3px', false);
    pair('.message.bub .voice-wave.tg-bars .voice-bar', 'margin-right', '1px', '0', false);
  });
  it('R176 лёгкий круг записи 82 сохраняет громкость, живые волны принадлежат холсту 272', () => {
    // Страж арифметики CSS не опирается на неполный layout HappyDOM.
    const circle = '.app.m-content .composer .rec-circle';
    for (const prop of ['width', 'height']) pair(circle, prop, '82px', '80px');
    pair(circle, 'margin', '-41px 0 0 -41px', '-40px 0 0 -40px');
    pair(circle, 'transform', 'scale(calc(1 + 0.7317 * var(--lvl, 0)))', 'scale(1.35)');
    const canvas = '.app.m-content .composer .rec-blob';
    for (const prop of ['width', 'height']) pair(canvas, prop, '272px', '270px');
    pair(canvas, 'margin', '-136px 0 0 -136px', '-135px 0 0 -135px');
    pair(canvas, 'pointer-events', 'none', 'auto');
    pair('.app.m-content .composer .rec-circle.static', 'transform', 'none', 'scale(1.35)');
    pair('.app.m-content .composer .rec-circle.static', 'transition', 'none', 'transform 90ms linear');
    assert.equal(guardDeclarations(phone(css), '.app.m-content .mic-btn .rec-circle::before').size, 0);
    assert.equal(guardDeclarations(phone(css), '.app.m-content .mic-btn .rec-circle::after').size, 0);
    assert.equal(guardCssBlocks(css).flatMap(b => b.children).some(b => b.header.includes('.rec-lock-hint')), false);
  });
  it('настройки и профиль телефона имеют плоские строки 50 с подписью 16 обычного веса', () => {
    // Возврат gap20/углов10 выглядит другой карточкой и сдвигает текст относительно Telegram TextCell.
    for (const selector of ['.set-rail-item', '.prof-row']) {
      for (const [prop, value, bad] of [['height', '50px', '48px'], ['font-size', '16px', '14px'],
        ['font-weight', '400', '600'], ['padding', '0 16px', '0 20px'], ['gap', 'var(--sp-4)', '20px'], ['border-radius', '0', '10px']]) pair(selector, prop, value, bad);
    }
    pair('.set-rail-item::after', 'left', '58px', '50px');
    pair('.prof-row:not(:last-child)::after', 'left', '58px', '50px');
  });
  it('последний раздел телефона не подсвечен active, настольное выделение остаётся', () => {
    // Отмена active нужна только телефону: глобальный сброс сломает навигацию ПК.
    for (const selector of ['.set-rail-item.active', '.set-rail-item:hover']) {
      pair(selector, 'background', 'none', 'var(--accent)'); pair(selector, 'font-weight', '400', '600');
    }
    const desktop = guardDeclarations(guardCssBlocks(css), '.set-rail-item.active');
    assert.notEqual(desktop.get('background'), 'none'); assert.ok(desktop.has('background'));
  });
  it('якоря разделов скрыты только в media телефона, не из списка ПК', () => {
    // Безусловный display:none удалит второй уровень навигации на компьютере.
    pair('.set-rail-anchors', 'display', 'none', 'flex');
    assert.notEqual(guardDeclarations(guardCssBlocks(css), '.set-rail-anchors').get('display'), 'none');
    const check = (raw: string) => {
      const visit = (blocks: GuardCssBlock[], scopes: string[] = []) => {
        for (const block of blocks) {
          if (guardDeclarations([block], '.set-rail-anchors').get('display') === 'none')
            assert.ok(scopes.includes('@media (max-width: 760px)'), 'скрытие якорей ограничено телефоном');
          visit(block.children, [...scopes, block.header]);
        }
      };
      visit(guardCssBlocks(raw));
    };
    check(css); assert.throws(() => check(css + '\n.set-rail-anchors { display: none; }'), assert.AssertionError);
  });
  it('превью тем больше не содержит боковую колонку настольного окна', () => {
    // Боковая колонка в телефонной карточке делает превью нечитаемым при той же ширине.
    const check = (raw: string) => {
      const visit = (blocks: GuardCssBlock[]) => {
        for (const block of blocks) { assert.doesNotMatch(block.header, /\.tc-side\b/); visit(block.children); }
      };
      visit(guardCssBlocks(raw));
    };
    check(css); assert.throws(() => check(css + '\n.tc-side { width: 20px; }'), assert.AssertionError);
  });
});

describe('R157 телефонные размеры Telegram не меняют ПК', () => {
  const phone = (source: string) => guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
  const pair = (selector: string, property: string, expected: string, bad: string, mobile = true) => {
    const blocks = (source: string) => mobile ? phone(source) : guardCssBlocks(source);
    const check = (source: string) => assert.equal(guardDeclarations(blocks(source), selector).get(property), expected, `${selector}: ${property}`);
    check(css);
    const block = blocks(css).filter(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has(property)).at(-1);
    assert.ok(block, `${selector}: ${property}`);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  };

  it('строка телефона высотой 70 идёт от края до края с полями 11/15 и зазором 13, ПК сохраняет 62', () => {
    pair('.app.m-list .dm-row', 'height', '70px', '68px');
    pair('.app.m-list .dm-row', 'height', '70px', '48px');
    const row = '.app.m-list .dm-list > .dm-row';
    for (const [property, value, bad] of [
      ['width', 'calc(100% + 2 * var(--sp-4))', '100%'],
      ['margin', '0 calc(-1 * var(--sp-4))', '0'],
      ['padding', '0 15px 0 11px', '0 12px'],
      ['column-gap', '13px', '12px'], ['border-radius', '0', 'var(--r-3)'],
    ]) pair(row, property, value, bad);
    pair(':root', '--dm-row-h', '62px', '70px', false);
    pair('.dm-row', 'height', 'var(--dm-row-h)', '70px', false);
    pair('.dm-row', 'width', '100%', 'calc(100% + 2 * var(--sp-4))', false);
    pair('.dm-row', 'padding', 'var(--sp-3)', '0 15px 0 11px', false);
  });

  it('имя 16/500, превью 15/400 и время 12/400 ограничены телефонным списком', () => {
    for (const [part, size, weight] of [['dm-name', '16px', '500'], ['dm-preview', '15px', '400'], ['dm-when', '12px', '400']]) {
      const selector = `.app.m-list .dm-row .${part}`;
      pair(selector, 'font-size', size, '14px');
      pair(selector, 'font-weight', weight, '600');
      // Перенос правильных чисел в общий селектор всё равно ломает контракт телефона/ПК.
      const check = (source: string) => assert.equal(guardDeclarations(phone(source), selector).get('font-size'), size);
      const mutant = css.replaceAll(`${selector} {`, `.dm-row .${part} {`);
      assert.notEqual(mutant, css); assert.throws(() => check(mutant), assert.AssertionError);
    }
  });

  it('счётчик строки — пилюля 21 с текстом 13/500, точка непрочитанного остаётся 10', () => {
    const selector = '.app.m-list .dm-row .dm-badge';
    for (const [property, value, bad] of [['min-width', '21px', '20px'], ['height', '21px', '20px'],
      ['font-size', '13px', '12px'], ['font-weight', '500', '600'], ['border-radius', 'var(--r-pill)', '0'],
      ['line-height', '21px', '20px'], ['padding', '0 6px', '0']]) pair(selector, property, value, bad);
    for (const property of ['width', 'height']) {
      pair(`${selector}.dot`, property, '10px', '21px');
    }
  });

  it('вкладка сообщений даёт акцентную пилюлю 16 с текстом 10/500 вместо точки 8', () => {
    for (const [property, value, bad] of [['height', '16px', '8px'], ['font-size', '10px', '0'],
      ['font-weight', '500', '600'], ['background', 'var(--accent)', 'var(--muted)'],
      ['border-radius', 'var(--r-pill)', '0'], ['line-height', '16px', '8px']]) pair('.mnav-badge', property, value, bad);
    assert.equal(guardDeclarations(guardCssBlocks(css), '.mnav-badge').size, 0, 'бейдж живёт внутри телефонного media');
  });

  it('радиусы пузыря 17/6 и время 12 только на телефоне, база остаётся 15/5 и 10,5', () => {
    for (const [property, phoneValue, baseValue] of [['--r-bubble', '17px', '15px'], ['--r-bubble-near', '6px', '5px']]) {
      pair('.app.m-content', property, phoneValue, baseValue);
      pair(':root', property, baseValue, phoneValue, false);
      const check = (source: string) => assert.equal(guardDeclarations(phone(source), '.app.m-content').get(property), phoneValue);
      const block = phone(css).find(b => guardDeclarations([b], '.app.m-content').has(property)); assert.ok(block);
      const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const without = block.body.replace(new RegExp(`${property}:\\s*[^;]+;`), '');
      assert.notEqual(without, block.body);
      const mutant = clean.replace(block.body, without); assert.notEqual(mutant, clean);
      assert.throws(() => check(mutant), assert.AssertionError);
    }
    pair('.app.m-content .message.bub .bub-meta', 'font-size', '12px', '10.5px');
    pair('.message.bub .bub-meta', 'font-size', '10.5px', '12px', false);
  });

  it('только закреплённое меню телефона имеет строки 48 и шрифт 16/400', () => {
    for (const [property, value, bad] of [['min-height', '48px', '44px'], ['font-size', '16px', '15px'],
      ['font-weight', '400', '600']]) pair('.ctx-menu.anchored .ctx-item', property, value, bad);
    const check = (source: string) => assert.equal(guardDeclarations(phone(source), '.ctx-menu.anchored .ctx-item').get('min-height'), '48px');
    const mutant = css.replaceAll('.ctx-menu.anchored .ctx-item {', '.ctx-menu .ctx-item {');
    assert.notEqual(mutant, css); assert.throws(() => check(mutant), assert.AssertionError);
    assert.notEqual(guardDeclarations(guardCssBlocks(css), '.ctx-menu.anchored .ctx-item').get('min-height'), '48px');
  });

  it('ответ имеет две строки по 18 в высоте 48, превью ссылки без подписи остаётся прежним', () => {
    const selector = '.app.m-content .reply-strip:has(> .rs-label)';
    for (const [property, value, bad] of [['min-height', '48px', '36px'], ['line-height', '18px', '16px'],
      ['display', 'grid', 'flex'], ['grid-template-rows', '18px 18px', 'auto'],
      ['padding', '6px var(--sp-4)', '0']]) pair(selector, property, value, bad);
    pair(`${selector} > .rs-label`, 'grid-row', '1', '2');
    pair(`${selector} > .rs-text`, 'grid-row', '2', '1');
    pair(`${selector} > .rs-thumb`, 'height', '34px', '18px');
    pair(`${selector} > .rs-close`, 'grid-row', '1 / span 2', '1');
    pair('.reply-strip', 'display', 'flex', 'grid', false);
    const check = (source: string) => {
      const blocks = phone(source);
      assert.equal(guardDeclarations(blocks, selector).get('min-height'), '48px');
      assert.equal(guardDeclarations(blocks, '.app.m-content .reply-strip').has('grid-template-rows'), false, 'без подписи не навязываем две строки');
      assert.equal(guardDeclarations(blocks, '.app.m-content .reply-strip.link-strip').has('grid-template-rows'), false, 'ссылка не получает сетку ответа');
    };
    check(css);
    const mutant = css.replace(`${selector} {`, '.app.m-content .reply-strip {');
    assert.notEqual(mutant, css); assert.throws(() => check(mutant), assert.AssertionError);
  });

  it('общие медиа убирают обе полосы WebView, общий скроллбар ПК остаётся 12', () => {
    pair('*::-webkit-scrollbar', 'width', '12px', '0', false);
    for (const selector of ['.sheet:has(.smedia-phone)::-webkit-scrollbar', '.smedia-phone .smedia-list::-webkit-scrollbar']) {
      pair(selector, 'width', '0', '12px', false);
      const check = (source: string) => assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('width'), '0');
      const removed = css.replace(selector, selector.replace('.smedia-phone', '.never-phone'));
      assert.notEqual(removed, css); assert.throws(() => check(removed), assert.AssertionError);
    }
  });
});

describe('R146 верх беседы и панель вместо клавиатуры', () => {
  const cap = '.app.m-content .chat > .chat-top > .top-capsule';
  const phone = (source: string) => guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
  const rule = (source: string, selector: string) => {
    const block = phone(source).find(b => splitCss(b.header, ',').includes(selector));
    assert.ok(block, selector); return block;
  };
  const pair = (selector: string, property: string, value: string, bad: string) => {
    const check = (source: string) => assert.equal(guardDeclarations(phone(source), selector).get(property), value, `${selector} ${property}`);
    check(css);
    const block = phone(css).filter(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has(property)).at(-1);
    assert.ok(block, `${selector} ${property}`);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  };
  it('ПК не получает отдельные коробки шапки и капсулы', () => {
    const check = (source: string) => {
      for (const selector of ['.chat-top', '.top-capsule']) assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('display'), 'contents', selector);
    };
    check(css);
    const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes('.chat-top')); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, 'display', 'block')), assert.AssertionError);
  });
  it('телефон накладывает шапку поверх ленты, оба отступа учитывают измеренную высоту плюс 4px', () => {
    pair('.app.m-content .chat > .chat-top', 'position', 'absolute', 'relative');
    pair('.app.m-content .chat > .chat-top', 'display', 'block', 'contents');
    for (const property of ['padding-top', 'scroll-padding-top']) pair('.app.m-content .chat > .feed-frame > .messages', property,
      'calc(var(--chat-top-h, 56px) + 4px)', '60px');
  });
  it('капсула имеет поля 7px и радиус шкалы, пустая не оставляет остров', () => {
    pair(cap, 'margin', '7px 7px 0', '0');
    pair(cap, 'border-radius', 'var(--r-4)', '0');
    pair(`${cap}:empty`, 'display', 'none', 'block');
    const check = (source: string) => assert.equal(guardDeclarations(phone(source), `${cap}:empty`).get('display'), 'none');
    const removed = css.replace(`${cap}:empty`, `${cap}.never-empty`);
    assert.notEqual(removed, css); assert.throws(() => check(removed), assert.AssertionError);
  });
  it('стекло размытия 24px с насыщенностью ×3 живёт в псевдослое, не превращает капсулу в рамку fixed', () => {
    // backdrop-filter на родителе меняет containing block закрепов с position: fixed.
    const check = (source: string) => {
      const blocks = phone(source), parent = guardDeclarations(blocks, cap), glass = guardDeclarations(blocks, `${cap}::before`);
      assert.equal(guardDeclarations(blocks, '.app.m-content').get('--glass-blur'), 'blur(24px) saturate(3)');
      for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
        assert.equal(parent.has(property), false, 'родитель не размывает');
        assert.equal(glass.get(property), 'var(--glass-blur)', property);
      }
      for (const [property, value] of [['content', "''"], ['position', 'absolute'], ['inset', '0'], ['background', 'var(--glass-bg)'], ['pointer-events', 'none']]) assert.equal(glass.get(property), value, property);
    };
    check(css);
    pair('.app.m-content', '--glass-blur', 'blur(24px) saturate(3)', 'blur(12px) saturate(1)');
    const moved = css.replace(`${cap} {`, `${cap} { backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);`);
    assert.notEqual(moved, css); assert.throws(() => check(moved), assert.AssertionError);
    assert.throws(() => check(mutateGuardDeclaration(rule(css, `${cap}::before`), 'backdrop-filter', 'none')), assert.AssertionError);
  });
  it('старый WebView и лёгкая версия получают непрозрачный фон без размытия', () => {
    const check = (source: string) => {
      const blocks = phone(source);
      const fallback = guardScope(blocks, '@supports not (backdrop-filter: blur(1px))');
      for (const values of [guardDeclarations(fallback, '.app.m-content'), guardDeclarations(blocks, 'html.gv-lite .app.m-content')]) {
        assert.equal(values.get('--glass-bg'), 'var(--bg-3)'); assert.equal(values.get('--glass-blur'), 'none');
      }
    };
    check(css);
    assert.throws(() => check(mutateGuardDeclaration(rule(css, 'html.gv-lite .app.m-content'), '--glass-bg', 'transparent')), assert.AssertionError);
    const removed = css.replace('html.gv-lite .app.m-content {', 'html.gv-lite .app.never-content {');
    assert.notEqual(removed, css); assert.throws(() => check(removed), assert.AssertionError);
    const fallback = guardScope(phone(css), '@supports not (backdrop-filter: blur(1px))').find(b => b.header === '.app.m-content'); assert.ok(fallback);
    assert.throws(() => check(mutateGuardDeclaration(fallback, '--glass-bg', 'transparent')), assert.AssertionError);
  });
  it('панель находится в потоке, доки без оконной тени и клавиатура скрывает её только без фокуса внутри', () => {
    pair('.app.m-content .chat > .expr-under', 'display', 'flex', 'none');
    pair('.app.m-content .chat > .expr-under', 'flex', 'none', '1');
    for (const kind of ['emoji', 'sticker']) {
      const selector = `.app.m-content .chat > .expr-under > .${kind}-pop.docked`;
      for (const [property, value, bad] of [['position', 'static', 'fixed'], ['border-radius', '0', 'var(--r-4)'], ['box-shadow', 'none', 'var(--sh-glass)'], ['height', 'auto', '200px']]) pair(selector, property, value, bad);
    }
    const selector = ':root[data-kbspace] .app.m-content .chat > .expr-under:not(:focus-within)';
    pair(selector, 'display', 'none', 'flex');
    const check = (source: string) => assert.equal(guardDeclarations(phone(source), selector).get('display'), 'none');
    for (const replacement of [selector.replace(':not(:focus-within)', ''), selector.replace('[data-kbspace]', '[data-kb]')]) {
      const mutant = css.replace(selector, replacement); assert.notEqual(mutant, css); assert.throws(() => check(mutant), assert.AssertionError);
    }
  });
});

it('R143 телефон ставит эмодзи перед полем, скрепку после поля и отправку перед микрофоном', () => {
  const expected = [['.att-btn.emoji', '1'], ['.composer-input', '2'], ['.att-btn.plus', '3'], ['.send-btn', '4'], ['.mic-btn', '5']] as const;
  const check = (source: string) => {
    const phone = guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
    for (const [button, order] of expected) assert.equal(guardDeclarations(phone, `.app.m-content .composer ${button}`).get('order'), order, button);
  };
  check(css);
  for (const [button, oldOrder] of [['.att-btn.emoji', '3'], ['.att-btn.plus', '1']] as const) {
    const block = guardScope(guardCssBlocks(css), '@media (max-width: 760px)').find(b => b.header === `.app.m-content .composer ${button}`);
    assert.ok(block); assert.throws(() => check(mutateGuardDeclaration(block, 'order', oldOrder)), assert.AssertionError);
  }
});

it('R143 ПК оставляет скрепку и опрос слева, затем поле, служебные кнопки, эмодзи, голос и отправку', () => {
  const check = (source: string) => {
    const base = guardCssBlocks(source);
    for (const [button, order] of [['.att-btn.attach', '0'], ['.att-btn.poll', '0'], ['.composer-input', '1'], ['.att-btn.sched', '2'], ['.att-btn.textfile', '2'], ['.att-btn.emoji', '3'], ['.att-btn.voice', '4'], ['.send-btn', '5']]) {
      assert.equal(guardDeclarations(base, `.composer ${button}`).get('order'), order, button);
    }
  };
  check(css);
  // Возвращение хотя бы одной кнопки на старую сторону поля нарушает desktop/TG-порядок.
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes('.composer .att-btn.attach'));
  assert.ok(block); assert.throws(() => check(mutateGuardDeclaration(block, 'order', '2')), assert.AssertionError);
});

it('R143 пилюля телефона изолирована за кнопками, оставляет справа 44px и не захватывает полосу выделения', () => {
  const parent = '.app.m-content .composer:not(.sel-bar)';
  const check = (source: string) => {
    const phone = guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
    assert.equal(guardDeclarations(phone, parent).get('isolation'), 'isolate');
    const pill = guardDeclarations(phone, `${parent}::before`);
    assert.equal(pill.get('background'), 'var(--bg-3)');
    assert.equal(pill.get('right'), 'calc(44px + var(--sp-2))');
    assert.equal(pill.get('z-index'), '-1');
    assert.equal(pill.get('pointer-events'), 'none');
    // Проверяем и альтернативные селекторы: одной правильной декларации недостаточно при утечке на sel-bar.
    for (const block of phone) for (const selector of splitCss(block.header, ',')) {
      if (/\.composer.*::before/.test(selector)) assert.ok(selector.includes(':not(.sel-bar)'), selector);
    }
  };
  check(css);
  const phone = guardScope(guardCssBlocks(css), '@media (max-width: 760px)');
  const parentBlock = phone.find(b => b.header === parent); assert.ok(parentBlock);
  assert.throws(() => check(mutateGuardDeclaration(parentBlock, 'isolation', 'auto')), assert.AssertionError);
  const pillBlock = phone.find(b => b.header === `${parent}::before`); assert.ok(pillBlock);
  assert.throws(() => check(mutateGuardDeclaration(pillBlock, 'background', 'var(--bg-2)')), assert.AssertionError);
  assert.throws(() => check(mutateGuardDeclaration(pillBlock, 'right', '0')), assert.AssertionError);
  const leak = css.replace(`${parent}::before {`, '.app.m-content .composer::before {');
  assert.notEqual(leak, css); assert.throws(() => check(leak), assert.AssertionError);
});

it('R153 короткая камера занимает одну строку сетки вместо двух', () => {
  // Класс short сам по себе не уменьшает чёрную плитку: нужен отдельный grid-row в каскаде.
  const selector = 'button.gal-cam.short';
  const check = (source: string) => assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('grid-row'), 'span 1');
  check(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector));
  assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'grid-row', 'span 2')), assert.AssertionError);
});

it('R154 строка доступа к камере имеет высоту 56, кнопку 44 и радиус пилюли', () => {
  // Плитка-разрешение не должна снова выглядеть как чёрная камера/видео в сетке.
  const check = (raw: string) => {
    const blocks = guardCssBlocks(raw);
    const row = guardDeclarations(blocks, '.gal-cam-perm');
    const button = guardDeclarations(blocks, '.gal-cam-perm > button');
    assert.equal(row.get('height'), '56px');
    assert.equal(row.get('display'), 'flex');
    assert.equal(row.get('justify-content'), 'center');
    assert.equal(button.get('height'), '44px');
    assert.equal(button.get('border-radius'), 'var(--r-pill)');
  };
  check(css);
  for (const [selector, property, bad] of [['.gal-cam-perm', 'height', '44px'],
    ['.gal-cam-perm > button', 'height', '56px'], ['.gal-cam-perm > button', 'border-radius', '0']]) {
    const block = guardCssBlocks(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
});
it('R154 загрузка большого видео доступна явной кнопкой по центру без бесконечной анимации', () => {
  // Явное действие вместо автоматической загрузки должно оставаться заметным и нажимаемым.
  const check = (raw: string) => {
    const button = guardDeclarations(guardCssBlocks(raw), '.pick-play');
    for (const [property, expected] of [['position', 'absolute'], ['top', '50%'], ['left', '50%'],
      ['transform', 'translate(-50%, -50%)'], ['cursor', 'pointer']]) assert.equal(button.get(property), expected);
    assert.equal(button.has('animation'), false);
  };
  check(css);
  const block = guardCssBlocks(css).find(b => b.header === '.pick-play'); assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'top', '0')), assert.AssertionError);
  const animated = css.replace('.pick-play {', '.pick-play { animation: spin 1s linear infinite;');
  assert.notEqual(animated, css); assert.throws(() => check(animated), assert.AssertionError);
});

it('R151 сетка из трёх колонок учитывает поля и зазоры, полоса прокрутки скрыта', () => {
  const check = (raw: string) => {
    const blocks = guardCssBlocks(raw);
    const grid = guardDeclarations(blocks, '.gal-grid');
    assert.equal(grid.get('grid-auto-rows'), 'calc((100cqw - 4 * var(--sp-1)) / 3)');
    assert.equal(grid.get('gap'), 'var(--sp-1)');
    assert.equal(grid.get('padding'), '0 var(--sp-1)');
    assert.equal(guardDeclarations(blocks, '.gal-scroll').get('scrollbar-width'), 'none');
    assert.equal(guardDeclarations(blocks, '.gal-scroll::-webkit-scrollbar').get('display'), 'none');
  };
  check(css);
  for (const [selector, property, bad] of [['.gal-grid', 'grid-auto-rows', 'calc((100cqw - 2 * var(--sp-1)) / 3)'],
    ['.gal-grid', 'gap', '0'], ['.gal-grid', 'padding', '0'], ['.gal-scroll', 'scrollbar-width', 'auto'],
    ['.gal-scroll::-webkit-scrollbar', 'display', 'block']]) {
    const block = guardCssBlocks(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
});
it('R153 высокая камера занимает два ряда, окно доступа выше листа', () => {
  const check = (raw: string) => {
    const blocks = guardCssBlocks(raw);
    assert.equal(guardDeclarations(blocks, 'button.gal-cam').get('grid-row'), 'span 2');
    assert.equal(guardDeclarations(blocks, 'body:has(.sheet-scrim) .confirm-overlay').get('z-index'), '1260');
  };
  check(css);
  for (const [selector, property, bad] of [['button.gal-cam', 'grid-row', 'span 1'],
    ['body:has(.sheet-scrim) .confirm-overlay', 'z-index', '1100']]) {
    const block = guardCssBlocks(css).find(b => b.header === selector); assert.ok(block);
    assert.throws(() => check(mutateGuardDeclaration(block, property, bad)), assert.AssertionError);
  }
});
it('R151 ожидание миниатюры не крутит бесконечную анимацию в игровом режиме', () => {
  const check = (raw: string) => {
    const wait = guardDeclarations(guardCssBlocks(raw), '.pick-wait');
    assert.equal(wait.has('animation'), false);
    assert.equal(wait.has('animation-name'), false);
  };
  check(css);
  const changed = css.replace('.pick-wait {', '.pick-wait { animation: spin 1s linear infinite;');
  assert.notEqual(changed, css); assert.throws(() => check(changed), assert.AssertionError);
});

it('R139 статус беседы на телефоне имеет размер 14px в мобильной области', () => {
  // Подпись Telegram-шапки не должна наследовать мелкий десктопный размер или менять ПК.
  const selector = '.app.m-content .dm-who .dm-who-sub';
  const check = (source: string) => {
    const phone = guardScope(guardCssBlocks(source), '@media (max-width: 760px)');
    assert.equal(guardDeclarations(phone, selector).get('font-size'), '14px');
  };
  check(css);
  const phone = guardScope(guardCssBlocks(css), '@media (max-width: 760px)');
  const block = phone.find(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has('font-size'));
  assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'font-size', '12px')), assert.AssertionError);
});

it('R139 подпись беззвучного видео располагает значок и отсчёт в одной строке', () => {
  // Без inline-flex значок выключенного звука не образует единый бейдж с оставшимся временем.
  const selector = '.att-dur.muted';
  const check = (source: string) => assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('display'), 'inline-flex');
  check(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector));
  assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'display', 'block')), assert.AssertionError);
});

it('R133 подвал пересылки оставляет 22px и нативный нижний inset после кнопок', () => {
  // Запас под кнопками нужен даже без CSS env(): WebView передаёт нижнюю панель отдельной переменной.
  const selector = '.fwd-foot::after';
  const check = (source: string) => {
    const height = guardDeclarations(guardCssBlocks(source), selector).get('height');
    assert.ok(height); assert.match(height, /\b22px\b/); assert.match(height, /--gv-sab\b/);
  };
  check(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector)); assert.ok(block);
  const height = guardDeclarations([block], selector).get('height'); assert.ok(height);
  assert.throws(() => check(mutateGuardDeclaration(block, 'height', height.replace('22px', '0px'))), assert.AssertionError);
  assert.throws(() => check(mutateGuardDeclaration(block, 'height', '22px')), assert.AssertionError);
});

it('R133 человек в частых не выделяет текст при удержании', () => {
  // Нативное выделение слова уводило поиск и превращало удержание в меню беседы под ним.
  const selector = '.dms-person';
  const check = (source: string) => assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('user-select'), 'none');
  check(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector) && guardDeclarations([b], selector).has('user-select'));
  assert.ok(block); assert.throws(() => check(mutateGuardDeclaration(block, 'user-select', 'text')), assert.AssertionError);
});

it('R133 содержимое строки частого человека не перехватывает указатель у кнопки', () => {
  // Удержание аватара/имени должно попадать в единый обработчик строки, не в дочерний узел.
  const selector = '.dms-person > *';
  const check = (source: string) => assert.equal(guardDeclarations(guardCssBlocks(source), selector).get('pointer-events'), 'none');
  check(css);
  const block = guardCssBlocks(css).find(b => splitCss(b.header, ',').includes(selector)); assert.ok(block);
  assert.throws(() => check(mutateGuardDeclaration(block, 'pointer-events', 'auto')), assert.AssertionError);
});

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
  it('низкий ландшафт галереи имеет четыре колонки и квадратные строки с полями и зазорами', () => {
    const scope = (b: GuardCssBlock[]) => guardScope(b, landscapeMedia);
    pair(scope, '.gal-grid', 'grid-template-columns', 'repeat(4, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))');
    pair(scope, '.gal-grid', 'grid-auto-rows', 'calc((100cqw - 5 * var(--sp-1)) / 4)', 'calc((100cqw - 3 * var(--sp-1)) / 4)');
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
