import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  isInPip,
  parsePipSize,
  PIP_MAX,
  PIP_STRIP,
  pipAdd,
  pipGone,
  pipLayout,
  pipRemove,
  pipShouldClose,
  streamPipButtonShown,
  streamPipSize,
  streamsInView,
  type PipSize,
} from './streamPipRules.js';

type PipRules = typeof import('./streamPipRules.js');
const source = readFileSync(new URL('./streamPipRules.ts', import.meta.url), 'utf8');

function loadRules(raw: string): PipRules {
  // Исполняем целый чистый модуль: извлечение формулы скрыло бы ошибки её окружения.
  const module = { exports: {} as PipRules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports,
    require: (id: string) => assert.fail(`Неописанный импорт правил окошка: ${id}`),
  });
  return module.exports;
}

function rejectMutation(from: string, to: string, verify: (api: PipRules) => void, message: string): void {
  verify(loadRules(source)); // Сначала тот же сценарий обязан пройти на оригинале.
  assert.equal(source.split(from).length - 1, 1, 'точка мутации единственная');
  const mutant = loadRules(source.replace(from, to)); // Ошибка загрузки не считается обнаружением регрессии.
  assert.throws(() => verify(mutant),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message));
}

function checkRoundedPositiveSize(api: Pick<PipRules, 'parsePipSize'>): void {
  for (const side of ['width', 'height'] as const) {
    for (const value of [-1, -0.5, -0.49, 0, 0.49]) {
      assert.equal(api.parsePipSize(JSON.stringify({ width: 480, height: 270, [side]: value })), null,
        'сторона, округлённая в ноль или ниже, отклоняется');
    }
    // NaN не является JSON-числом; повреждённая запись также не должна уронить парсер.
    const nanRaw = side === 'width' ? '{"width":NaN,"height":270}' : '{"width":480,"height":NaN}';
    assert.equal(api.parsePipSize(nanRaw), null);
    for (const value of [0.5, 0.51, 1, 1.49, 1.5]) {
      const expected = { width: 480, height: 270, [side]: Math.round(value) };
      const result = api.parsePipSize(JSON.stringify({ width: 480, height: 270, [side]: value }));
      assert.equal(result?.width, expected.width, 'положительная округлённая ширина принимается');
      assert.equal(result?.height, expected.height, 'положительная округлённая высота принимается');
    }
  }
  assert.equal(api.parsePipSize('{"width":0.49,"height":0.49}'), null);
  const both = api.parsePipSize('{"width":0.5,"height":0.5}');
  assert.equal(both?.width, 1);
  assert.equal(both?.height, 1);
}

