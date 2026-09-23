import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, gigabytesToBytes } from './byteSize.js';

describe('размеры хранилища', () => {
  it('ступени считаются двоичными и ровная граница переходит в следующую единицу', () => {
    // Ловит расхождение подписи квоты с байтами, которые реально сравнивает база.
    assert.equal(formatBytes(1023), '1023 Б');
    assert.equal(formatBytes(1024), '1 КБ');
    assert.equal(formatBytes(1024 ** 3), '1 ГБ');
  });

  it('дробь показывается у малых значений ступени, а крупные округляются целиком', () => {
    // Ловит шумные десятичные хвосты и непонятную подпись большого лимита.
    assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 ГБ');
    assert.equal(formatBytes(10.6 * 1024 ** 3), '11 ГБ');
  });

  it('отрицательные и дробные байты безопасно приводятся к неотрицательному целому', () => {
    // Ловит показ невозможного отрицательного остатка квоты.
    assert.equal(formatBytes(-10), '0 Б');
    assert.equal(formatBytes(12.9), '12 Б');
  });

  it('поле гигабайтов принимает точку и запятую, но отвергает пустоту и мусор', () => {
    // Ловит изменение квоты на ноль из-за пустого либо неразобранного поля.
    assert.equal(gigabytesToBytes('1.5'), 1.5 * 1024 ** 3);
    assert.equal(gigabytesToBytes('1,5'), 1.5 * 1024 ** 3);
    assert.equal(gigabytesToBytes(''), null);
    assert.equal(gigabytesToBytes('-1'), null);
    assert.equal(gigabytesToBytes('много'), null);
  });
});
