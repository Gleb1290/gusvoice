import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as rules from './lastSeenRules.js';
const now = Date.UTC(2026, 9, 7, 12); const day = 86400000;
const side = (id: string) => ({ id, privacy: 'peers' as const, invisible: false, hideReadTime: false });

it('приватность взаимна: скрывший своё получает только категорию, invisible в ЛС не скрывает точное время', () => {
  // Ловит одностороннюю приватность и раскрытие невидимого по точному времени.
  const base = { subject: { ...side('s'), lastSeenAt: new Date(now - 1000) }, viewer: side('v'), isPeer: true, connected: false, now };
  const check = (view: typeof rules.lastSeenView) => {
    assert.equal(view(base).at, base.subject.lastSeenAt.toISOString());
    const hidden = view({ ...base, viewer: { ...base.viewer, privacy: 'nobody' } });
    assert.equal(hidden.at, null); assert.equal(hidden.byMe, true); assert.equal(hidden.exact, false);
    assert.equal(view({ ...base, subject: { ...base.subject, invisible: true } }).at, base.subject.lastSeenAt.toISOString());
    assert.equal(view({ ...base, isPeer: false }).at, null);
    assert.equal(view({ ...base, subject: { ...base.subject, privacy: 'everyone' }, viewer: { ...base.viewer, privacy: 'everyone' }, isPeer: false }).exact, true);
  }; check(rules.lastSeenView);
  const source = rules.lastSeenView.toString(); assert.ok(source.includes('theyShare&&iShare'));
  const bad = runInNewContext(`(${source.replace('theyShare&&iShare', 'theyShare')})`, { ...rules, __name: (f: unknown) => f }) as typeof rules.lastSeenView;
  assert.throws(() => check(bad), assert.AssertionError);
  const invisibleMutant = runInNewContext(`(${source.replace(/sharesLastSeen\(subject\.privacy,\s*false,/, 'sharesLastSeen(subject.privacy,subject.invisible,')})`, rules) as typeof rules.lastSeenView;
  assert.throws(() => check(invisibleMutant), assert.AssertionError);
  assert.equal(rules.sharesLastSeen('everyone', true, true), false);
  const share = rules.sharesLastSeen.toString(); assert.ok(share.includes('if(invisible)return false;'));
  const leak = runInNewContext(`(${share.replace('if(invisible)return false;', '')})`) as typeof rules.sharesLastSeen;
  assert.throws(() => assert.equal(leak('everyone', true, true), false), assert.AssertionError);
});
it('категории включают ровно 3, 7 и 30 суток, следующая миллисекунда меняет категорию', () => {
  // Ловит ошибки включённости границ скрытого времени.
  for (const [age, expected] of [[3*day, 'recently'], [3*day+1, 'week'], [7*day, 'week'], [7*day+1, 'month'], [30*day, 'month'], [30*day+1, 'long']] as const) {
    assert.equal(rules.approxOf(new Date(now-age), now), expected);
  }
  assert.equal(rules.approxOf(null, now), 'long');
  assert.equal(rules.approxOf(new Date(now+1), now), 'recently');
  for (const raw of [null, '', 'garbage', 1]) assert.equal(rules.normalizeLastSeenPrivacy(raw), 'peers');
  for (const raw of ['everyone', 'peers', 'nobody']) assert.equal(rules.normalizeLastSeenPrivacy(raw), raw);
  for (const [constant, days, expected] of [['RECENTLY_MS',3,'recently'], ['WEEK_MS',7,'week'], ['MONTH_MS',30,'month']] as const) {
    const source = rules.approxOf.toString(); assert.ok(source.includes(`<=${constant}`));
    const bad = runInNewContext(`(${source.replace(`<=${constant}`, `<${constant}`)})`, rules) as typeof rules.approxOf;
    assert.throws(() => assert.equal(bad(new Date(now-days*day), now), expected), assert.AssertionError);
  }
});
it('онлайн видят только свои и соседи, невидимый сам видит своё время, посторонний — только недавно', () => {
  // Ловит утечку живой зелёной точки через приватность REST.
  const base = { subject: { ...side('s'), lastSeenAt: new Date(now) }, viewer: side('v'), isPeer: true, connected: true, now };
  assert.equal(rules.lastSeenView(base).online, true);
  assert.equal(rules.lastSeenView({ ...base, isPeer: false }).online, false);
  assert.equal(rules.lastSeenView({ ...base, subject: { ...base.subject, invisible: true } }).approx, 'recently');
  const own = rules.lastSeenView({ ...base, viewer: side('s'), subject: { ...base.subject, invisible: true } });
  assert.equal(own.online, true); assert.equal(own.exact, true); assert.equal(own.at, base.subject.lastSeenAt.toISOString());
});
it('время прочтения скрывается любой стороной, семь суток ровно уже истекают, непрочитанное не получает время', () => {
  // Ловит потерю взаимности прочтения и сохранение истёкшей точной даты.
  const a = { ...side('a'), privacy: 'nobody' as const, hideReadTime: true }; const b = side('b');
  assert.equal(rules.readTimeHidden(a, b, true), true); assert.equal(rules.readTimeHidden(b, a, true), true);
  assert.equal(rules.readTimeHidden({ ...a, hideReadTime: false }, b, true), false);
  assert.equal(rules.readTimeHidden({ ...a, privacy: 'peers' }, b, true), false);
  const base = { read: true, readAt: new Date(now-1), createdAt: new Date(now-7*day+1), hidden: false, now };
  assert.equal(rules.readAtView(base).at, base.readAt.toISOString());
  assert.deepEqual(rules.readAtView({ ...base, createdAt: new Date(now-7*day) }), { read: true, at: null, hidden: false });
  assert.deepEqual(rules.readAtView({ ...base, hidden: true }), { read: true, at: null, hidden: true });
  assert.deepEqual(rules.readAtView({ ...base, read: false }), { read: false, at: null, hidden: false });
  const hiddenSource = rules.readTimeHidden.toString(); assert.ok(hiddenSource.includes('peerHides||iHide'));
  for (const surviving of ['peerHides', 'iHide']) {
    const bad = runInNewContext(`(${hiddenSource.replace('peerHides||iHide', surviving)})`, rules) as typeof rules.readTimeHidden;
    assert.throws(() => { assert.equal(bad(a,b,true),true); assert.equal(bad(b,a,true),true); }, assert.AssertionError);
  }
  const view = rules.readAtView.toString(); assert.ok(view.includes('>=READ_DATE_EXPIRE_MS'));
  const bad = runInNewContext(`(${view.replace('>=READ_DATE_EXPIRE_MS','>READ_DATE_EXPIRE_MS')})`, rules) as typeof rules.readAtView;
  assert.throws(() => assert.equal(bad({ ...base, createdAt: new Date(now-7*day) }).at, null), assert.AssertionError);
});

