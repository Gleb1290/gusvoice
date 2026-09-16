import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearCrash,
  copySavedCrash,
  crashText,
  CRASH_KEY,
  describeCrash,
  readCrash,
  saveCrash,
  STACK_MAX,
  type CrashStore,
} from './crashReport.js';

/** Хранилище в памяти; `fail` заставляет его вести себя как отключённое в браузере. */
function memStore(fail = false): CrashStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k) {
      if (fail) throw new Error('storage disabled');
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (fail) throw new Error('storage disabled');
      data.set(k, v);
    },
    removeItem(k) {
      if (fail) throw new Error('storage disabled');
      data.delete(k);
    },
  };
}

describe('describeCrash — брошено может быть что угодно', () => {
  it('обычная ошибка даёт имя, сообщение и стек', () => {
    const e = new TypeError('Cannot read properties of undefined');
    const r = describeCrash(e, '\n    at VoiceControls', 1000, 'UA');
    assert.equal(r.message, 'TypeError: Cannot read properties of undefined');
    assert.match(r.stack, /TypeError/);
    assert.match(r.component, /VoiceControls/);
    assert.equal(r.at, 1000);
    assert.equal(r.ua, 'UA');
  });

  it('строка, объект и undefined не роняют сам разбор', () => {
    // Ловит худший отказ: падение внутри обработчика аварии прячет исходную ошибку.
    assert.equal(describeCrash('просто строка', null, 0, '').message, 'просто строка');
    assert.equal(describeCrash({ message: 'из объекта' }, null, 0, '').message, 'из объекта');
    assert.equal(describeCrash({ code: 7 }, null, 0, '').message, '{"code":7}');
    assert.equal(describeCrash(undefined, null, 0, '').message, 'undefined');
    assert.equal(describeCrash(null, undefined, 0, '').message, 'null');
  });

  it('циклический объект не бросает на сериализации', () => {
    // React и WebRTC щедры на объекты со ссылками на себя.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => describeCrash(cyclic, null, 0, ''));
  });

  it('ошибка без сообщения не даёт пустую строку', () => {
    // Пустой заголовок на экране аварии читается как «ничего не случилось».
    const e = new Error('');
    assert.equal(describeCrash(e, null, 0, '').message, 'Error');
  });

  it('длинный стек обрезается с пометкой', () => {
    // Ловит попытку положить в хранилище неограниченный текст.
    const e = new Error('boom');
    e.stack = 'x'.repeat(STACK_MAX * 2);
    const r = describeCrash(e, null, 0, '');
    assert.ok(r.stack.length < STACK_MAX + 40);
    assert.match(r.stack, /обрезано$/);
  });

  it('сообщение принимается ровно до лимита и обрезается сразу после', () => {
    // Ловит снятие потолка с главного поля отчёта: hostile throw не должен раздувать localStorage.
    assert.equal(describeCrash('x'.repeat(500), null, 0, '').message, 'x'.repeat(500));
    const over = describeCrash('x'.repeat(501), null, 0, '').message;
    assert.equal(over.slice(0, 500), 'x'.repeat(500));
    assert.match(over, /обрезано$/);
  });

  it('стек компонентов принимается ровно до лимита и обрезается сразу после', () => {
    // Ловит off-by-one и неограниченный React component stack независимо от обычного JS-стека.
    assert.equal(describeCrash('x', 'c'.repeat(2000), 0, '').component, 'c'.repeat(2000));
    const over = describeCrash('x', 'c'.repeat(2001), 0, '').component;
    assert.equal(over.slice(0, 2000), 'c'.repeat(2000));
    assert.match(over, /обрезано$/);
  });
});

describe('crashText — то, что человек копирует и присылает', () => {
  it('несёт сообщение, стек и стек компонентов', () => {
    const r = describeCrash(new Error('бум'), '\n    at App', 0, 'WebView2/1.2');
    const t = crashText(r);
    assert.match(t, /Ошибка: Error: бум/);
    assert.match(t, /WebView2\/1\.2/);
    assert.match(t, /at App/);
  });

  it('пустые части подписаны, а не пропущены', () => {
    // «Компоненты:» без строки читается как обрыв текста, «(нет)» — как факт.
    const t = crashText(describeCrash('строка', null, 0, ''));
    assert.match(t, /Стек:\n\(нет\)/);
    assert.match(t, /Компоненты:\n\(нет\)/);
  });
});

describe('хранение аварии', () => {
  it('запись и чтение возвращают то же самое', () => {
    const s = memStore();
    const r = describeCrash(new Error('бум'), '\n    at App', 123, 'UA');
    assert.equal(saveCrash(s, r), true);
    assert.deepEqual(readCrash(s), r);
    assert.ok(s.data.has(CRASH_KEY));
  });

  it('отключённое хранилище не бросает ни на записи, ни на чтении', () => {
    // Ловит главный отказ: падение здесь означает, что экран ошибки не покажется вовсе.
    const s = memStore(true);
    assert.equal(saveCrash(s, describeCrash('x', null, 0, '')), false);
    assert.equal(readCrash(s), null);
    assert.doesNotThrow(() => clearCrash(s));
    assert.equal(saveCrash(null, describeCrash('x', null, 0, '')), false);
    assert.equal(readCrash(undefined), null);
  });

  it('мусор в хранилище читается как «аварии нет»', () => {
    const s = memStore();
    s.data.set(CRASH_KEY, 'не json');
    assert.equal(readCrash(s), null);
    s.data.set(CRASH_KEY, '{"at":1}');
    assert.equal(readCrash(s), null, 'запись без сообщения — не отчёт');
    s.data.set(CRASH_KEY, 'null');
    assert.equal(readCrash(s), null);
  });

  it('чужие поля добираются умолчаниями, а не роняют чтение', () => {
    // Формат отчёта со временем меняется; старая запись должна читаться, а не пропадать молча.
    const s = memStore();
    s.data.set(CRASH_KEY, JSON.stringify({ message: 'из старой версии' }));
    assert.deepEqual(readCrash(s), { at: 0, message: 'из старой версии', stack: '', component: '', ua: '' });
  });

  it('очистка убирает запись', () => {
    const s = memStore();
    saveCrash(s, describeCrash('x', null, 0, ''));
    clearCrash(s);
    assert.equal(readCrash(s), null);
  });
});

