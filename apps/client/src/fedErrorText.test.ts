import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FED_ERRORS } from '@gusvoice/shared';
import { FED_DM_LINK_BROKEN, fedErrorText, isFedErrorCode, fedDmOpenText } from './fedErrorText.js';

it('R194 ожидающая копия объясняется с именем инстанса и без имени, неизвестный код не переводится', () => {
  // Класс ошибки: ожидающая копия выглядит потерянным файлом или сырым кодом.
  assert.equal(fedErrorText('federation.att_pending', 'Дом'), 'Файл ещё загружается с инстанса «Дом»');
  for (const name of [undefined, null, '']) assert.equal(fedErrorText('federation.att_pending', name), 'Файл ещё загружается с инстанса собеседника');
  assert.equal(fedErrorText('federation.att_future', 'Дом'), null);
});
it('R195 недоступная копия обещает появление после восстановления дома, не потерю файла', () => {
  // Класс ошибки: временно выключенный автор выглядит окончательной ошибкой скачивания.
  assert.equal(fedErrorText('federation.att_unavailable', 'Гусь'), 'Файл появится, когда «Гусь» снова будет на связи');
  for (const name of [undefined, null, '']) assert.equal(fedErrorText('federation.att_unavailable', name), 'Файл появится, когда инстанс собеседника снова будет на связи');
});

for (const [reason, expected] of [
  ['policy', 'Этот человек принимает сообщения с других инстансов только от людей с общих серверов.'],
  ['no_user', 'Этого человека нет на его инстансе.'],
  ['hidden', 'Этому человеку нельзя написать первым с другого инстанса.'],
  ['rate', 'Его инстанс не принимает больше новых переписок от вас в этот час — попробуйте позже.'],
] as const) it(`R189 отказ открытия ${reason} объясняется словами, без протокольного кода`, () => {
  // Класс ошибки: разные отказы открытия сливаются в общий тост, из которого не ясно, что делать.
  assert.equal(fedDmOpenText(FED_ERRORS.dmRefused, reason), expected);
});
it('R189 новая или отсутствующая причина отказа показывается как политика, не как раскрытая блокировка', () => {
  // Класс ошибки: новая причина обходит маскировку blocked либо превращается в техническую строку.
  const expected = fedDmOpenText(FED_ERRORS.dmRefused, 'policy');
  for (const reason of [undefined, null, '', 'future', 'blocked']) assert.equal(fedDmOpenText(FED_ERRORS.dmRefused, reason), expected);
});
it('R189 недоступность и старая версия соседа имеют разные объяснения с именем и без имени', () => {
  // Класс ошибки: временная недоступность обещает обновление или отсутствующее имя становится undefined.
  assert.match(fedDmOpenText(FED_ERRORS.dmRefused, 'no_user', 'Сосед')!, /нет на «Сосед»/);
  assert.match(fedDmOpenText(FED_ERRORS.dmRefused, 'rate', 'Сосед')!, /^«Сосед» не принимает/);
  for (const who of [null, undefined, 'Сосед']) {
    const unavailable = fedDmOpenText(FED_ERRORS.peerUnreachable, null, who)!;
    const unsupported = fedDmOpenText(FED_ERRORS.unsupported, null, who)!;
    assert.match(unavailable, /недоступен/); assert.match(unsupported, /новая версия/);
    for (const text of [unavailable, unsupported]) {
      assert.doesNotMatch(text, /undefined|null|federation\./);
      assert.equal(text.includes('«Сосед»'), !!who);
    }
  }
});
it('R189 прежние коды делегируются общему переводу, незнакомые коды не получают ложной причины', () => {
  // Класс ошибки: специальный перевод ЛС ломает прежние отказы федерации или придумывает новый диагноз.
  assert.equal(fedDmOpenText(FED_ERRORS.paused, 'rate', 'Сосед'), fedErrorText(FED_ERRORS.paused, 'Сосед'));
  assert.equal(fedDmOpenText('federation.future', 'policy'), null);
});

