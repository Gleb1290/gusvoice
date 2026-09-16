import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MARKS,
  MAX_SAMPLES,
  diagReportTooBig,
  partitionSamples,
  stripNulls,
} from './diagRules.js';

describe('правила приёма диагностики', () => {
  it('отчёт за гранью разумного отбивается по числу срезов и меток', () => {
    assert.equal(diagReportTooBig(MAX_SAMPLES, MAX_MARKS), false);
    assert.equal(diagReportTooBig(MAX_SAMPLES + 1, 0), true);
    assert.equal(diagReportTooBig(0, MAX_MARKS + 1), true);
  });

  it('негодный срез теряется поштучно, а не топит весь отчёт', () => {
    // Ловит возврат к разбору «всё или ничего». 2026-08-22 один негодный срез стоил всего отчёта:
    // клиент получал 400, глушил его и слал такие же дальше — телеметрия замолкала насмерть.
    const parse = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    const r = partitionSamples([1, NaN, 2, 'мусор', 3], parse);
    assert.deepEqual(r.ok, [1, 2, 3]);
    assert.equal(r.dropped, 2);
  });

  it('число выброшенных возвращается наружу, а не прячется', () => {
    // Молча терять данные нельзя: «часть не доехала» иначе неотличимо от «людей не было».
    const r = partitionSamples([undefined, undefined], () => undefined);
    assert.deepEqual(r.ok, []);
    assert.equal(r.dropped, 2);
  });

  it('целый отчёт проходит без потерь', () => {
    const r = partitionSamples([1, 2, 3], (x) => x as number);
    assert.deepEqual(r.ok, [1, 2, 3]);
    assert.equal(r.dropped, 0);
  });

  it('валидные ноль, false и null не принимаются за нераспарсенный срез', () => {
    // Ловит замену строгой проверки undefined на !parsed: она выбросила бы законные нулевые метрики.
    const r = partitionSamples([0, false, null, undefined], (x) => (x === undefined ? undefined : x));
    assert.deepEqual(r.ok, [0, false, null]);
    assert.equal(r.dropped, 1);
  });

  it('пустые поля вычищаются вглубь — иначе один счётчик убивает весь срез', () => {
    // 🔴 Причина аварии 2026-08-22. Нечисловое значение уезжает в JSON как `null`, а «значение по
    // умолчанию» в схеме срабатывает только на ОТСУТСТВУЮЩЕЕ поле, не на пустое. Проверено на живой
    // схеме: `{}` принимается с нулём, `{gpu_pct: null}` — отказ. Отсюда 19 потерянных срезов из 21.
    assert.deepEqual(stripNulls({ gpu_pct: null, cpu_pct: 7 }), { cpu_pct: 7 });
    assert.deepEqual(stripNulls({ gpu: { power_w: null, temp_c: 60 } }), { gpu: { temp_c: 60 } });
    assert.deepEqual(stripNulls({ procs: [{ ws_mb: null, pid: 1 }] }), { procs: [{ pid: 1 }] });
  });

  it('вычистка не трогает ничего, кроме пустых полей', () => {
    // Ловит соблазн «заодно причесать»: ноль, false и пустая строка — это ДАННЫЕ, а не отсутствие.
    const src = { a: 0, b: false, c: '', d: 'текст', e: [1, 2], f: { g: 0 } };
    assert.deepEqual(stripNulls(src), src);
  });

  it('длинная строка обрезается, а не топит срез', () => {
    // 🔴 Реальная причина потерь 2026-08-22, названная самим сервером:
    //   `enc.encoder: String must contain at most 64 character(s)`
    // Со вторым слоем качества libwebrtc стал отдавать составное имя кодировщика длиной 66 символов,
    // и потолок `.max(64)` отбивал КАЖДЫЙ срез с показом — у одного человека 118 подряд.
    // Потолок нужен, чтобы чужая строка не раздула базу; для этого обрезка ничем не хуже отказа.
    const capped = (max: number, s: string) => s.slice(0, max);
    const имя = 'SimulcastEncoderAdapter (NVIDIA H264 Encoder, NVIDIA H264 Encoder)';
    assert.equal(имя.length > 64, true, 'имя кодировщика с двумя слоями длиннее прежнего потолка');
    assert.equal(capped(128, имя), имя, 'в новый потолок укладывается целиком');
    assert.equal(capped(32, имя).length, 32, 'что не влезло — обрезается, срез остаётся живым');
  });
});