describe('размер окошка чужого показа', () => {
  it('без сохранённого размера открывается кадр 480×270', () => {
    // Первый запуск не должен зависеть от наличия записи в хранилище.
    for (const saved of [null, undefined, {}]) {
      assert.deepEqual(streamPipSize(saved), { width: 480, height: 270 });
    }
  });

  it('высота вычисляется из ширины, а растянутая сохранённая высота игнорируется', () => {
    // Адресный свидетель: возврат saved.height оставил бы полосы после ручного растягивания окна.
    assert.deepEqual(streamPipSize({ width: 640, height: 999 }), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 640, height: Number.NaN }), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 640 }), { width: 640, height: 360 });
  });

  it('минимум 240 удерживается с обеих сторон границы', () => {
    // Узкое окно не должно прятать кнопки, но ширину выше минимума сохраняем.
    assert.deepEqual(streamPipSize({ width: 239 }), { width: 240, height: 135 });
    assert.deepEqual(streamPipSize({ width: 240 }), { width: 240, height: 135 });
    assert.deepEqual(streamPipSize({ width: 241 }), { width: 241, height: 136 });
  });

  it('дробная ширина и высота кадра округляются до пикселя', () => {
    // Размер после перетаскивания может быть дробным, браузеру нужен согласованный кадр.
    assert.deepEqual(streamPipSize({ width: 480.49 }), { width: 480, height: 270 });
    assert.deepEqual(streamPipSize({ width: 480.5 }), { width: 481, height: 271 });
  });

  it('половина ширины экрана ограничивает только превышающий размер', () => {
    // Ловит неверный знак сравнения и потерянный верхний предел.
    const screen = { width: 1280, height: 1440 };
    assert.deepEqual(streamPipSize({ width: 639 }, screen), { width: 639, height: 359 });
    assert.deepEqual(streamPipSize({ width: 640 }, screen), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 641 }, screen), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 900 }, { width: 1281, height: 1440 }), { width: 640, height: 360 });
  });

  it('низкий экран ограничивает размер по половине высоты, сохраняя 16:9', () => {
    // На широком низком мониторе одного ограничения ширины недостаточно.
    const screen = { width: 2560, height: 720 };
    assert.deepEqual(streamPipSize({ width: 639 }, screen), { width: 639, height: 359 });
    assert.deepEqual(streamPipSize({ width: 640 }, screen), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 641 }, screen), { width: 640, height: 360 });
    assert.deepEqual(streamPipSize({ width: 900 }, { width: 2560, height: 719 }), { width: 639, height: 359 });
  });

  it('на очень маленьком экране минимум важнее половины экрана', () => {
    // Это приоритет текущего договора: кнопки должны помещаться даже на тесном экране.
    for (const screen of [{ width: 400, height: 1000 }, { width: 1000, height: 200 }]) {
      assert.deepEqual(streamPipSize({ width: 1000 }, screen), { width: 240, height: 135 });
    }
  });

  it('неположительная, бесконечная и нечисловая сохранённая ширина заменяется умолчанием', () => {
    // Повреждённая запись не должна превращать окошко в нулевой или бесконечный прямоугольник.
    for (const width of [0, -1, Number.NaN, Infinity, -Infinity, '640', null]) {
      assert.deepEqual(streamPipSize({ width } as unknown as Partial<PipSize>), { width: 480, height: 270 });
    }
    assert.deepEqual(streamPipSize({ width: 0 }, { width: 640, height: 720 }), { width: 320, height: 180 });
  });

  it('без пригодных размеров экрана верхнего ограничения нет', () => {
    // Нулевые размеры screen не должны схлопывать корректный сохранённый размер.
    for (const screen of [null, undefined, { width: 0, height: 720 }, { width: 1280, height: 0 }, { width: -1, height: 720 }]) {
      assert.deepEqual(streamPipSize({ width: 1600 }, screen), { width: 1600, height: 900 });
    }
  });
});

