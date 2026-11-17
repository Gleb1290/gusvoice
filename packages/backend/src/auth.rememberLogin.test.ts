import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { Script } from 'node:vm';
import bcrypt from 'bcryptjs';
import * as orm from 'drizzle-orm';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import * as zod from 'zod';
import * as shared from '../../shared/src/bots.js';
import * as rules from './authRules.js';
import * as schema from './db/schema.js';
import * as setupRules from './setupRules.js';
import * as superAdminRules from './superAdminRules.js';

type Auth = typeof import('./auth.js');
type Routes = typeof import('./routes/auth.js');
const DAY = 86400;
// Только выдуманные данные. Реальные env/БД/Redis/SMTP не загружаются даже транзитивно.
const signingKey = 'remember-login-test-only-key-not-for-use-outside-tests';
const credentials = { username: 'reader', password: 'synthetic-password' };
const passwordHash = bcrypt.hashSync(credentials.password, 4);
function compile(path: string): Script {
  return new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { filename: path });
}
const authScript = compile('./auth.ts'), routeScript = compile('./routes/auth.ts');
function execute<T>(script: Script, dependencies: Record<string, unknown>, instant = Date.now()): T {
  const module = { exports: {} };
  // Неиспользуемые границы запрещают IO; это не список разрешённых импортов приложения.
  const dormant = (path: string) => new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    return () => { throw new Error(`неожиданный вызов IO: ${path}.${String(key)}`); };
  } });
  // Часы auth-модуля не перескакивают через секунду во время граничного запроса refresh.
  class Clock extends Date { static now() { return instant; } }
  script.runInNewContext({ module, exports: module.exports, Date: Clock,
    require: (path: string) => dependencies[path] ?? dormant(path) });
  return module.exports as T;
}
async function fixture() {
  const row = { id: 'remember-login-reader', username: credentials.username, passwordHash,
    email: 'reader@example.test', displayName: 'Читатель', tokenGeneration: 0, deletedAt: null,
    verified: true, approvedAt: new Date(), totpEnabled: false, totpSecret: 'synthetic-totp-secret' };
  const code = { code: '123456', expiresAt: new Date(Date.now() + 60_000), attempts: 0 };
  let selects = 0;
  const db = {
    select: (projection?: unknown) => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => {
      selects++;
      if (table === schema.users) return [projection ? { gen: row.tokenGeneration, deletedAt: row.deletedAt } : row];
      if (table === schema.emailVerifications || table === schema.passwordResets) return [code];
      throw new Error('неожиданная таблица');
    } }) }) }),
    update: (table: unknown) => ({ set: (patch: Record<string, unknown>) => ({ where: () => {
      if (table === schema.users) {
        if ('tokenGeneration' in patch) row.tokenGeneration++;
        else Object.assign(row, patch);
      } else Object.assign(code, patch);
      return { then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(resolve),
        returning: async (projection?: unknown) => [projection ? { gen: row.tokenGeneration } : row] };
    } }) }),
    delete: () => ({ where: async () => {} }),
  };
  const now = Math.floor(Date.now() / 1000);
  const auth = execute<Auth>(authScript, { bcryptjs: bcrypt, 'drizzle-orm': orm, jsonwebtoken: jwt,
    './authRules.js': rules, './db/index.js': { db }, './db/schema.js': schema,
    './env.js': { env: { jwtSecret: signingKey } }, './superAdminRules.js': superAdminRules }, now * 1000);
  const redis = new Map<string, string>();
  const redisPub = { get: async (key: string) => redis.get(key) ?? null,
    set: async (key: string, value: string) => { redis.set(key, value); },
    del: async (key: string) => { redis.delete(key); } };
  const routes = execute<Routes>(routeScript, {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, zod,
    '../auth.js': auth, '../db/index.js': { db }, '../db/schema.js': schema,
    '../env.js': { env: { federation: { dmEnabled: false } } },
    '../guestGuard.js': { requireLocalUser: async () => {} },
    '../authGuard.js': { rateHit: async () => 0, clientIp: () => '192.0.2.1',
      loginLockRemaining: async () => 0, recordLoginFailure: async () => 0,
      clearLoginFailures: async () => {}, clearLoginLock: async () => {} },
    '../setupRules.js': setupRules, '../superAdminRules.js': superAdminRules,
    '../realtime.js': { redisPub },
    '../totp.js': { verifyTotpCounter: (value: string) => value === '654321' ? 123 : null,
      normalizeBackupCode: () => null },
    '../serialize.js': { serializeUser: () => ({ id: row.id, username: row.username }) },
    '../federation/guestRevocation.js': { revokeSessionsEverywhere: async () => {} },
  });
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof zod.ZodError) return reply.code(400).send({ error: 'invalid request' });
    throw error;
  });
  await routes.authRoutes(app);
  app.get('/protected', { preHandler: auth.requireAuth }, req => ({ sub: req.user!.sub }));
  const identity = () => ({ sub: row.id, username: row.username, gen: row.tokenGeneration });
  const post = (url: string, payload: object, token?: string) => app.inject({ method: 'POST', url, payload,
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  const protectedRequest = (token: string) => app.inject({ method: 'GET', url: '/protected',
    headers: { authorization: `Bearer ${token}` } });
  return { auth, app, row, code, identity, post, protectedRequest, now, selects: () => selects };
}
function claims(token: string): jwt.JwtPayload {
  return jwt.verify(token, signingKey) as jwt.JwtPayload;
}
function session(token: string, remembered: boolean, gen = 0): void {
  const value = claims(token);
  assert.equal(value.typ, 'auth');
  assert.equal(value.gen, gen);
  assert.equal(value.exp! - value.iat!, (remembered ? 90 : 8) * DAY);
  assert.equal(Object.hasOwn(value, 'rememberMe'), remembered);
  if (remembered) assert.equal(value.rememberMe, true);
  assert.equal(Object.hasOwn(value, 'password'), false);
}

it('долгий срок выбирается только явным true, старое умолчание сохраняется', () => {
  for (const value of [undefined, false, null, 'true', 1])
    assert.equal(rules.authTokenTtlSeconds(value as boolean | undefined), 8 * DAY);
  assert.equal(rules.authTokenTtlSeconds(true), 90 * DAY);
  assert.equal(rules.shouldRefresh(100, 100 + DAY - 1), false);
  assert.equal(rules.shouldRefresh(100, 100 + DAY), true);
});

it('реальная подпись задаёт 8 или 90 суток и токен истекает точно на границе exp', async () => {
  const f = await fixture();
  try {
    for (const rememberMe of [undefined, false, true]) {
      const token = f.auth.signToken({ ...f.identity(), rememberMe });
      session(token, rememberMe === true);
      const value = claims(token);
      assert.doesNotThrow(() => jwt.verify(token, signingKey, { clockTimestamp: value.exp! - 1 }));
      assert.throws(() => jwt.verify(token, signingKey, { clockTimestamp: value.exp! }), jwt.TokenExpiredError);
    }
  } finally { await f.app.close(); }
});

it('суточное продление сохраняет режим и поколение, старый JWT без gen остаётся обычным', async () => {
  const f = await fixture();
  try {
    const now = f.now;
    f.row.tokenGeneration = 7;
    for (const rememberMe of [undefined, true]) for (const age of [DAY - 1, DAY]) {
      const token = jwt.sign({ ...f.identity(), iat: now - age, ...(rememberMe ? { rememberMe } : {}) },
        signingKey, { expiresIn: (rememberMe ? 90 : 8) * DAY });
      const reply = await f.protectedRequest(token);
      assert.equal(reply.statusCode, 200);
      if (age < DAY) assert.equal(reply.headers['x-refresh-token'], undefined);
      else session(reply.headers['x-refresh-token'] as string, rememberMe === true, 7);
    }
    f.row.tokenGeneration = 0;
    f.auth.forgetTokenGeneration(f.row.id);
    const legacy = jwt.sign({ sub: f.row.id, username: f.row.username, iat: now - DAY }, signingKey, { expiresIn: 8 * DAY });
    const reply = await f.protectedRequest(legacy);
    assert.equal(reply.statusCode, 200);
    session(reply.headers['x-refresh-token'] as string, false);
    const withoutIat = jwt.sign(f.identity(), signingKey, { expiresIn: 8 * DAY, noTimestamp: true });
    const unchanged = await f.protectedRequest(withoutIat);
    assert.equal(unchanged.statusCode, 200);
    assert.equal(unchanged.headers['x-refresh-token'], undefined);
  } finally { await f.app.close(); }
});

it('запомненный challenge живёт пять минут и никогда не открывает защищённую сессию', async () => {
  const f = await fixture();
  try {
    for (const rememberMe of [undefined, false, true]) {
      const token = f.auth.signChallengeToken({ ...f.identity(), rememberMe });
      const value = claims(token);
      assert.equal(value.typ, '2fa');
      assert.equal(value.exp! - value.iat!, 300);
      assert.equal(Object.hasOwn(value, 'rememberMe'), rememberMe === true);
      assert.throws(() => jwt.verify(token, signingKey, { clockTimestamp: value.exp! }), jwt.TokenExpiredError);
      assert.equal((await f.protectedRequest(token)).statusCode, 401);
    }
  } finally { await f.app.close(); }
});

it('подъём поколения отзывает даже 90-дневный токен и очищает уже прогретый кеш', async () => {
  const f = await fixture();
  try {
    const old = f.auth.signToken({ ...f.identity(), rememberMe: true });
    assert.equal((await f.protectedRequest(old)).statusCode, 200);
    assert.equal(await f.auth.bumpTokenGeneration(f.row.id), 1);
    const revoked = await f.protectedRequest(old);
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.headers['x-refresh-token'], undefined);
    assert.equal((await f.protectedRequest(f.auth.signToken({ ...f.identity(), rememberMe: true }))).statusCode, 200);
  } finally { await f.app.close(); }
});

