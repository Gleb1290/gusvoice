import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createContext, Script } from 'node:vm';
import { BROADCAST_MENTIONS, MENTION_LEFT_GUARD, MENTION_NAME_SRC, roleMentionPatternSrc, type Message } from '@gusvoice/shared';
import { createElement, Fragment } from 'react';
import * as ReactRuntime from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { renderMessageText } from './messageText.js';

/**
 * Разметка сообщений.
 *
 * Главное здесь — не «жирный работает», а то, что текст пользователя НИКОГДА не становится
 * разметкой. Это единственное место, куда любой участник пишет что угодно, и рендер идёт через
 * React-узлы без `dangerouslySetInnerHTML`. Тест это фиксирует: вставили тег — он обязан приехать
 * как ВИДИМЫЙ текст, а не как элемент.
 */
// Без JSX намеренно: так тест не зависит от того, какой jsx-рантайм соберёт файл.
const render = (s: string, onEmoji?: (name: string) => string | null) =>
  renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      ...renderMessageText(s, (url, key) => createElement('a', { key, href: url }, url), onEmoji),
    ),
  );

describe('текст пользователя не становится разметкой', () => {
  const атаки = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<svg/onload=alert(1)>',
    '</div><script>alert(1)</script>',
    '<a href="javascript:alert(1)">клик</a>',
    '<style>body{display:none}</style>',
  ];
  for (const s of атаки) {
    it(`экранирует: ${s.slice(0, 34)}`, () => {
      const html = render(s);
      // Проверяем отсутствие ОТКРЫВАЮЩИХ тегов из полезной нагрузки, а не подстрок вроде
      // «onerror=»: в экранированном виде такой текст в выводе есть и это нормально —
      // он показывается как буквы, а не исполняется.
      for (const tag of ['<script', '<iframe', '<img', '<svg', '<style', '<a href="javascript:']) {
        assert.ok(!html.includes(tag), `просочился ${tag}`);
      }
      // Каждая угловая скобка исходного текста обязана приехать экранированной.
      const angles = (s.match(/</g) ?? []).length;
      assert.equal((html.match(/&lt;/g) ?? []).length, angles, 'часть «<» не экранирована');
    });
  }

  it('опасный текст виден пользователю как текст', () => {
    // Экранировать — мало: сообщение должно остаться читаемым, а не пропасть.
    assert.ok(render('<script>alert(1)</script>').includes('&lt;script&gt;'));
  });

  it('markdown внутри тега не открывает его', () => {
    const html = render('**<script>**');
    assert.ok(html.includes('<strong>'));
    assert.ok(!html.includes('<script'));
  });
});

type MessageRenderer = typeof renderMessageText;
type BroadcastDecision = Pick<Message, 'mentionEveryone'>;
const mentioned = (text: string) => `<span class="mention">${text}</span>`;
const broadcastText = '@everyone @here @EVERYONE';
const broadcastRoles = ['Ночная смена'] as const;

function renderDecision(content: string, message: BroadcastDecision, renderer: MessageRenderer = renderMessageText) {
  // DTO и пятый аргумент имеют обратный смысл; эта обвязка не заменяет проверки настоящих call sites MessagePane.
  return renderToStaticMarkup(createElement(Fragment, null, ...renderer(
    content, (url, key) => createElement('a', { key, href: url }, url), undefined, broadcastRoles,
    message.mentionEveryone === false,
  )));
}

const nestedBroadcasts = [
  { label: 'жирный (**…**)', wrap: (s: string) => `**${s}**`, tag: '<strong>',
    anchor: 'inline(bold.slice(2, -2), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'спойлер (||…||)', wrap: (s: string) => `||${s}||`, tag: 'class="spoiler ',
    anchor: 'inline(spoiler.slice(2, -2), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'цитата (> …)', wrap: (s: string) => `> ${s}`, tag: '<blockquote class="md-quote">',
    anchor: 'inline(text, `q${pi}-${idx}`, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'зачёркнутый (~~…~~)', wrap: (s: string) => `~~${s}~~`, tag: '<s>',
    anchor: 'inline(strike.slice(2, -2), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'подчёркнутый (<u>…</u>)', wrap: (s: string) => `<u>${s}</u>`, tag: '<u>',
    anchor: 'inline(under.slice(3, -4), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'двойной курсив (__…__)', wrap: (s: string) => `__${s}__`, tag: '<em>',
    anchor: 'inline(italDbl.slice(2, -2), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'курсив (*…*)', wrap: (s: string) => `*${s}*`, tag: '<em>',
    anchor: 'inline(raw.slice(1, -1), k, onLink, onEmoji, re, plainBroadcast)' },
  { label: 'курсив (_…_)', wrap: (s: string) => `_${s}_`, tag: '<em>',
    anchor: 'inline(raw.slice(1, -1), k, onLink, onEmoji, re, plainBroadcast)' },
] as const;
type NestedBroadcast = (typeof nestedBroadcasts)[number];
const nestedMarker = (fixture: NestedBroadcast, token: string) =>
  `R282 вложенный inline / ${fixture.label} / ${token}: mentionEveryone=false оставляет broadcast текстом`;