describe('список показов одного окошка', () => {
  it('четыре показа помещаются, а пятый вытесняет только самый старый', () => {
    // Граница общего лимита: пятый показ не должен исчезать сам вместо первого.
    assert.equal(PIP_MAX, 4);
    const before = Object.freeze(['alice', 'bob', 'carol']);
    const four = pipAdd(before, 'dave');
    assert.deepEqual(four, ['alice', 'bob', 'carol', 'dave']);
    assert.deepEqual(pipAdd(four, 'eve'), ['bob', 'carol', 'dave', 'eve']);
    assert.deepEqual(before, ['alice', 'bob', 'carol']);
    assert.deepEqual(four, ['alice', 'bob', 'carol', 'dave']);
  });

  it('повторный и пустой показ сохраняют тот же объект и возраст остальных', () => {
    // Лишняя новая ссылка вызовет set и перерисовку, а перенос дубля в конец изменит вытеснение.
    const ids = Object.freeze(['alice', 'bob', 'carol', 'dave']);
    assert.equal(pipAdd(ids, 'alice'), ids);
    assert.equal(pipAdd(ids, 'carol', 1), ids);
    assert.equal(pipAdd(ids, ''), ids);
    assert.deepEqual(pipAdd(pipAdd(ids, 'alice'), 'eve'), ['bob', 'carol', 'dave', 'eve']);
  });

  it('новый показ добавляется в конец независимо от алфавита и без изменения входа', () => {
    // Порядок — время добавления, а не сортировка identity.
    const ids = Object.freeze(['zara#screen', 'bob']);
    const next = pipAdd(ids, 'alice');
    assert.notEqual(next, ids);
    assert.deepEqual(next, ['zara#screen', 'bob', 'alice']);
    assert.deepEqual(ids, ['zara#screen', 'bob']);
    assert.deepEqual(pipAdd([], 'alice'), ['alice']);
  });

  it('пользовательский лимит округляется вниз и оставляет самые новые показы', () => {
    // Дробный лимит не должен случайно разрешить дополнительную ячейку.
    const ids = Object.freeze(['alice', 'bob', 'carol']);
    assert.deepEqual(pipAdd(ids, 'dave', 2), ['carol', 'dave']);
    assert.deepEqual(pipAdd(ids, 'dave', 2.99), ['carol', 'dave']);
    assert.deepEqual(pipAdd(['alice'], 'bob', 2), ['alice', 'bob']);
  });

  it('лимит ниже единицы всё равно оставляет новый показ, как и ровно единица', () => {
    // Нулевой max не должен потерять только что выбранный человеком показ.
    for (const max of [-10, -0.5, 0, 0.99, 1]) {
      assert.deepEqual(pipAdd(Object.freeze(['alice', 'bob']), 'carol', max), ['carol']);
      assert.deepEqual(pipAdd([], 'carol', max), ['carol']);
    }
  });

  it('удаление убирает только точный показ и сохраняет порядок соседей', () => {
    // Основной поток и отдельный #screen одного участника нельзя удалить вместе.
    const ids = Object.freeze(['alice', 'bob#screen', 'alice#screen']);
    assert.deepEqual(pipRemove(ids, 'bob#screen'), ['alice', 'alice#screen']);
    assert.deepEqual(pipRemove(ids, 'alice'), ['bob#screen', 'alice#screen']);
    assert.deepEqual(pipRemove(['alice'], 'alice'), []);
    assert.deepEqual(ids, ['alice', 'bob#screen', 'alice#screen']);
  });

  it('удаление отсутствующего показа не меняет ссылку списка', () => {
    // Повторный сигнал завершения не должен создавать лишний set в сторе.
    const ids = Object.freeze(['alice#screen']);
    assert.equal(pipRemove(ids, 'alice'), ids);
    assert.equal(pipRemove(ids, ''), ids);
    const empty = Object.freeze([] as string[]);
    assert.equal(pipRemove(empty, 'alice'), empty);
  });

  it('исчезнувшие показы вычисляются по каждому элементу, а не по первому', () => {
    // Первый остаётся жив, но второй ушёл: закрывать всё окно или ничего одинаково неверно.
    const ids = Object.freeze(['alice', 'bob#screen', 'carol']);
    const live = Object.freeze(['carol', 'alice', 'dave']);
    assert.deepEqual(pipGone(ids, live), ['bob#screen']);
    assert.deepEqual(pipGone(ids, ['carol']), ['alice', 'bob#screen']);
    assert.deepEqual(pipGone(ids, []), ['alice', 'bob#screen', 'carol']);
    assert.deepEqual(pipGone(ids, ids), []);
    assert.deepEqual(pipGone([], live), []);
    assert.deepEqual(ids, ['alice', 'bob#screen', 'carol']);
    assert.deepEqual(live, ['carol', 'alice', 'dave']);
  });

  it('список окошка добавляется к сцене без повторов и без изменения обоих входов', () => {
    // Одна подписка нужна даже при совпадении сцены с PiP и повторе в самом PiP.
    const watched = Object.freeze(['alice', 'bob#screen']);
    const pips = Object.freeze(['bob#screen', '', 'carol', 'carol', 'alice#screen']);
    assert.deepEqual(streamsInView(watched, pips), ['alice', 'bob#screen', 'carol', 'alice#screen']);
    assert.deepEqual(streamsInView([], pips), ['bob#screen', 'carol', 'alice#screen']);
    assert.deepEqual(streamsInView(watched, []), ['alice', 'bob#screen']);
    assert.deepEqual(watched, ['alice', 'bob#screen']);
    assert.deepEqual(pips, ['bob#screen', '', 'carol', 'carol', 'alice#screen']);
  });

  it('поиск в списке различает участника и спутник и не принимает пустую identity', () => {
    // Совместимость со строковым API не означает поиск по подстроке или ownerOf.
    const pips = Object.freeze(['alice#screen', 'bob', '']);
    assert.equal(isInPip('alice#screen', pips), true);
    assert.equal(isInPip('bob', pips), true);
    assert.equal(isInPip('alice', pips), false);
    assert.equal(isInPip('bob#screen', pips), false);
    assert.equal(isInPip('', pips), false);
    assert.equal(isInPip('bob', []), false);
  });
});

