import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { parseTypingAction, typingActionField, typingActionRank, typingActionFor, typingActionToServer, uploadTypingAction } from './typingAction';

it('кружок сохраняет ранг записи и передаётся только понимающему соединению или серверу', () => {
  assert.equal(parseTypingAction('round'), 'round');
  assert.equal(typingActionRank('round'), 3);
  assert.equal(typingActionRank('round'), typingActionRank('voice'));
  assert.deepEqual(typingActionField('round'), { action: 'round' });
  for (const caps of [undefined, new Set<string>(), new Set(['typing1']), new Set(['typing2'])]) {
    assert.equal(typingActionFor('round', caps), caps?.has('typing2') ? 'round' : 'voice');
    for (const action of ['typing', 'voice', 'voice_upload', 'sticker', 'photo', 'video', 'file'] as const) assert.equal(typingActionFor(action, caps), action);
  }
  for (const features of [undefined, null, [], ['typing1'], ['typing2'], ['other', 'typing2']]) {
    assert.equal(typingActionToServer('round', features), features?.includes('typing2') ? 'round' : 'voice');
    assert.equal(typingActionToServer('voice_upload', features), 'voice_upload');
  }
  const source = readFileSync(new URL('./typingAction.ts', import.meta.url), 'utf8');
  const check = (api: typeof import('./typingAction')) => {
    assert.equal(api.typingActionRank('round'), 3);
    assert.equal(api.typingActionFor('round', new Set()), 'voice');
    assert.equal(api.typingActionFor('round', new Set(['typing2'])), 'round');
    assert.equal(api.typingActionToServer('round', []), 'voice');
    assert.equal(api.typingActionToServer('round', ['typing2']), 'round');
  };
  const load = (s: string) => {
    const module = { exports: {} as typeof import('./typingAction') };
    runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
    return module.exports;
  };
  check(load(source));
  for (const [from, to] of [["if (action === 'round') return 3", "if (action === 'round') return 2"], ["!caps?.has(FEATURE_TYPING2)", 'false'], ["!features?.includes(FEATURE_TYPING2)", 'false']]) {
    assert.ok(source.includes(from));
    assert.throws(() => check(load(source.replace(from, to))), assert.AssertionError);
  }
});

describe('вид действия в кадре typing', () => {
  it('неизвестные значения остаются обычным набором', () => {
    // Неизвестная строка с соседнего сервера не должна протащить новый тип в интерфейс или протокол.
    for (const raw of ['voice', 'voice_upload', 'photo', 'video', 'file', 'typing', 'sticker']) assert.equal(parseTypingAction(raw), raw);
    for (const raw of [undefined, null, 7, '', 'bogus', '__proto__']) assert.equal(parseTypingAction(raw), 'typing');
  });

  it('обычное «печатает» опускает поле, остальные виды несут своё значение', () => {
    // Старый клиент трактует отсутствие action как набор; явное action:'typing' ему незачем передавать.
    assert.deepEqual(typingActionField('typing'), {});
    for (const action of ['voice', 'voice_upload', 'photo', 'video', 'file', 'sticker'] as const) assert.deepEqual(typingActionField(action), { action });
  });

  it('запись сильнее отправки, отправка сильнее набора', () => {
    // Частое слабое событие не должно визуально перебивать живое голосовое или загрузку.
    assert.ok(typingActionRank('voice') > typingActionRank('file'), 'voice outranks uploads');
    assert.equal(typingActionRank('voice_upload'), typingActionRank('voice'));
    for (const action of ['photo', 'video', 'file'] as const) assert.ok(typingActionRank(action) > typingActionRank('typing'), `${action} outranks typing`);
    assert.equal(new Set((['photo', 'video', 'file'] as const).map(typingActionRank)).size, 1, 'все виды загрузки равны по рангу');
  });

  it('загрузка обозначается по всем MIME, пустая очередь не создаёт действия', () => {
    // При смешанном наборе вложений обещать «фото» или «видео» было бы неверно.
    assert.equal(uploadTypingAction([]), null);
    assert.equal(uploadTypingAction(['image/png', 'image/jpeg']), 'photo');
    assert.equal(uploadTypingAction(['video/mp4', 'video/webm']), 'video');
    for (const mimes of [['image/png', 'video/mp4'], ['application/pdf'], ['audio/ogg'], ['']]) {
      assert.equal(uploadTypingAction(mimes), 'file', `${mimes.join(',') || 'empty'} is a generic file upload`);
    }
  });

  it('контракт отсекает мутации whitelist, legacy-поля и порядка рангов', () => {
    // Неизвестный сигнал приходит от старого/будущего клиента, а явный typing нарушает wire-совместимость.
    const source = readFileSync(fileURLToPath(new URL('./typingAction.ts', import.meta.url)), 'utf8');
    const load = (code: string) => {
      const module = { exports: {} as Record<string, unknown> };
      runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
      return module.exports as typeof import('./typingAction');
    };
    const assertRejected = (code: string, check: (api: typeof import('./typingAction')) => void, message: string) => {
      const api = load(code);
      assert.throws(() => check(api), assert.AssertionError, message);
    };

    const membershipMutant = source.replace("(TYPING_ACTIONS as readonly string[]).includes(raw) ? (raw as TypingAction) : 'typing'", "true ? (raw as TypingAction) : 'typing'");
    assert.notEqual(membershipMutant, source, 'мутант действительно убирает whitelist действий');
    assertRejected(membershipMutant, (api) => assert.equal(api.parseTypingAction('unexpected'), 'typing', 'неизвестное действие должно стать набором'), 'без whitelist неизвестное действие ломает fallback');

    const legacyMutant = source.replace("return action === 'typing' ? {} : { action };", 'return { action };');
    assert.notEqual(legacyMutant, source, 'мутант действительно добавляет action к legacy typing');
    assertRejected(legacyMutant, (api) => assert.deepEqual(api.typingActionField('typing'), {}, 'legacy typing не должен иметь action'), 'явное поле typing ломает старых клиентов');

    const rankMutant = source.replace("return action === 'voice' || action === 'voice_upload' ? 3 : action === 'typing' ? 1 : 2;", "return action === 'voice' || action === 'voice_upload' ? 1 : action === 'typing' ? 3 : 2;");
    assert.notEqual(rankMutant, source, 'мутант действительно меняет приоритет голоса и набора');
    assertRejected(rankMutant, (api) => assert.ok(api.typingActionRank('voice') > api.typingActionRank('typing'), 'голос должен быть выше набора'), 'перестановка рангов нарушает устойчивую подпись');
  });
});
