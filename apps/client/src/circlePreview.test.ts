import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as imageSize from './imageSize';
import * as bubble from './bubbleRules';
import * as row from './dmRowRules';

const round = { id: 'round', url: '/round', contentType: 'video/webm', name: 'round.webm', width: 384, height: 384, durationMs: 5000, round: true };

it('одиночный кружок без подписи — безрамочный, подпись возвращает обычный медиа-пузырь', () => {
  const look = (bubbleLook: typeof bubble.bubbleLook, content = '') => bubbleLook({ content, attachments: [round] } as never, 400, 300);
  assert.equal(look(bubble.bubbleLook).kind, 'sticker');
  assert.equal(look(bubble.bubbleLook, 'подпись').kind, 'media');
  const source = readFileSync(new URL('./bubbleRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const branch = "if (atts.length === 1 && a?.round === true && a.contentType.startsWith('video/') && !m.content && !framed) {\n    return { kind: 'sticker', jumbo: 0, mediaWidth: null };";
  assert.ok(source.includes(branch), 'в пузыре есть отдельное правило круга');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(branch, "if (false) {\n    return { kind: 'sticker', jumbo: 0, mediaWidth: null };"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => id === '@gusvoice/shared' ? shared : id === './imageSize' ? imageSize : null });
  const mutant = module.exports as typeof bubble;
  assert.throws(() => assert.equal(look(mutant.bubbleLook).kind, 'sticker'), assert.AssertionError,
    'мутант возвращает кругу обычную рамку изображения вместо безрамочного вида');
});

it('кружок сохраняет attachmentRound от вложения до превью строки и уведомления', () => {
  const fields = row.attachmentPreviewOf([round]);
  assert.deepEqual(fields, { attachmentKind: 'file', attachmentName: 'round.webm', attachmentVideo: true, attachmentDurationMs: 5000, attachmentRound: true });
  assert.deepEqual(row.dmAttachmentPreview({ text: '', attachments: 1, ...fields }), { icon: 'camera', label: 'Видеосообщение' });
  assert.equal(row.dmAttachmentPreview({ text: '', attachments: 1, attachmentKind: 'file', attachmentRound: true, attachmentOnce: true })?.label,
    'Одноразовое видеосообщение');
  assert.equal(row.messageAttachmentLabel({ attachments: [round] }), 'Видеосообщение');

  const source = readFileSync(new URL('./dmRowRules.ts', import.meta.url), 'utf8');
  const roundBranch = 'first.round === true ? ({ attachmentRound: true } as const) : {}';
  assert.ok(source.includes(roundBranch), 'найдено сохранение признака кружка для строки');
  const load = (code: string) => {
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, require: (id: string) => id === '@gusvoice/shared' ? shared : id === './bubbleRules' ? bubble : {} });
    return module.exports as typeof row;
  };
  const vmRules = load(source);
  assert.equal(vmRules.dmAttachmentPreview({ text: '', attachments: 1, ...vmRules.attachmentPreviewOf([round]) })?.label, 'Видеосообщение',
    'неизменённый модуль в VM сохраняет ту же подпись без длительности');
  const mutantSource = source.replace(roundBranch, 'first.round === true ? ({} as const) : {}');
  assert.notEqual(mutantSource, source, 'мутант действительно удаляет round-признак');
  const mutant = load(mutantSource);
  assert.throws(() => assert.equal(mutant.dmAttachmentPreview({ text: '', attachments: 1, ...mutant.attachmentPreviewOf([round]) })?.label,
    'Видеосообщение'), assert.AssertionError, 'мутант теряет метку кружка и подписывает его как обычное видео');
});