describe('🔴 отчёт об аварии сам не должен становиться аварией', () => {
  it('брошенный объект с ядовитым геттером не роняет разбор', () => {
    // Находка Codex: чтение `message` стояло ВНЕ try. Бросить объект, чей геттер сам бросает, —
    // и `describeCrash` падал ровно там, где обязан был описать поломку, подменяя настоящую
    // причину своей. Человек видел «getter boom» вместо своей аварии.
    const poisoned = {
      get message(): string {
        throw new Error('getter boom');
      },
    };
    // Зовём НАПРЯМУЮ: бросит — тест упадёт с самим исключением, а это и есть нужный сигнал.
    const r = describeCrash(poisoned, null, 1_700_000_000_000, 'UA');
    assert.ok(r.message.length > 0, 'отчёт получен и не пустой — авария была, молчать о ней нельзя');
  });

  it('бесконечная отметка времени из хранилища не роняет текст отчёта', () => {
    // `JSON.parse('{"at":1e309}')` даёт Infinity: проверка `typeof === "number"` его пропускала, а
    // `new Date(Infinity)` роняет crashText с RangeError.
    const s = memStore();
    s.data.set(CRASH_KEY, '{"at":1e309,"message":"x"}');
    const r = readCrash(s);
    assert.ok(r);
    assert.equal(r!.at, 0, 'бесконечность заменена нулём');
    assert.doesNotThrow(() => crashText(r!));
  });

  it('NaN во времени тоже не проходит', () => {
    const s = memStore();
    s.data.set(CRASH_KEY, '{"at":null,"message":"x"}');
    const r = readCrash(s);
    assert.equal(r?.at, 0);
    assert.doesNotThrow(() => crashText(r!));
  });
});

describe('🔴 граница даты, а не только бесконечность', () => {
  it('конечное, но негодное для даты число тоже отбрасывается', () => {
    // Вторая находка Codex подряд: `1e16` — обычное конечное число, `Number.isFinite` его
    // пропускал, а `new Date(1e16)` вне диапазона и роняет `crashText`. Моя первая правка закрыла
    // только бесконечность, то есть половину границы.
    const s = memStore();
    s.data.set(CRASH_KEY, '{"at":10000000000000000,"message":"x"}');
    const r = readCrash(s);
    assert.equal(r?.at, 0);
    assert.doesNotThrow(() => crashText(r!));
  });

  it('крайнее ДОПУСТИМОЕ значение сохраняется как есть', () => {
    // Граница не должна съесть годные отметки: ±8 640 000 000 000 000 мс дата принимает.
    const s = memStore();
    s.data.set(CRASH_KEY, '{"at":8640000000000000,"message":"x"}');
    assert.equal(readCrash(s)?.at, 8_640_000_000_000_000);
  });

  it('отрицательная граница симметрична, а один шаг наружу уже негоден', () => {
    // Ловит одностороннюю проверку и off-by-one ровно на реальном пределе диапазона Date.
    const s = memStore();
    s.data.set(CRASH_KEY, '{"at":-8640000000000000,"message":"x"}');
    assert.equal(readCrash(s)?.at, -8_640_000_000_000_000);
    s.data.set(CRASH_KEY, '{"at":8640000000000001,"message":"x"}');
    assert.equal(readCrash(s)?.at, 0);
    s.data.set(CRASH_KEY, '{"at":-8640000000000001,"message":"x"}');
    assert.equal(readCrash(s)?.at, 0);
  });
});

describe('🔴 отдать отчёт человеку: скопировать и забыть', () => {
  const report = { at: 1_700_000_000_000, message: 'бум', stack: '', component: '', ua: 'UA' };

  it('успешное копирование забирает запись', async () => {
    // Мутация: убрать `io.clear()` → падает `cleared`.
    let text = '';
    let cleared = false;
    const ok = await copySavedCrash(report, {
      writeText: async (t) => {
        text = t;
      },
      clear: () => {
        cleared = true;
      },
    });
    assert.equal(ok, true);
    assert.match(text, /бум/, 'в буфер уехал сам отчёт');
    assert.equal(cleared, true);
  });

  it('🔴 отказ буфера обмена НЕ стирает отчёт', async () => {
    // Буфер отказывает буднично — окно без фокуса, нет разрешения. Потерять из-за этого
    // единственную улику нельзя: человеку тогда нечего будет прислать.
    let cleared = false;
    const ok = await copySavedCrash(report, {
      writeText: async () => {
        throw new Error('нет доступа к буферу');
      },
      clear: () => {
        cleared = true;
      },
    });
    assert.equal(ok, false);
    assert.equal(cleared, false, 'отчёт остался на месте');
  });
});
