import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import ts from 'typescript';

const source = readFileSync(new URL('./VoiceConnection.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const prefix = 'R345 микрофон:';
const audioPrefix = 'R345 browser audio:';

function descendants<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (child: ts.Node) => { if (predicate(child)) result.push(child); ts.forEachChild(child, visit); };
  visit(node); return result;
}
function ast(raw: string) { return ts.createSourceFile('VoiceConnection.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function named(file: ts.SourceFile, name: string) {
  const found = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
  assert.equal(found.length, 1, `R345 setup: одна целая функция ${name}`);
  assert.ok(found[0].body); return found[0];
}
function vm(program: string, globals: Record<string, unknown>) {
  // Компилируются ЦЕЛЫЕ AST-функция/вызов useEffect, а не тело, вырезанное regexp/eval.
  const module = { exports: {} as Record<string, any> };
  const compiled = ts.transpileModule(program, { fileName: 'voice-browser-fixture.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } });
  runInNewContext(compiled.outputText, { module, exports: module.exports, Error, ...globals }, { timeout: 2000 });
  return module.exports;
}
function mic(raw = source, tauri = false) {
  const file = ast(raw), fn = named(file, 'micFailToast');
  const component = named(file, 'VoiceConnection');
  assert.ok(descendants(component, ts.isCallExpression).some(call => ts.isIdentifier(call.expression)
    && call.expression.text === 'micFailToast'), 'R345 setup: настоящий компонент вызывает этот обработчик ошибок');
  const calls: { error: unknown; title: string }[] = [];
  const loaded = vm(`${fn.getText(file)}\nexports.mic = micFailToast;`, {
    isTauri: () => tauri,
    toastError: (error: unknown, title: string) => calls.push({ error, title }),
  });
  return { invoke: (error: unknown) => loaded.mic(error), calls };
}
type Edit = readonly [from: string, to: string];
function changed(raw: string, [from, to]: Edit) {
  assert.equal(raw.split(from).length - 1, 1, 'R345 setup: контрфакт адресует ровно один якорь');
  const next = raw.replace(from, to); assert.notEqual(next, raw); return next;
}
async function proof(check: (raw: string) => void | Promise<void>, edits: Edit[], messagePrefix: string) {
  await check(source);
  for (const edit of edits) {
    await counterfact(async () => {
      await assert.rejects(async () => check(changed(source, edit)), error => error instanceof assert.AssertionError
        && error.message.startsWith(messagePrefix));
    });
    await check(source);
  }
}
const permission = "if (name === 'NotAllowedError' || name === 'SecurityError')";
const missing = "if (name === 'NotFoundError' || name === 'OverconstrainedError')";

it('R345 отказ браузера направляет к разрешению сайта, а не к модератору', async () => {
  // Одинаковое «нет прав» из браузера и от SFU требует разных действий пользователя.
  await proof(raw => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      const h = mic(raw), input = { name, message: 'Permission denied' };
      h.invoke(input);
      assert.equal(h.calls.length, 1, `${prefix} один тост отказа браузера`);
      assert.equal(h.calls[0].title, 'Нет доступа к микрофону', `${prefix} заголовок разрешения сайта`);
      assert.ok(h.calls[0].error instanceof Error, `${prefix} ошибка содержит инструкцию, а не сырой DOMException`);
      const text = (h.calls[0].error as Error).message;
      assert.match(text, /значок слева от адреса.*Микрофон/, `${prefix} путь к разрешению сайта`);
      assert.doesNotMatch(`${h.calls[0].title} ${text}`, /модератор/i, `${prefix} браузер не обвиняет модератора`);
    }
  }, [[permission, 'if (false)']], prefix);
});

it('R345 отказ микрофона в Tauri отправляет в настройки системы, не к значку сайта', async () => {
  await proof(raw => {
    for (const tauri of [false, true]) {
      const h = mic(raw, tauri); h.invoke({ name: 'NotAllowedError' });
      assert.equal(h.calls[0].title, 'Нет доступа к микрофону', `${prefix} тот же класс отказа в оболочке`);
      const text = (h.calls[0].error as Error).message;
      assert.equal(text.includes('настройках системы'), tauri, `${prefix} инструкция выбирает платформу`);
      assert.equal(text.includes('значок слева от адреса'), !tauri, `${prefix} инструкция сайта только вне оболочки`);
    }
  }, [["isTauri()\n          ? 'Разрешите", "false\n          ? 'Разрешите"]], prefix);
});

it('R345 серверный запрет публикации 403 оставляет объяснение о праве говорить', async () => {
  await proof(raw => {
    for (const input of [{ name: 'PublishTrackError', status: 403 }, { name: 'PublishTrackError' }, { status: 403 }]) {
      const h = mic(raw); h.invoke(input);
      assert.equal(h.calls.length, 1, `${prefix} один тост серверного отказа`);
      assert.equal(h.calls[0].error, input, `${prefix} исходная серверная причина сохранена`);
      assert.match(h.calls[0].title, /нет права говорить.*модератор/, `${prefix} модератор только в серверной ветке`);
    }
  }, [["if (name === 'PublishTrackError' || (e as { status?: number } | null)?.status === 403)", 'if (false)']], prefix);
});

it('R345 отсутствующий или неподходящий микрофон предлагает подключить либо сменить устройство', async () => {
  await proof(raw => {
    for (const name of ['NotFoundError', 'OverconstrainedError']) {
      const h = mic(raw); h.invoke({ name });
      assert.equal(h.calls.length, 1, `${prefix} один тост устройства`);
      assert.equal(h.calls[0].title, 'Микрофон не найден', `${prefix} устройство отличается от запрета`);
      assert.match((h.calls[0].error as Error).message, /Подключите микрофон.*выберите другой/, `${prefix} подсказка устройства`);
    }
  }, [[missing, 'if (false)']], prefix);
});

it('R345 неизвестная и пустая ошибка не выдумывает запрет или отсутствие микрофона', async () => {
  await proof(raw => {
    for (const input of [undefined, null, {}, { name: 'AbortError' }, new Error('temporary')]) {
      const h = mic(raw); h.invoke(input);
      assert.equal(h.calls.length, 1, `${prefix} неизвестная причина тоже сообщается один раз`);
      assert.equal(h.calls[0].error, input, `${prefix} неизвестная причина не теряется`);
      assert.equal(h.calls[0].title, 'Микрофон недоступен', `${prefix} нейтральный fallback`);
    }
  }, [["  toastError(e, 'Микрофон недоступен');", "  toastError(e, 'Нет доступа к микрофону');"]], prefix);
});

function audioEffect(raw: string) {
  const file = ast(raw), component = named(file, 'VoiceConnection');
  const effects = descendants(component, ts.isCallExpression).filter(call => ts.isIdentifier(call.expression)
    && call.expression.text === 'useEffect' && call.arguments[0]
    && descendants(call.arguments[0], ts.isPropertyAccessExpression).some(prop => prop.name.text === 'startAudio'));
  assert.equal(effects.length, 1, 'R345 setup: выбран целый эффект разблокировки startAudio, не соседний audio-context');
  return { file, effect: effects[0] };
}
function audio(raw = source, tauri = false, ready = false) {
  const { file, effect } = audioEffect(raw);
  const win = new Window(), doc = win.document;
  const listeners: { type: string; callback: EventListener; capture: boolean; active: boolean }[] = [];
  // Реальный DOM доставляет события; эта запись лишь позволяет проверить симметричное снятие слушателей.
  const documentIo = {
    addEventListener(type: string, callback: EventListener, capture = false) {
      listeners.push({ type, callback, capture, active: true });
      doc.addEventListener(type, callback as any, capture);
    },
    removeEventListener(type: string, callback: EventListener, capture = false) {
      for (const l of listeners) if (l.type === type && l.callback === callback && l.capture === capture) l.active = false;
      // happy-dom типизирует removeEventListener двумя аргументами; DOM callback идентичен capture-регистрации.
      (doc.removeEventListener as (...args: any[]) => void)(type, callback, capture);
    },
  };
  const calls: string[] = [];
  const room = { canPlaybackAudio: ready, startAudio: () => {
    calls.push('start');
    // Контролируемая IO-граница Promise: потеря catch выявляется assertion, не unhandledRejection.
    return { catch: (handler: (error: unknown) => void) => { calls.push('catch'); handler(new Error('blocked')); return Promise.resolve(); } };
  } };
  let dispose: (() => void) | undefined;
  let dependencies: unknown;
  vm(effect.getText(file), { document: documentIo, room, isTauri: () => tauri,
    useEffect: (body: () => (() => void) | undefined, deps: unknown) => { dependencies = deps; dispose = body(); } });
  return {
    calls, listeners, room, dependencies,
    pointer: () => doc.dispatchEvent(new win.Event('pointerdown', { bubbles: true })),
    key: () => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    cleanup: () => dispose?.(), close: () => { dispose?.(); void win.happyDOM.close(); },
  };
}
function audioChanged(raw: string, edit: Edit): string {
  const { file, effect } = audioEffect(raw), before = effect.getText(file), after = changed(before, edit);
  return raw.slice(0, effect.getStart(file)) + after + raw.slice(effect.getEnd());
}
async function audioProof(check: (raw: string) => void, edits: Edit[]) {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      assert.throws(() => check(audioChanged(source, edit)), error => error instanceof assert.AssertionError
        && error.message.startsWith(audioPrefix));
    });
    check(source);
  }
}

