import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FED_ERRORS } from '@gusvoice/shared';
import { fedErrorText, isFedErrorCode } from './fedErrorText.js';

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
});