it('R190 вложения в переписке пока объясняются отдельно, неизвестный код остаётся без выдуманного текста', () => {
  // Класс ошибки: отказ вложения маскируется под общую недоступность или будущий код получает ложный диагноз.
  const text = fedDmOpenText(FED_ERRORS.dmAttachmentsLater, null);
  assert.equal(text, 'Файлы людям других инстансов можно будет отправлять в следующем обновлении. Текст доходит.');
  assert.equal(fedDmOpenText('federation.future_dm_error', null), null);
});

it('R206 ограничения группы объясняются с именем дома и без протокольных строк', () => {
  // Эти 403 относятся только к группам чужого дома: человеку важны недоступность или место смены фото, не имя кода API.
  const cases = [
    [FED_ERRORS.dmGroupHostDown, 'Дом соседа', 'Инстанс «Дом соседа», где живёт группа, недоступен — состав сейчас не меняется. Сообщения доедут, когда он вернётся'],
    [FED_ERRORS.dmGroupHostOnly, 'Дом соседа', 'Фото меняется на инстансе «Дом соседа»'],
  ] as const;
  for (const [code, who, named] of cases) {
    assert.equal(fedErrorText(code, who), named);
    const unnamed = fedErrorText(code);
    assert.notEqual(unnamed, null);
    assert.doesNotMatch(unnamed!, /federation\.|dm_group_host/);
    assert.doesNotMatch(unnamed!, /undefined|null/);
    assert.equal(unnamed!.includes(`«${who}»`), false);
  }
  assert.equal(fedErrorText(FED_ERRORS.dmGroupHostDown), 'Инстанс, где живёт группа, недоступен — состав сейчас не меняется. Сообщения доедут, когда он вернётся');
  assert.equal(fedErrorText(FED_ERRORS.dmGroupHostOnly), 'Фото меняется на инстансе, где живёт группа');
});

describe('человеческие тексты отказов федерации', () => {
  it('известный отказ переводится без протокольного кода', () => {
    // Ловит показ человеку внутренней строки federation.dm_unavailable.
    const text = fedErrorText(FED_ERRORS.dmUnavailable);
    assert.match(text!, /Личка между инстансами/);
    assert.doesNotMatch(text!, /federation\./);
  });

  it('имя инстанса включается только когда оно известно', () => {
    // Ловит затычку «undefined» и потерю полезного имени соседа.
    assert.match(fedErrorText(FED_ERRORS.noLink, 'Гуси')!, /«Гуси»/);
    assert.doesNotMatch(fedErrorText(FED_ERRORS.noLink, null)!, /undefined|null/);
  });

  it('неизвестный код от более нового соседа не получает выдуманной причины', () => {
    // Ловит ложное объяснение отказа при рассинхроне версий федерации.
    assert.equal(fedErrorText('federation.future_reason'), null);
  });

  it('распознаются только строгие протокольные коды federation с нижним регистром', () => {
    // Ловит перевод обычного текста или похожей строки как серверного кода.
    assert.equal(isFedErrorCode('federation.invite_invalid'), true);
    assert.equal(isFedErrorCode(' federation.invite_invalid'), false);
    assert.equal(isFedErrorCode('federation.InviteInvalid'), false);
    assert.equal(isFedErrorCode('error federation.invite_invalid'), false);
  });

  it('разорванная связка даёт тот же текст, что и архив беседы, а отказ вложений переводится', () => {
    // Класс ошибки: сообщение протокола или плашка архива расходятся в формулировке для одного отказа.
    assert.equal(fedErrorText(FED_DM_LINK_BROKEN, 'Утка'), 'Связь с инстансом «Утка» разорвана — переписка доступна только для чтения');
    assert.equal(fedErrorText(FED_DM_LINK_BROKEN), 'Связь с инстансом собеседника разорвана — переписка доступна только для чтения');
    const attachments = fedErrorText(FED_ERRORS.dmAttachmentsLater);
    assert.notEqual(attachments, null);
    assert.match(attachments!, /следующем обновлении/);
    assert.notEqual(attachments, FED_ERRORS.dmAttachmentsLater);
  });
});