it('R345 касание в браузере разблокирует восстановленный голос, но сам mount не включает звук', async () => {
  await audioProof(raw => {
    const h = audio(raw);
    try {
      assert.equal(h.calls.length, 0, `${audioPrefix} до жеста нет startAudio`);
      h.pointer();
      assert.deepEqual(h.calls, ['start', 'catch'], `${audioPrefix} pointerdown вызывает настоящий startAudio`);
      assert.equal(h.listeners.find(l => l.type === 'pointerdown')?.capture, true, `${audioPrefix} касание ловится до дочерних обработчиков`);
    } finally { h.close(); }
  }, [["document.addEventListener('pointerdown', unlock, true);", "document.addEventListener('pointerup', unlock, true);"]]);
});

it('R345 готовый звук не перезапускается, а Tauri вообще не ставит браузерные слушатели', async () => {
  await audioProof(raw => {
    for (const [tauri, ready] of [[false, true], [true, false], [true, true]]) {
      const h = audio(raw, tauri, ready);
      try {
        h.pointer(); h.key();
        assert.equal(h.calls.length, 0, `${audioPrefix} рабочее аудио и оболочка не требуют разблокировки`);
        if (tauri) assert.equal(h.listeners.length, 0, `${audioPrefix} Tauri не слушает жесты браузера`);
      } finally { h.close(); }
    }
  }, [['if (isTauri()) return;', 'if (false) return;'],
    ['if (!room.canPlaybackAudio)', 'if (true)']]);
});