describe('раскладка нескольких показов в окошке', () => {
  it('ноль не даёт ячеек, а один показ занимает всё окно даже при фокусе', () => {
    // Фокус единственного показа не должен резервировать пустую полосу.
    assert.deepEqual(pipLayout(0, null, 640, 360), []);
    for (const focus of [null, undefined, 0, 1, -1]) {
      for (const [w, h] of [[640, 360], [360, 640], [400, 400]]) {
        assert.deepEqual(pipLayout(1, focus, w, h), [{ x: 0, y: 0, w: 1, h: 1 }]);
      }
    }
  });

  it('два показа в широком и квадратном окне идут в ряд, в высоком — столбиком', () => {
    // Квадрат — отдельная граница: строгое w > h ошибочно повернуло бы раскладку.
    const row = [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }];
    assert.deepEqual(pipLayout(2, null, 641, 640), row);
    assert.deepEqual(pipLayout(2, null, 640, 640), row);
    assert.deepEqual(pipLayout(2, null, 640, 641), [
      { x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 },
    ]);
  });

  it('три показа центрируют нижний, четыре заполняют сетку без перестановки', () => {
    // Третий не должен прижиматься влево до появления четвёртого.
    for (const [w, h] of [[640, 360], [360, 640], [400, 400]]) {
      const top = [{ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }];
      assert.deepEqual(pipLayout(3, null, w, h), [...top, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }]);
      assert.deepEqual(pipLayout(4, null, w, h), [...top,
        { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      ]);
    }
  });

  it('фокус вне диапазона и дробный фокус оставляют обычную сетку', () => {
    // Удаление участника может оставить старый индекс: нельзя сделать безымянную крупную ячейку.
    for (const count of [2, 3, 4]) {
      for (const focus of [-1, count, count + 1, 0.5, Number.NaN, Infinity]) {
        assert.deepEqual(pipLayout(count, focus, 640, 360), pipLayout(count, null, 640, 360));
      }
      assert.deepEqual(pipLayout(count, undefined, 640, 360), pipLayout(count, null, 640, 360));
    }
  });

  it('в широком и квадратном окне фокус оставляет четверть высоты нижней полосе', () => {
    // Полоса вдоль короткой стороны, а порядок массива остаётся порядком identity, не фокуса.
    assert.equal(PIP_STRIP, 0.25);
    for (const [w, h] of [[800, 400], [400, 400]]) {
      assert.deepEqual(pipLayout(3, 1, w, h), [
        { x: 0, y: 0.75, w: 0.5, h: 0.25 },
        { x: 0, y: 0, w: 1, h: 0.75 },
        { x: 0.5, y: 0.75, w: 0.5, h: 0.25 },
      ]);
    }
  });

  it('в высоком окне фокус оставляет четверть ширины правой полосе', () => {
    // При повороте окна меняется именно сторона полосы, а не порядок показов.
    assert.deepEqual(pipLayout(3, 1, 400, 800), [
      { x: 0.75, y: 0, w: 0.25, h: 0.5 },
      { x: 0, y: 0, w: 0.75, h: 1 },
      { x: 0.75, y: 0.5, w: 0.25, h: 0.5 },
    ]);
  });

  it('ячейки всех допустимых фокусов остаются внутри окна, не пересекаются и сохраняют площадь', () => {
    // Нужны все индексы: при фокусе не на первом легко сбить счётчик соседней полосы.
    const eps = 1e-12;
    for (const count of [1, 2, 3, 4]) {
      for (const focus of [null, ...Array.from({ length: count }, (_, i) => i)]) {
        for (const [w, h] of [[900, 400], [400, 900], [400, 400]]) {
          const cells = pipLayout(count, focus, w, h);
          assert.equal(cells.length, count);
          let area = 0;
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            assert.ok([cell.x, cell.y, cell.w, cell.h].every(Number.isFinite));
            assert.ok(cell.x >= 0 && cell.y >= 0 && cell.w > 0 && cell.h > 0);
            assert.ok(cell.x + cell.w <= 1 + eps && cell.y + cell.h <= 1 + eps);
            area += cell.w * cell.h;
            for (const other of cells.slice(i + 1)) {
              const overlapW = Math.min(cell.x + cell.w, other.x + other.w) - Math.max(cell.x, other.x);
              const overlapH = Math.min(cell.y + cell.h, other.y + other.h) - Math.max(cell.y, other.y);
              assert.ok(overlapW <= eps || overlapH <= eps, 'показы не заслоняют друг друга');
            }
          }
          const expectedArea = count === 3 && focus === null ? 0.75 : 1;
          assert.ok(Math.abs(area - expectedArea) < eps, 'сетка теряет только два угла у трёх показов без фокуса');
          if (focus !== null && count > 1) {
            assert.equal(cells[focus].w * cells[focus].h, 0.75);
            assert.ok(cells.filter((_, i) => i !== focus).every(c =>
              w >= h ? c.y === 0.75 && c.h === 0.25 : c.x === 0.75 && c.w === 0.25));
          }
        }
      }
    }
  });

  it('число показов ограничивается четырьмя и округляется вниз, мусор даёт пустую раскладку', () => {
    // На входе может остаться устаревшее число после смены лимита, но пятой ячейки нет.
    assert.deepEqual(pipLayout(4.9, null, 640, 360), pipLayout(4, null, 640, 360));
    assert.deepEqual(pipLayout(5, null, 640, 360), pipLayout(4, null, 640, 360));
    assert.deepEqual(pipLayout(2.9, null, 640, 360), pipLayout(2, null, 640, 360));
    for (const count of [-1, 0.9, Number.NaN, Infinity, -Infinity]) {
      assert.deepEqual(pipLayout(count, null, 640, 360), []);
    }
  });

  it('нечисловые размеры используют горизонтальный вариант без повреждения ячеек', () => {
    // В момент открытия браузер ещё может не сообщить размер окна.
    for (const [w, h] of [[Number.NaN, 400], [400, Number.NaN], [Number.NaN, Number.NaN]]) {
      assert.deepEqual(pipLayout(2, null, w, h), pipLayout(2, null, 640, 360));
      assert.deepEqual(pipLayout(3, 1, w, h), pipLayout(3, 1, 640, 360));
    }
  });
});