it('login принимает отсутствие, false и true, но только true даёт долгий вход', async () => {
  const f = await fixture();
  try {
    for (const rememberMe of [undefined, false, true]) {
      const reply = await f.post('/auth/login', { ...credentials, rememberMe });
      assert.equal(reply.statusCode, 200);
      session(reply.json().token, rememberMe === true);
    }
    const bad = await f.post('/auth/login', { ...credentials, password: 'wrong-password', rememberMe: true });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().token, undefined);
  } finally { await f.app.close(); }
});

it('login и verify отвергают небулевое согласие до чтения аккаунта', async () => {
  const f = await fixture();
  try {
    for (const rememberMe of ['true', 'false', 1, 0, null, {}, []]) {
      assert.equal((await f.post('/auth/login', { ...credentials, rememberMe })).statusCode, 400);
      assert.equal((await f.post('/auth/verify', { identifier: credentials.username, code: '123456', rememberMe })).statusCode, 400);
    }
    assert.equal(f.selects(), 0);
  } finally { await f.app.close(); }
});

it('2FA переносит подписанный выбор и игнорирует противоположный rememberMe тела', async () => {
  for (const rememberMe of [undefined, false, true]) {
    // Отдельный вход/Redis на сценарий: TOTP anti-replay остаётся включённым.
    const f = await fixture(); f.row.totpEnabled = true;
    try {
      const first = await f.post('/auth/login', { ...credentials, rememberMe });
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().status, 'totp_required');
      const challenge = first.json().challenge as string;
      const signed = claims(challenge);
      assert.equal(signed.exp! - signed.iat!, 300);
      assert.equal(signed.rememberMe, rememberMe === true ? true : undefined);
      const reply = await f.post('/auth/login/totp', { challenge, code: '654321', rememberMe: rememberMe !== true });
      assert.equal(reply.statusCode, 200);
      session(reply.json().token, rememberMe === true);
    } finally { await f.app.close(); }
  }
});

