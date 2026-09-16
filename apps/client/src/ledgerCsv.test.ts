import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ledgerCsv, ledgerFileName } from './ledgerCsv.js';

const row = (over: Partial<Parameters<typeof ledgerCsv>[0][number]> = {}) => ({
  at: '03.09.2026, 12:30',
  what: 'За время в голосовом канале',
  amount: 16,
  detail: '',
  ...over,
});

describe('выгрузка журнала', () => {
  it('первым символом BOM — иначе русский Excel покажет кракозябры', () => {
    assert.equal(ledgerCsv([], 'ГусКоины').charCodeAt(0), 0xfeff);
  });

  it('разделитель — точка с запятой: с запятой русский Excel сваливает всё в один столбец', () => {
    const out = ledgerCsv([row()], 'ГусКоины');
    assert.ok(out.includes('03.09.2026, 12:30;За время в голосовом канале;16;'));
  });

  it('заголовок суммы несёт название валюты сервера', () => {
    assert.ok(ledgerCsv([], 'Гусики').includes('Изменение, Гусики'));
  });

  it('поле с точкой с запятой берётся в кавычки', () => {
    const out = ledgerCsv([row({ what: 'Тип; от Маши' })], 'ГусКоины');
    assert.ok(out.includes('"Тип; от Маши"'));
  });

  it('кавычки внутри поля удваиваются', () => {
    const out = ledgerCsv([row({ what: 'Звук «Бубух"' })], 'ГусКоины');
    assert.ok(out.includes('"Звук «Бубух"""'));
  });

  it('перенос строки внутри поля не рвёт таблицу', () => {
    const out = ledgerCsv([row({ detail: 'первая\nвторая' })], 'ГусКоины');
    assert.ok(out.includes('"первая\nвторая"'));
  });

  it('минус сохраняется — это трата', () => {
    assert.ok(ledgerCsv([row({ amount: -90 })], 'ГусКоины').includes(';-90;'));
  });

  it('пустой журнал — только заголовок, а не пустой файл', () => {
    const lines = ledgerCsv([], 'ГусКоины').trim().split('\r\n');
    assert.equal(lines.length, 1);
  });

  it('имя файла несёт период и дату — три выгрузки подряд не затирают друг друга', () => {
    const at = new Date(2026, 8, 3);
    assert.equal(ledgerFileName('week', at), 'guscoins-nedelya-2026-09-03.csv');
    assert.equal(ledgerFileName('season', at), 'guscoins-sezon-2026-09-03.csv');
  });

  it('день и месяц дополняются нулём — иначе файлы сортируются как попало', () => {
    assert.equal(ledgerFileName('month', new Date(2026, 0, 5)), 'guscoins-mesyac-2026-01-05.csv');
  });
});