describe('адресные контрфакты списка и раскладки', () => {
  it('вытеснение новых вместо старых отвергается после проверки оригинала', () => {
    // Сценарий должен заметить потерю именно нового показа, а не лишь длину списка.
    rejectMutation('next.slice(next.length - keep)', 'next.slice(0, keep)', api => {
      assert.equal(api.pipAdd(['alice', 'bob', 'carol', 'dave'], 'eve').join(','),
        'bob,carol,dave,eve', 'пятый вытесняет самого старого');
    }, 'пятый вытесняет самого старого');
  });

  it('поворот квадратного окна в столбик отвергается после проверки оригинала', () => {
    // Равенство сторон — адресная граница для !(h > w) против w > h.
    rejectMutation('!(h > w)', 'w > h', api => {
      const cells = api.pipLayout(2, null, 400, 400);
      assert.equal(cells[1].x, 0.5, 'квадрат раскладывает два показа в ряд');
      assert.equal(cells[1].y, 0);
      assert.equal(api.pipLayout(3, 1, 400, 400)[1].h, 0.75);
    }, 'квадрат раскладывает два показа в ряд');
  });
});

describe('разбор сохранённого размера окошка', () => {
  it('корректный размер принимается, включая размеры меньше минимума самого окна', () => {
    // Разбор записи и ограничение размера — разные этапы: парсер не должен подменять данные.
    assert.deepEqual(parsePipSize('{"width":480,"height":270}'), { width: 480, height: 270 });
    assert.deepEqual(parsePipSize('{"width":1,"height":1}'), { width: 1, height: 1 });
    assert.deepEqual(parsePipSize('{"width":239,"height":134}'), { width: 239, height: 134 });
  });

  it('положительные дробные размеры округляются по обе стороны половины пикселя', () => {
    // Размер сохраняется после изменения окна, поэтому допустимы не только целые числа.
    assert.deepEqual(parsePipSize('{"width":480.49,"height":270.49}'), { width: 480, height: 270 });
    assert.deepEqual(parsePipSize('{"width":480.5,"height":270.5}'), { width: 481, height: 271 });
  });

  it('каждая сторона ниже 0.5 отклоняется после округления, а 0.5 и положительные соседи принимаются', () => {
    // Класс ошибки: проверка исходного положительного числа пропускает нулевой размер после округления (R254).
    checkRoundedPositiveSize({ parsePipSize });
  });

  it('нулевая и отрицательная сторона отклоняется, положительная соседняя принимается', () => {
    // Проверяем обе стороны каждой границы: нельзя принять поломанный размер или отвергнуть живой.
    for (const side of ['width', 'height'] as const) {
      for (const value of [-1, 0]) {
        assert.equal(parsePipSize(JSON.stringify({ width: 480, height: 270, [side]: value })), null);
      }
      assert.deepEqual(parsePipSize(JSON.stringify({ width: 480, height: 270, [side]: 1 })), {
        width: 480, height: 270, [side]: 1,
      });
    }
  });

  it('пустая запись и повреждённый JSON безопасно дают отсутствие размера', () => {
    // Чтение localStorage не должно мешать открыть показ после оборванной записи.
    for (const raw of [null, undefined, '', ' ', '{', '{"width":480,"height":270,}', 'undefined']) {
      assert.equal(parsePipSize(raw), null);
    }
  });

  it('необъект, отсутствующие стороны, строки и бесконечные числа не принимаются', () => {
    // JSON может быть синтаксически целым, но не являться записью размера.
    for (const raw of [
      'null', 'false', '12', '"480"', '[]', '{}', '{"width":480}', '{"height":270}',
      '{"width":"480","height":270}', '{"width":480,"height":"270"}',
      '{"width":null,"height":270}', '{"width":480,"height":null}',
      '{"width":1e309,"height":270}', '{"width":480,"height":1e309}',
    ]) {
      assert.equal(parsePipSize(raw), null, raw);
    }
  });
});

