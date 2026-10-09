import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BAD_PICTURE_COOLDOWN_MS,
  BAD_PICTURE_WINDOW_MS,
  buildBadPictureReport,
  inboundSnapshot,
  inboundWindow,
  layerOfFrame,
  type InboundSnap,
} from './badPictureRules.js';

const snap = (patch: Partial<InboundSnap> = {}): InboundSnap => ({
  atMs: 1_000, w: 1920, h: 1080, fps: 30, framesDecoded: 20, keyFramesDecoded: 2, framesDropped: 1,
  qpSum: 500, hasQp: true, bytes: 1_000, packetsReceived: 100, packetsLost: 10, nack: 3, pli: 1, fir: 0,
  freezes: 2, freezeS: 1, pauses: 0, pauseS: 0, jitterMs: 12, jbDelayS: 0.01, jbEmitted: 10,
  decodeS: 0.3, decoder: 'D3D11', codec: 'video/H264', rttMs: 25, availInKbps: 5_000,
  ...patch,
});

describe('статистика приёма для отметки «Плохая картинка»', () => {
  it('берёт крупнейший видеопоток, его кодек и выбранный ICE-путь; отсутствующий QP не выдумывает', () => {
    // При смене слоя в getStats одновременно видны старый и новый поток; нужна фактически крупная принятая картинка.
    const result = inboundSnapshot([
      { type: 'inbound-rtp', kind: 'audio', frameWidth: 4000, frameHeight: 3000, bytesReceived: 1_000 },
      { type: 'inbound-rtp', kind: 'video', timestamp: 10, frameWidth: 1280, frameHeight: 720, codecId: 'old', framesDecoded: 10 },
      { type: 'inbound-rtp', kind: 'video', timestamp: 20, frameWidth: 1920, frameHeight: 1080, codecId: 'new', framesPerSecond: 30,
        framesDecoded: 50, bytesReceived: 200_000, jitter: 0.012, decoderImplementation: 'D3D11' },
      { type: 'codec', id: 'new', mimeType: 'video/H264' },
      { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.025, availableIncomingBitrate: 5_000_000 },
    ], 99);
    assert.ok(result, 'активная приёмная видеостатистика распознана');
    assert.equal(result.atMs, 20, 'время взято с крупнейшего видеопотока');
    assert.deepEqual([result.w, result.h, result.fps], [1920, 1080, 30], 'размер и частота относятся к принятому видео');
    assert.equal(result.codec, 'video/H264', 'кодек выбран по ссылке codecId');
    assert.equal(result.rttMs, 25, 'RTT прочитан из выбранной пары ICE');
    assert.equal(result.availInKbps, 5_000, 'входящая оценка переведена в кбит/с');
    assert.equal(result.hasQp, false, 'браузер не отдаёт QP для этого декодера');
    assert.equal(result.qpSum, 0, 'отсутствие qpSum не означает средний QP 0');
  });

  it('окно считает скорость, потери, QP и паузы по приращениям', () => {
    // Для разбора мыла важны две секунды вокруг жалобы, а не общие счётчики от начала звонка.
    const a = snap();
    const b = snap({ atMs: 3_000, framesDecoded: 60, keyFramesDecoded: 5, framesDropped: 3, qpSum: 2_500,
      bytes: 251_000, packetsReceived: 180, packetsLost: 15, nack: 4, pli: 3, freezes: 4, freezeS: 2.25,
      jbDelayS: 0.17, jbEmitted: 20 });
    assert.deepEqual(inboundWindow(a, b), {
      ms: 2_000, kbps: 1_000, fps: 20, qp: 50, lossPct: 5.9, nack: 1, pli: 2, freezes: 2,
      freezeMs: 1_250, dropped: 2, keyFrames: 3, jbMs: 16,
    });
    const noQp = inboundWindow(snap({ hasQp: false }), snap({ atMs: 3_000, framesDecoded: 60, qpSum: 9_000, hasQp: false }));
    assert.ok(noQp, 'окно статистики сохраняется, когда браузер не сообщает QP');
    assert.equal(noQp.qp, null, 'QP неизвестен, а не искусственно нулевой');
    assert.equal(inboundWindow(b, a), null, 'счётчики нового потока не вычитаются из старого');
  });

  it('слой определяется по ближайшей короткой стороне, а не по площади окна', () => {
    // Реальная ширина окна может отличаться от полного монитора; короткая сторона устойчивее диагонали/площади.
    const layers = [
      { width: 3840, height: 2160 }, { width: 2560, height: 1440 },
      { width: 1280, height: 720 }, { width: 640, height: 360 },
    ];
    assert.equal(layerOfFrame({ w: 3840, h: 2160 }, layers), 'high');
    assert.equal(layerOfFrame({ w: 1440, h: 900 }, layers), 'medium');
    assert.equal(layerOfFrame({ w: 1280, h: 720 }, layers), 'medium');
    assert.equal(layerOfFrame({ w: 640, h: 360 }, layers), 'low');
    assert.equal(layerOfFrame({ w: 1920, h: 1080 }, undefined), '');
  });

  it('отчёт связывает зрителя с владельцем показа, обрезает поля и прикладывает окно', () => {
    // Метка должна сводиться со срезами автора, не собирать слова пользователя и не раздувать базу длинными строками.
    const report = buildBadPictureReport({
      at: 1_234.7, identity: 'viewer-visible-owner#screen', channelId: 'c'.repeat(80), platform: 'android', version: 'v'.repeat(40),
      want: 'automatic-quality', layers: [
        { width: 3840, height: 2160 }, { width: 2560, height: 1440 }, { width: 1280, height: 720 },
        { width: 640, height: 360 }, { width: 320, height: 180 },
      ],
      a: snap(), b: snap({ atMs: 3_000, framesDecoded: 60, qpSum: 2_500, bytes: 251_000 }),
    });
    assert.equal(report.kind, 'badpic', 'отчёт имеет отдельный тип отметки');
    assert.equal(report.at, 1_235, 'время нажатия округлено до миллисекунды');
    assert.deepEqual(report.sharer, { identity: 'viewer-visible-owner#screen', userId: 'viewer-visible-owner', native: true });
    assert.equal(report.channelId?.length, 64, 'id канала ограничен схемой');
    assert.equal(report.viewer.version.length, 32, 'версия клиента ограничена');
    assert.equal(report.want, 'automati', 'строка качества ограничена схемой');
    assert.equal(report.layer, 'medium', 'слой принятого кадра выбран среди объявленных');
    assert.equal(report.layers.length, 4, 'в запрос уходят не более четырёх слоёв');
    assert.ok(report.win, 'второй снимок сопровождается окном после нажатия');
    assert.equal(report.win.qp, 50, 'окно несёт средний QP за две секунды');
    assert.ok(!('atMs' in report.now), 'накопительный снимок не дублирует timestamp внутреннего API');
    assert.ok(!('comment' in report), 'личный текст не попадает в диагностическую запись');
  });

  it('без первого кадра сохраняет накопительный снимок, а пауза и повторное нажатие равны 2 и 20 секундам', () => {
    // Даже если второй getStats сработал, а первый не успел, метку нельзя потерять; частые повторы ограничены.
    const report = buildBadPictureReport({
      at: 50, identity: 'web-user', channelId: null, platform: 'web', version: '', want: '', layers: undefined,
      a: null, b: snap({ hasQp: false }),
    });
    assert.equal(report.win, null, 'без первого снимка окно помечено неизвестным');
    assert.equal(report.now.hasQp, false, 'накопительная часть явно говорит, что QP неизвестен');
    assert.equal(report.sharer.native, false, 'обычный LiveKit identity не ошибочно принимается за desktop-спутник');
    assert.equal(BAD_PICTURE_WINDOW_MS, 2_000, 'окно замера остаётся двумя секундами');
    assert.equal(BAD_PICTURE_COOLDOWN_MS, 20_000, 'повторная кнопка не отправляет метки чаще одного раза в 20 секунд');
  });
});