function nestedBroadcastContract(renderer: MessageRenderer, fixture: NestedBroadcast) {
  const content = `${broadcastText} @reader @Ночная смена`;
  const html = renderDecision(fixture.wrap(content), { mentionEveryone: false }, renderer);
  assert.ok(html.includes(fixture.tag), `R282 ${fixture.label}: форматирование действительно распознано`);
  for (const token of broadcastText.split(' ')) {
    assert.equal(html.includes(mentioned(token)), false, nestedMarker(fixture, token));
  }
  assert.equal(html.replace(/<[^>]*>/g, ''), content, `R282 ${fixture.label}: текст всех обращений сохранён`);
  for (const token of ['@reader', '@Ночная смена']) {
    assert.ok(html.includes(mentioned(token)), `R282 ${fixture.label}: личное обращение и роль остаются плашками`);
  }
  const allowed = renderDecision(fixture.wrap(content), { mentionEveryone: true }, renderer);
  for (const token of broadcastText.split(' ')) {
    assert.ok(allowed.includes(mentioned(token)), `R282 ${fixture.label}: разрешённый ${token} остаётся плашкой`);
  }
}

function loadMessageRenderer(source: string): MessageRenderer {
  // Исполняется ВЕСЬ TSX, а не извлечённый inline: React, hook спойлера, JSX и правила shared настоящие.
  const compiled = ts.transpileModule(source, { fileName: 'messageText.tsx', reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0,
    'R282 полный messageText.tsx транспилируется без синтаксических ошибок');
  const dependencies: Record<string, unknown> = {
    react: ReactRuntime,
    'react/jsx-runtime': jsxRuntime,
    '@gusvoice/shared': { BROADCAST_MENTIONS, MENTION_LEFT_GUARD, MENTION_NAME_SRC, roleMentionPatternSrc },
  };
  const module = { exports: {} as Record<string, unknown> };
  const context = createContext({ module, exports: module.exports, require: (id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), `R282 незаявленный runtime-импорт: ${id}`);
    return dependencies[id];
  } }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: 'messageText.test.vm.cjs' }).runInContext(context, { timeout: 1000 });
  assert.equal(typeof module.exports.renderMessageText, 'function', 'R282 полный модуль экспортирует настоящий renderer');
  return module.exports.renderMessageText as MessageRenderer;
}