it('подделанный, истёкший challenge и auth-токен не обмениваются на долгую сессию', async () => {
  const f = await fixture(); f.row.totpEnabled = true;
  try {
    const expired = jwt.sign({ ...f.identity(), typ: '2fa', rememberMe: true,
      iat: Math.floor(Date.now() / 1000) - 301 }, signingKey, { expiresIn: 300 });
    const forged = jwt.sign({ ...f.identity(), typ: '2fa', rememberMe: true }, 'different-test-key');
    for (const challenge of [expired, forged, f.auth.signToken(f.identity())]) {
      const reply = await f.post('/auth/login/totp', { challenge, code: '654321', rememberMe: true });
      assert.equal(reply.statusCode, 401);
      assert.equal(reply.json().token, undefined);
    }
  } finally { await f.app.close(); }
});

it('выбор login после email_not_verified сохраняется только при верном коде verify', async () => {
  for (const rememberMe of [undefined, false, true]) {
    const f = await fixture(); f.row.verified = false;
    try {
      assert.equal((await f.post('/auth/login', { ...credentials, rememberMe })).json().error, 'email_not_verified');
      const bad = await f.post('/auth/verify', { identifier: credentials.username, code: '999999', rememberMe });
      assert.equal(bad.statusCode, 400); assert.equal(bad.json().token, undefined);
      const good = await f.post('/auth/verify', { identifier: credentials.username, code: '123456', rememberMe });
      assert.equal(good.statusCode, 200); session(good.json().token, rememberMe === true);
    } finally { await f.app.close(); }
  }
});