it('R345 клавиша тоже разблокирует звук и отказ startAudio явно поглощён', async () => {
  await audioProof(raw => {
    const h = audio(raw);
    try {
      h.key();
      assert.deepEqual(h.calls, ['start', 'catch'], `${audioPrefix} клавиша и обработчик отказа сохранены`);
    } finally { h.close(); }
  }, [["document.addEventListener('keydown', unlock, true);", "document.addEventListener('keyup', unlock, true);"],
    ['void room.startAudio().catch(() => {});', 'void room.startAudio();']]);
});

it('R345 уход из комнаты снимает оба слушателя и эффект привязан к текущей комнате', async () => {
  await audioProof(raw => {
    const h = audio(raw);
    try {
      assert.equal(Array.isArray(h.dependencies) && h.dependencies.length, 1, `${audioPrefix} одна зависимость комнаты`);
      assert.equal((h.dependencies as unknown[])[0], h.room, `${audioPrefix} зависимость не от старой комнаты`);
      h.pointer(); h.cleanup(); h.pointer(); h.key();
      assert.deepEqual(h.calls, ['start', 'catch'], `${audioPrefix} закрытая комната больше не получает жесты`);
      assert.equal(h.listeners.filter(l => l.active).length, 0, `${audioPrefix} сняты оба capture-слушателя`);
    } finally { h.close(); }
  }, [["document.removeEventListener('pointerdown', unlock, true);", 'void unlock;'],
    ["document.removeEventListener('keydown', unlock, true);", 'void unlock;'], ['}, [room])', '}, [])']]);
});
