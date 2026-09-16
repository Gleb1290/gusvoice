import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateBackupCodes,
  generateTotpSecret,
  normalizeBackupCode,
  otpauthUri,
  verifyTotp,
  verifyTotpCounter,
} from './totp.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('проверка TOTP', () => {
  it('совпадает с опубликованными SHA-1 векторами RFC 6238', () => {
    // Ловит несовместимость с приложениями-аутентификаторами из-за ошибки base32, HOTP или периода.
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130'],
    ];
    for (const [seconds, token] of vectors) assert.equal(verifyTotp(token, RFC_SECRET, seconds * 1000), true);
  });

  it('принимает ровно соседние временные шаги и возвращает совпавший счётчик', () => {
    // Ловит как слишком узкое окно при рассинхроне часов, так и потерю счётчика для anti-replay.
    assert.equal(verifyTotpCounter('755224', RFC_SECRET, 59_000), 0);
    assert.equal(verifyTotpCounter('287082', RFC_SECRET, 59_000), 1);
    assert.equal(verifyTotpCounter('359152', RFC_SECRET, 59_000), 2);
  });

  it('код за пределами окна в один шаг отклоняется', () => {
    // Ловит незаметное расширение срока жизни одноразового кода дальше разрешённых 90 секунд.
    assert.equal(verifyTotpCounter('969429', RFC_SECRET, 59_000), null);
  });

  it('пробелы из буфера обмена не мешают корректному шестизначному коду', () => {
    // Ловит отказ кода, визуально сгруппированного менеджером паролей или самим пользователем.
    assert.equal(verifyTotp('287 082', RFC_SECRET, 59_000), true);
  });

  it('нецифровые, короткие и длинные токены отклоняются', () => {
    // Ловит принятие неоднозначного формата до постоянновременного сравнения.
    for (const token of ['28708', '2870820', '28a082', '', '      ']) {
      assert.equal(verifyTotpCounter(token, RFC_SECRET, 59_000), null);
    }
  });
});

describe('секреты и резервные коды 2FA', () => {
  it('сгенерированный секрет содержит 160 бит в base32 без padding', () => {
    // Ловит укороченный или несовместимый с аутентификаторами секрет.
    assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/);
  });

  it('otpauth-ссылка кодирует подпись и обязательные параметры', () => {
    // Ловит QR, который сканируется, но создаёт аккаунт с другим issuer, периодом или числом цифр.
    const url = new URL(otpauthUri(RFC_SECRET, 'user+test@example.org', 'Gus Voice'));
    assert.equal(url.protocol, 'otpauth:');
    assert.equal(url.host, 'totp');
    assert.equal(decodeURIComponent(url.pathname), '/Gus Voice:user+test@example.org');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      secret: RFC_SECRET,
      issuer: 'Gus Voice',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });

  it('резервный код сравнивается без учёта регистра и разделителей', () => {
    // Ловит отказ резервного кода после ручного ввода с пробелами или тире из интерфейса.
    assert.equal(normalizeBackupCode(' A1B2-c3D4 '), 'a1b2c3d4');
  });

  it('генератор соблюдает количество, формат и уникальность резервных кодов', () => {
    // Ловит неполный набор либо дубликаты, уменьшающие фактическое число аварийных входов.
    const codes = generateBackupCodes(12);
    assert.equal(codes.length, 12);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
    assert.deepEqual(generateBackupCodes(0), []);
  });
});