describe('R282 серверное решение о broadcast не подменяется визуальной плашкой', () => {
  it('запрещённые @everyone, @here и вариант регистра видны буквами без плашки', () => {
    // Иначе сообщение никого не зовёт, но визуально обещает всем пинг.
    assert.equal(renderDecision(broadcastText, { mentionEveryone: false }), broadcastText);
  });

  it('разрешённые и старые сообщения, а также renderer по умолчанию сохраняют broadcast-плашки', () => {
    // Отсутствующий флаг у старого DTO — не запрет; это парный положительный сценарий для false.
    const expected = broadcastText.split(' ').map(mentioned).join(' ');
    for (const message of [{}, { mentionEveryone: undefined }, { mentionEveryone: true }]) {
      assert.equal(renderDecision(broadcastText, message), expected);
    }
    assert.equal(render(broadcastText), expected, 'R282 пропущенный пятый аргумент сохраняет прежнюю подсветку');
  });

  it('запрет broadcast не скрывает человека, роль, похожие имена и федеративные обращения', () => {
    // Префикс everyone/here не делает другое имя или адрес гостя общим обращением.
    const tokens = ['@reader', '@Ночная смена', '@everyoneElse', '@here-x', '@everyone.dev', '@everyone@friend.example', '@here@friend.example'];
    assert.equal(renderDecision(`${broadcastText} ${tokens.join(' ')}`, { mentionEveryone: false }),
      `${broadcastText} ${tokens.map(mentioned).join(' ')}`);
    assert.equal(renderDecision('user@everyone.dev @Незваная роль', { mentionEveryone: false }),
      'user@everyone.dev @Незваная роль', 'R282 почта и роль вне roleNames не становятся плашками');
  });

  it('жирный, спойлер, цитата и остальные рекурсивные форматы сохраняют решение сервера', () => {
    // Каждый путь рекурсии обязан передать запрет, не выключая личные и ролевые обращения.
    for (const fixture of nestedBroadcasts) nestedBroadcastContract(renderMessageText, fixture);
  });

  it('контрфакт потери запрета во вложенном inline возвращает ложную broadcast-плашку', () => {
    // Отрицательный контроль принимает только адресную доменную AssertionError, не сбой TSX/импорта/VM.
    const source = readFileSync(new URL('./messageText.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const original = loadMessageRenderer(source);
    for (const fixture of nestedBroadcasts) nestedBroadcastContract(original, fixture);
    const visited = new Set<string>();
    for (const fixture of nestedBroadcasts) {
      if (visited.has(fixture.anchor)) continue; // *…* и _…_ делят одну ветку raw.
      visited.add(fixture.anchor);
      assert.equal(source.split(fixture.anchor).length - 1, 1, `R282 однозначный якорь: ${fixture.anchor}`);
      const mutant = loadMessageRenderer(source.replace(fixture.anchor, fixture.anchor.replace(', plainBroadcast)', ')')));
      const marker = nestedMarker(fixture, '@everyone');
      assert.throws(() => nestedBroadcastContract(mutant, fixture), (error: unknown) =>
        error instanceof assert.AssertionError && error.message.split('\n')[0] === marker
        && error.operator === 'strictEqual' && error.actual === true && error.expected === false,
      `R282 потеря передачи: ${fixture.anchor}`);
    }
    assert.equal(visited.size, 7, 'R282 проверены шесть рекурсивных inline-веток и цитата');
  });
});

describe('оформление', () => {
  it('жирный, курсив, зачёркнутый, код', () => {
    assert.ok(render('**ж**').includes('<strong>ж</strong>'));
    assert.ok(render('*к*').includes('<em>к</em>'));
    assert.ok(render('~~з~~').includes('<s>з</s>'));
    assert.ok(render('`код`').includes('md-code'));
  });

  it('подчёркивания внутри слова НЕ курсив', () => {
    // Иначе snake_case_имя и my_file_name.txt в чате разработчиков превращаются в кашу.
    for (const s of ['snake_case_имя', 'my_file_name.txt', 'a_b_c']) {
      assert.ok(!render(s).includes('<em>'), `${s} стал курсивом`);
    }
  });

  it('_курсив_ на границах слова работает', () => {
    assert.ok(render('вот _так_ можно').includes('<em>'));
  });

  it('блок кода не интерпретирует то, что внутри', () => {
    const html = render('```\n**не жирный** <script>\n```');
    assert.ok(html.includes('md-pre'));
    assert.ok(!html.includes('<strong>'));
    assert.ok(!html.includes('<script'));
  });

  it('цитата и спойлер', () => {
    assert.ok(render('> цитата').includes('md-quote'));
    assert.ok(render('||секрет||').includes('spoiler'));
  });

  it('упоминания подсвечиваются', () => {
    assert.ok(render('привет @everyone').includes('mention'));
    assert.ok(render('@super привет').includes('mention'));
    assert.ok(render('@super.dev привет').includes('mention'));
  });

  it('подсвечиваем только то, что реально кого-то пингует', () => {
    // Имена регистрируются латиницей (`auth.ts`), поэтому `@Маша` не разбудит никого — и
    // подсвечивать его нельзя: подсветка читается как «сработало».
    assert.ok(!render('@Маша привет').includes('mention'));
    // Кусок чужой почты — тем более не упоминание.
    assert.ok(!render('пиши на user@super.dev').includes('mention'));
  });

  it('ссылка отдаётся обработчику', () => {
    assert.ok(render('см. https://example.com/x').includes('href="https://example.com/x"'));
  });

  it('точка после ссылки не съедается', () => {
    const html = render('тут https://example.com/x.');
    assert.ok(html.includes('href="https://example.com/x"'), 'точка попала в адрес');
  });

  it('найденное серверное эмодзи становится картинкой с читаемым alt', () => {
    const html = render('привет :party_parrot:', (name) =>
      name === 'party_parrot' ? 'https://cdn.example/party.webp' : null,
    );
    assert.ok(html.includes('class="custom-emoji"'));
    assert.ok(html.includes('alt=":party_parrot:"'));
    assert.ok(html.includes('src="https://cdn.example/party.webp"'));
  });

  it('неизвестное серверное эмодзи остаётся текстом, а не пропадает', () => {
    const html = render('привет :deleted:', () => null);
    assert.ok(html.includes(':deleted:'));
    assert.ok(!html.includes('custom-emoji'));
  });

  it('время не превращается в серверное эмодзи', () => {
    const html = render('встречаемся в 10:30:00', () => 'https://cdn.example/wrong.webp');
    assert.ok(html.includes('10:30:00'));
    assert.ok(!html.includes('custom-emoji'));
  });

  it('не падает на пустом и на мусоре', () => {
    for (const s of ['', '**', '```', '||', '> ', '~~~~', '*'.repeat(200)]) {
      assert.doesNotThrow(() => render(s), `упал на ${JSON.stringify(s)}`);
    }
  });

  it('разбор длинного сообщения не занимает заметного времени', () => {
    // Разбор идёт на КАЖДЫЙ рендер каждого сообщения: квадратичная регулярка тут вешает вкладку
    // всем сразу, а не только автору.
    const s = ('слово *курсив* **жир** `код` https://example.com/a @имя ||спойлер|| ').repeat(300);
    const t = Date.now();
    render(s);
    const ms = Date.now() - t;
    assert.ok(ms < 1500, `разбор занял ${ms}мс`);
  });
});