describe('какие показы остаются открытыми', () => {
  it('без окошка остаётся независимая копия показов сцены', () => {
    // Потребители могут менять свой список, не повреждая состояние сцены.
    const watched = Object.freeze(['alice', 'bob#screen']);
    for (const pip of [null, undefined, '']) {
      const result = streamsInView(watched, pip);
      assert.deepEqual(result, ['alice', 'bob#screen']);
      assert.notEqual(result, watched);
    }
    assert.deepEqual(streamsInView([], null), []);
  });

  it('показ в окошке добавляется даже без сцены и не меняет входной список', () => {
    // После перехода в текстовый канал звук и подписка окошка должны продолжаться.
    const watched = Object.freeze(['alice']);
    assert.deepEqual(streamsInView(watched, 'bob#screen'), ['alice', 'bob#screen']);
    assert.deepEqual(watched, ['alice']);
    assert.deepEqual(streamsInView([], 'bob#screen'), ['bob#screen']);
  });

  it('уже открытый показ не добавляется второй раз', () => {
    // Одновременный просмотр на сцене и в PiP не должен дублировать identity.
    const watched = Object.freeze(['alice', 'bob#screen']);
    const result = streamsInView(watched, 'bob#screen');
    assert.deepEqual(result, ['alice', 'bob#screen']);
    assert.notEqual(result, watched);
    assert.deepEqual(streamsInView(['bob#screen'], 'bob#screen'), ['bob#screen']);
  });

  it('окошко узнаёт только точную identity, включая спутник показа', () => {
    // Нельзя спутать основной медиапоток участника с его отдельным #screen.
    assert.equal(isInPip('alice#screen', 'alice#screen'), true);
    assert.equal(isInPip('alice', 'alice'), true);
    assert.equal(isInPip('alice', 'alice#screen'), false);
    assert.equal(isInPip('alice#screen', 'bob#screen'), false);
  });

  it('без identity окошка ни один показ не считается вынесенным', () => {
    // Иначе пустой идентификатор мог бы скрыть карточку на сцене.
    for (const pip of [null, undefined, '']) {
      assert.equal(isInPip('alice', pip), false);
      assert.equal(isInPip('', pip), false);
    }
  });
});

