import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as live from './convGeoLive.js';
import { convMediaFallback, convMediaPreview, parseConvMedia } from './convMedia.js';

const now = 1_800_000_000_000;
const raw = readFileSync(new URL('./convGeoLive.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(source = raw): typeof live {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof live;
}
const start = (api = live) => {
  const m = api.geoLiveStart({ lat: 12.34567891, lon: -45.12345678, period: 900, accuracy: 12.34, heading: 360 }, now);
  assert.ok(m); return m;
};

it('R225 начало принимает ровно три срока и считает конец в миллисекундах от серверного времени', () => {
  for (const period of [900, 3600, 28800]) {
    const m = live.geoLiveStart({ lat: 0, lon: 0, period }, now); assert.ok(m);
    assert.equal(m.period, period); assert.equal(m.startedAt, now); assert.equal(m.updatedAt, now);
    assert.equal(m.until, now + period * 1000); assert.equal(m.stopped, false);
  }
});
function invalidPeriod(api = live) {
  assert.equal(api.geoLiveStart({ lat: 0, lon: 0, period: 12345 }, now) === null, true, 'R225-period: произвольный срок нельзя начать');
}
it('R225 срок вне списка, дробь, строка и нечисло не создают трансляцию', () => {
  invalidPeriod();
  for (const period of [0, -1, 899, 901, 900.1, '900', null, undefined, NaN, Infinity]) {
    assert.equal(live.geoLivePeriod(period), null); assert.equal(live.geoLiveStart({ lat: 0, lon: 0, period }, now), null);
  }
});
it('R225 широта и долгота принимают обе точные границы, нулевая точка не теряется', () => {
  for (const lat of [-90, 0, 90]) for (const lon of [-180, 0, 180]) {
    const m = live.geoLiveStart({ lat, lon, period: 900 }, now); assert.ok(m); assert.equal(m.lat, lat); assert.equal(m.lon, lon);
  }
});
it('R225 координата за любой границей, строка, NaN и бесконечность отклоняются', () => {
  for (const [lat, lon] of [[90.000001, 0], [-90.000001, 0], [0, 180.000001], [0, -180.000001], [NaN, 0], [0, Infinity], ['0', 0], [0, null]]) {
    assert.equal(live.geoLiveStart({ lat, lon, period: 900 }, now), null);
  }
});
it('R225 начало округляет точку и точность, 360 градусов превращает в север', () => {
  assert.deepEqual(start(), { kind: 'geolive', lat: 12.345679, lon: -45.123457, accuracy: 12.3, heading: 0,
    period: 900, startedAt: now, updatedAt: now, until: now + 900_000, stopped: false });
  assert.equal(live.geoLiveStart({ lat: 0, lon: 0, period: 900, accuracy: 100_001 }, now)?.accuracy, 100_000);
  for (const accuracy of [-1, NaN, Infinity, '1']) assert.equal(live.geoLiveStart({ lat: 0, lon: 0, period: 900, accuracy }, now)?.accuracy, null);
  for (const heading of [-1, 360.1, NaN, '0', undefined]) assert.equal(live.normHeading(heading), null);
  assert.equal(live.normHeading(359.9), 0); assert.equal(live.normHeading(0), 0);
});
it('R225 сохранённый вид разбирается общим parseConvMedia, неизвестный и неполный падают в запасной текст', () => {
  const m = start(); assert.deepEqual(parseConvMedia(m), m);
  for (const key of ['lat', 'lon', 'period', 'startedAt', 'updatedAt', 'until']) {
    const broken: Record<string, unknown> = { ...m }; delete broken[key]; assert.equal(parseConvMedia(broken), null, `без ${key}`);
  }
  assert.equal(parseConvMedia({ ...m, kind: 'future' }), null);
  assert.equal(parseConvMedia({ ...m, stopped: 1 })?.kind, 'geolive');
  assert.equal(live.parseGeoLive({ ...m, stopped: 1 })?.stopped, false);
});
it('R225 разбор времени отбрасывает ноль, минус и строки, дробные миллисекунды округляет вниз', () => {
  const m = start();
  for (const value of [0, -1, '1000', NaN, Infinity]) for (const key of ['startedAt', 'updatedAt', 'until']) {
    assert.equal(live.parseGeoLive({ ...m, [key]: value }), null);
  }
  assert.equal(live.parseGeoLive({ ...m, updatedAt: now + 0.9 })?.updatedAt, now);
});
function endBoundary(api = live) {
  const m = start(api);
  assert.equal(api.geoLiveEnded(m, m.until), true, 'R225-expiry: ровно until уже завершена');
  assert.equal(api.geoLiveView(m, m.until).stopped, true);
}
it('R225 истечение на чтении наступает ровно в until, исходная запись не мутирует', () => {
  const m = start(); assert.equal(live.geoLiveView(m, m.until - 1), m); endBoundary();
  assert.equal(live.geoLiveView(m, m.until + 1).stopped, true); assert.equal(m.stopped, false);
  assert.equal(live.geoLiveLeftMs(m, m.until - 1), 1); assert.equal(live.geoLiveLeftMs(m, m.until), 0);
  assert.equal(live.geoLiveLeftShare(m, now - 1000), 1); assert.equal(live.geoLiveLeftShare(m, m.until), 0);
});
it('R225 остановка идемпотентна, не меняет начальную запись и не возрождается чтением до срока', () => {
  const m = start(), stopped = live.geoLiveStop(m);
  assert.equal(m.stopped, false); assert.equal(stopped.stopped, true); assert.equal(live.geoLiveStop(stopped), stopped);
  assert.equal(live.geoLiveView(stopped, now), stopped); assert.equal(live.geoLiveLeftMs(stopped, now), 0);
});
function throttled(api = live) {
  const result = api.geoLiveUpdate(start(api), { lat: 1, lon: 2 }, now + 2999);
  assert.equal(result.ok && result.media === null, true, 'R225-gap: 2999 мс — успех без записи');
}
it('R225 сервер молча принимает раннюю точку, ровно 3000 мс уже обновляет без продления срока', () => {
  throttled(); const m = start();
  const r = live.geoLiveUpdate(m, { lat: 1.12345678, lon: 2.12345678, heading: 91.1, accuracy: 20.06 }, now + 3000);
  assert.ok(r.ok && r.media); assert.equal(r.media.lat, 1.123457); assert.equal(r.media.lon, 2.123457);
  assert.equal(r.media.startedAt, m.startedAt); assert.equal(r.media.period, m.period); assert.equal(r.media.until, m.until);
  assert.equal(r.media.updatedAt, now + 3000); assert.equal(r.media.heading, 91); assert.equal(r.media.accuracy, 20.1);
  assert.equal(m.updatedAt, now);
});
it('R225 плохая точка получает 400 даже до лимита частоты, а завершённая всегда 403', () => {
  const m = start();
  for (const point of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: NaN, lon: 0 }]) {
    assert.deepEqual(live.geoLiveUpdate(m, point, now + 1), { ok: false, code: 400, error: 'координаты вне диапазона' });
  }
  for (const [value, at] of [[m, m.until], [m, m.until + 1], [live.geoLiveStop(m), now]] as const) {
    const r = live.geoLiveUpdate(value, { lat: 0, lon: 0 }, at); assert.ok(!r.ok); assert.equal(r.code, 403);
  }
});
it('R225 клиент первую точку шлёт сразу, сдвиг ждёт 5 секунд, неподвижная точка ждёт 20 секунд', () => {
  const last = { lat: 0, lon: 0, at: now }, moved = { lat: 0.001, lon: 0 };
  assert.equal(live.geoLiveShouldSend(null, moved, now), true);
  assert.equal(live.geoLiveShouldSend(last, moved, now + 4999), false);
  assert.equal(live.geoLiveShouldSend(last, moved, now + 5000), true);
  assert.equal(live.geoLiveShouldSend(last, last, now + 19_999), false);
  assert.equal(live.geoLiveShouldSend(last, last, now + 20_000), true);
  assert.equal(live.geoLiveShouldSend(last, last, now + 29_999, 30_000), false);
  assert.equal(live.geoLiveShouldSend(last, last, now + 30_000, 30_000), true);
});
it('R225 клиент не считает девять метров движением, десять и одиннадцать уже считаются', () => {
  const last = { lat: 0, lon: 0, at: now };
  for (const meters of [9, 10, 11]) {
    const next = { lat: meters / 6_371_000 * 180 / Math.PI, lon: 0 };
    assert.ok(Math.abs(live.geoDistanceM(0, 0, next.lat, 0) - meters) < 1e-10);
    assert.equal(live.geoLiveShouldSend(last, next, now + 5000), meters >= 10);
  }
});
it('R225 превью и запасной текст сохраняют точку, координаты не меняются местами', () => {
  const m = start(); assert.equal(convMediaPreview(m), 'Геопозиция в реальном времени');
  assert.equal(convMediaFallback(m), live.convGeoLiveFallback(m));
  assert.equal(convMediaFallback(m), '📍 Геопозиция в реальном времени: 12.345679, -45.123457 https://www.openstreetmap.org/?mlat=12.345679&mlon=-45.123457#map=16/12.345679/-45.123457');
  assert.deepEqual(live.GEO_LIVE_PERIODS.map(live.geoLivePeriodLabel), ['15 минут', '1 час', '8 часов']);
});
it('R225 подписи времени различают границы минуты и часа и не показывают отрицательное время', () => {
  const m = start();
  for (const [left, text] of [[0, 'трансляция завершена'], [1, 'осталось меньше минуты'], [59_999, 'осталось меньше минуты'],
    [60_000, 'осталось 1 мин'], [3_600_000, 'осталось 1 ч'], [3_600_001, 'осталось 1 ч 1 мин']] as const) {
    assert.equal(live.geoLiveLeftText({ ...m, until: now + left }, now), text);
  }
  for (const [delta, text] of [[-1, 'обновлено только что'], [59_999, 'обновлено только что'], [60_000, 'обновлено 1 мин назад'],
    [3_600_000, 'обновлено 1 ч назад']] as const) assert.equal(live.geoLiveAgoText(now - delta, now), text);
});
for (const [name, from, to, check, prefix, actual, expected] of [
  ['произвольный срок', '(GEO_LIVE_PERIODS as readonly unknown[]).includes(v)', 'typeof v === \'number\' && v > 0', invalidPeriod, 'R225-period:', false, true],
  ['until ещё разрешён', 'return m.stopped || m.until <= now;', 'return m.stopped || m.until < now;', endBoundary, 'R225-expiry:', false, true],
  ['снят предел трёх секунд', 'if (now - m.updatedAt < GEO_LIVE_LIMITS.minGapMs)', 'if (false)', throttled, 'R225-gap:', false, true],
] as const) it(`R225 строгий контрфакт: ${name}`, () => {
  check(load()); assert.equal(raw.split(from).length - 1, 1, 'однозначный якорь в целом модуле');
  assert.throws(() => check(load(raw.replace(from, to))), (e: unknown) => e instanceof assert.AssertionError
    && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.expected === expected && e.actual === actual);
});