it('подтверждение новой почты сохраняет режим только действующей сессии того же аккаунта', async () => {
  for (const kind of ['remembered', 'ordinary', 'other-user', 'challenge', 'revoked', 'expired'] as const) {
    const f = await fixture();
    f.row.verified = false; // Смена адреса почты уже сняла подтверждение до ввода кода.
    try {
      const identity = f.identity();
      const token = kind === 'challenge'
        ? f.auth.signChallengeToken({ ...identity, rememberMe: true })
        : kind === 'expired'
          ? jwt.sign({ ...identity, typ: 'auth', rememberMe: true, iat: f.now - 91 * DAY }, signingKey, { expiresIn: 90 * DAY })
          : f.auth.signToken({ ...identity, rememberMe: kind !== 'ordinary',
              ...(kind === 'other-user' ? { sub: 'another-reader' } : {}),
              ...(kind === 'revoked' ? { gen: identity.gen + 1 } : {}) });
      const reply = await f.post('/auth/verify', { identifier: credentials.username, code: '123456' }, token);
      assert.equal(reply.statusCode, 200);
      session(reply.json().token, kind === 'remembered');
    } finally { await f.app.close(); }
  }
});

it('смена пароля и выход на других устройствах сохраняют режим req.user, тело его не повышает', async () => {
  for (const url of ['/auth/password', '/auth/logout-all']) for (const rememberMe of [false, true]) {
    const f = await fixture();
    try {
      const old = f.auth.signToken({ ...f.identity(), rememberMe });
      const reply = await f.post(url, { password: credentials.password, currentPassword: credentials.password,
        newPassword: 'replacement-password', rememberMe: !rememberMe }, old);
      assert.equal(reply.statusCode, 200);
      session(reply.json().token, rememberMe, 1);
      assert.equal((await f.protectedRequest(old)).statusCode, 401);
      assert.equal((await f.protectedRequest(reply.json().token)).statusCode, 200);
    } finally { await f.app.close(); }
  }
});

it('сброс пароля с rememberMe не выдаёт сессию, следующий вход без согласия остаётся обычным', async () => {
  const f = await fixture();
  try {
    const old = f.auth.signToken({ ...f.identity(), rememberMe: true });
    const reply = await f.post('/auth/password/reset', { identifier: credentials.username, code: '123456',
      newPassword: 'replacement-password', rememberMe: true });
    assert.equal(reply.statusCode, 200); assert.equal(reply.json().token, undefined);
    assert.equal(reply.headers['x-refresh-token'], undefined);
    assert.equal((await f.protectedRequest(old)).statusCode, 401);
    const login = await f.post('/auth/login', { ...credentials, password: 'replacement-password' });
    assert.equal(login.statusCode, 200); session(login.json().token, false, 1);
  } finally { await f.app.close(); }
});
