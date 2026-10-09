import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { cleanReportComment, DM_REPORT_COMMENT_MAX, DM_REPORT_EVIDENCE_MAX, DM_REPORT_TEXT_MAX, evidenceFrom, isDmReportReason } from './strangerRules.js';

const msg = (id: string, content: string, attachmentCount = 0) => ({ id, content, attachmentCount, at: new Date(`2026-10-08T12:00:${id.padStart(2, '0')}Z`) });

it('улики берутся только из пяти последних и отдаются от старых к новым', () => {
  // Порядок и предел важны: жалоба должна объяснять последние действия, а не включать произвольную историю.
  const messages = Array.from({ length: 7 }, (_, i) => msg(String(7 - i), `сообщение-${7 - i}`));
  const expected = '3,4,5,6,7';
  const check = (fn: typeof evidenceFrom) => assert.equal(fn(messages).map((row) => row.messageId).join(','), expected);
  check(evidenceFrom);
  const source = evidenceFrom.toString();
  assert.ok(source.includes('DM_REPORT_EVIDENCE_MAX'));
  const globals = { DM_REPORT_EVIDENCE_MAX, DM_REPORT_TEXT_MAX };
  const noReverse = runInNewContext(`(${source.replace('out.reverse()', 'out')})`, globals) as typeof evidenceFrom;
  assert.throws(() => check(noReverse), assert.AssertionError);
  const six = runInNewContext(`(${source})`, { ...globals, DM_REPORT_EVIDENCE_MAX: 6 }) as typeof evidenceFrom;
  assert.throws(() => check(six), assert.AssertionError, 'шестая улика нарушает контракт ровно пяти последних');
});

it('пустые сообщения пропускаются, вложение становится пометкой, длинный текст ограничен', () => {
  const long = 'я'.repeat(DM_REPORT_TEXT_MAX + 1);
  const messages = [msg('4', long), msg('3', '', 1), msg('2', '  '), msg('1', 'текст')];
  const expected = ['текст', '[вложение]', 'я'.repeat(DM_REPORT_TEXT_MAX)].join('|');
  const check = (fn: typeof evidenceFrom) => assert.equal(fn(messages).map((row) => row.text).join('|'), expected);
  check(evidenceFrom);
  const longer = runInNewContext(`(${evidenceFrom.toString()})`, { DM_REPORT_EVIDENCE_MAX, DM_REPORT_TEXT_MAX: DM_REPORT_TEXT_MAX + 1 }) as typeof evidenceFrom;
  assert.throws(() => check(longer), assert.AssertionError, 'улика длиннее 500 символов теряет нужный контекст');
});

it('комментарий очищает края, ровно 512 символов сохраняет, следующий обрезается', () => {
  assert.equal(cleanReportComment(null), null);
  assert.equal(cleanReportComment('   '), null);
  assert.equal(cleanReportComment(42), null);
  assert.equal(cleanReportComment('  по делу  '), 'по делу');
  const value = 'x'.repeat(DM_REPORT_COMMENT_MAX + 1);
  const check = (fn: typeof cleanReportComment) => assert.equal(fn(value)?.length, DM_REPORT_COMMENT_MAX);
  check(cleanReportComment);
  const source = cleanReportComment.toString();
  const mutant = runInNewContext(`(${source.replace('DM_REPORT_COMMENT_MAX', '2000')})`, { DM_REPORT_COMMENT_MAX: 2000 }) as typeof cleanReportComment;
  assert.throws(() => check(mutant), assert.AssertionError);
});

it('принимает только публичные причины жалобы', () => {
  assert.equal(isDmReportReason('spam'), true);
  assert.equal(isDmReportReason('violence'), true);
  assert.equal(isDmReportReason('unknown'), false);
  assert.equal(isDmReportReason(null), false);
  assert.equal(isDmReportReason({}), false);
});