it('исключения личные, взаимные и «никогда» сильнее «всегда» даже при пересечении списков', () => {
  // Ошибка здесь либо раскрывает время не тому человеку, либо ломает действие взаимной приватности.
  const privacies = ['everyone', 'peers', 'nobody'] as const;
  const exceptions = [null, 'always', 'never'] as const;
  for (const privacy of privacies) for (const isPeer of [false, true]) for (const exception of exceptions) {
    const expected = exception === 'never' ? false : exception === 'always' ? true : privacy === 'everyone' || (privacy === 'peers' && isPeer);
    assert.equal(rules.sharesLastSeen(privacy, false, isPeer, exception), expected, `${privacy}/${isPeer}/${exception}`);
  }
  for (const privacy of privacies) for (const isPeer of [false, true]) for (const exception of exceptions) {
    assert.equal(rules.sharesLastSeen(privacy, true, isPeer, exception), false, `низкоуровневый invisible-флаг остаётся совместимым; DM передаёт false`);
  }
  const intersection = { always: new Set(['viewer']), never: new Set(['viewer']) };
  assert.equal(rules.exceptionOf({ exceptions: intersection }, 'viewer'), 'never');
  const exceptionSource = rules.exceptionOf.toString();
  const wrongPriority = runInNewContext(`(${exceptionSource.replace(
    'if(side.exceptions?.never.has(otherId))return"never";if(side.exceptions?.always.has(otherId))return"always";',
    'if(side.exceptions?.always.has(otherId))return"always";if(side.exceptions?.never.has(otherId))return"never";',
  )})`) as typeof rules.exceptionOf;
  assert.throws(() => assert.equal(wrongPriority({ exceptions: intersection }, 'viewer'), 'never'), assert.AssertionError);

  const at = new Date(now - 1_000);
  const subject = { ...side('subject'), privacy: 'nobody' as const, lastSeenAt: at, exceptions: { always: new Set(['viewer']), never: new Set<string>() } };
  const viewer = { ...side('viewer'), privacy: 'nobody' as const, exceptions: { always: new Set(['subject']), never: new Set<string>() } };
  const input = { subject, viewer, isPeer: false, connected: false, now };
  assert.equal(rules.lastSeenView(input).exact, true, '«всегда» хозяина для viewer действует при nobody');
  const viewSource = rules.lastSeenView.toString();
  const wrongViewerId = runInNewContext(`(${viewSource.replace('exceptionOf(subject,viewer.id)', 'exceptionOf(subject,subject.id)')})`, rules) as typeof rules.lastSeenView;
  assert.throws(() => assert.equal(wrongViewerId(input).exact, true), assert.AssertionError);
  const wrongOwnerId = runInNewContext(`(${viewSource.replace('exceptionOf(viewer,subject.id)', 'exceptionOf(viewer,viewer.id)')})`, rules) as typeof rules.lastSeenView;
  assert.throws(() => assert.equal(wrongOwnerId(input).exact, true), assert.AssertionError);

  const me = { ...side('me'), privacy: 'nobody' as const, invisible: false, hideReadTime: true, exceptions: { always: new Set(['peer']), never: new Set<string>() } };
  const peer = { ...side('peer'), privacy: 'nobody' as const, invisible: false, hideReadTime: true, exceptions: { always: new Set(['me']), never: new Set<string>() } };
  assert.equal(rules.readTimeHidden(me, peer, false), false, 'исключения always обеих сторон снимают взаимное скрытие времени прочтения');
  const readSource = rules.readTimeHidden.toString();
  const withoutExceptions = runInNewContext(`(${readSource.replace('exceptionOf(peer,me.id)', 'null').replace('exceptionOf(me,peer.id)', 'null')})`, rules) as typeof rules.readTimeHidden;
  assert.throws(() => assert.equal(withoutExceptions(me, peer, false), false), assert.AssertionError);
});