describe('доступность и закрытие окошка показа', () => {
  it('на компьютере достаточно любого API, а Android скрывает кнопку при любом их сочетании', () => {
    // Оба запасных пути нужны, но эта кнопка не должна вмешиваться в системное окошко Android.
    for (const android of [false, true]) {
      for (const documentPip of [false, true]) {
        for (const videoPip of [false, true]) {
          assert.equal(streamPipButtonShown({ android, documentPip, videoPip }),
            !android && (documentPip || videoPip), JSON.stringify({ android, documentPip, videoPip }));
        }
      }
    }
  });

  it('выход из голоса закрывает окошко, даже если показ ещё числится живым', () => {
    // Адресный свидетель пропуска !inVoice: список комнаты может очищаться позднее выхода.
    assert.equal(pipShouldClose('alice#screen', ['alice#screen'], false), true);
    assert.equal(pipShouldClose('alice#screen', [], false), true);
  });

  it('в голосе исчезнувший показ закрывается, сохранившийся остаётся открыт', () => {
    // Соседний живой показ не должен удерживать окно уже завершённого показа.
    assert.equal(pipShouldClose('alice#screen', ['bob#screen'], true), true);
    assert.equal(pipShouldClose('alice#screen', [], true), true);
    assert.equal(pipShouldClose('alice#screen', ['bob#screen', 'alice#screen'], true), false);
  });

  it('без окошка закрывать нечего независимо от голоса и живых показов', () => {
    // Выход из голоса сам по себе не является событием закрытия несуществующего окна.
    for (const pip of [null, undefined, '']) {
      for (const inVoice of [false, true]) {
        assert.equal(pipShouldClose(pip, [], inVoice), false);
        assert.equal(pipShouldClose(pip, ['alice#screen'], inVoice), false);
      }
    }
  });
});

describe('адресные контрфакты правил окошка', () => {
  it('сохранённая высота вместо 16:9 отвергается после проверки оригинала', () => {
    // Растянутое вручную окно не должно диктовать пропорции следующего показа.
    rejectMutation('height: Math.round((width * 9) / 16)', 'height: saved?.height ?? Math.round((width * 9) / 16)', api => {
      assert.equal(api.streamPipSize({ width: 640, height: 999 }).height, 360, 'высота кадра берётся из ширины');
    }, 'высота кадра берётся из ширины');
  });

  it('пропуск выхода из голоса отвергается после проверки оригинала', () => {
    // Комнатный список может ещё содержать показ, когда голосовое соединение уже закрыто.
    rejectMutation('if (!inVoice) return true;', '', api => {
      assert.equal(api.pipShouldClose('alice#screen', ['alice#screen'], false), true, 'выход из голоса закрывает живой показ');
      assert.equal(api.pipShouldClose('alice#screen', ['alice#screen'], true), false);
    }, 'выход из голоса закрывает живой показ');
  });

  it('контрфакт проверки размера до округления отвергается после проверки оригинала', () => {
    // Класс ошибки: положительные 0.49 принимаются, хотя возвращённая сторона уже равна нулю.
    rejectMutation('if (width <= 0 || height <= 0) return null;', 'if (v.width <= 0 || v.height <= 0) return null;',
      checkRoundedPositiveSize, 'сторона, округлённая в ноль или ниже, отклоняется');
  });
});
