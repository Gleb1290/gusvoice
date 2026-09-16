import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { InstanceUpdateInfo, InstanceUpdateStatus } from '@gusvoice/shared';
import {
  compareReleaseVersions,
  decideUpdate,
  LATEST_CACHE_MS,
  LATEST_FORCE_MIN_MS,
  normalizeReleaseVersion,
  parseLatestRelease,
  parseReleaseVersion,
  parseUpdateStatus,
  REQUEST_STUCK_MS,
  RUNNING_STALE_MS,
  shouldCheckLatest,
  UPDATE_STEPS,
  updateRequestLine,
  type UpdateDecisionInput,
} from './instanceUpdateRules.js';

describe('номер выпуска', () => {
  it('принимает версию с v, без v и с пробелами, приводя к единой записи', () => {
    // Ловит отказ ручному вводу без префикса и расхождение ключей одного выпуска.
    assert.deepEqual(parseReleaseVersion('v0.7.2'), [0, 7, 2]);
    assert.deepEqual(parseReleaseVersion('0.7.2'), [0, 7, 2]);
    assert.deepEqual(parseReleaseVersion('  v0.7.2  '), [0, 7, 2]);
    assert.equal(normalizeReleaseVersion('  0.7.2  '), 'v0.7.2');
  });

  it('ветки, плавающие метки, неполные и слишком длинные версии не считаются выпуском', () => {
    // Ловит отправку произвольной строки хостовому обновлятору вместо строгого номера релиза.
    const invalid: unknown[] = [
      'master-abc1234',
      'dev',
      'latest',
      'v1.2',
      'v1.2.3.4',
      'v12345.0.0',
      'v0.7.2-rc1',
      null,
      undefined,
      702,
      {},
    ];
    for (const value of invalid) {
      assert.equal(parseReleaseVersion(value), null, String(value));
      assert.equal(normalizeReleaseVersion(value), null, String(value));
    }
  });

  it('сравнивает компоненты числами, а не строкой', () => {
    // Главная регрессия: лексикографически 0.7.10 ошибочно старше 0.7.9.
    assert.equal(compareReleaseVersions('v0.7.10', 'v0.7.9'), 1);
    assert.equal(compareReleaseVersions('v0.7.9', 'v0.7.10'), -1);
  });

  it('версии с v и без v равны, а не-выпуск с любой стороны не сравнивается', () => {
    // Ловит ложное предложение обновиться до уже установленной версии и выдуманный порядок dev-сборок.
    assert.equal(compareReleaseVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(compareReleaseVersions('dev', 'v1.2.3'), null);
    assert.equal(compareReleaseVersions('v1.2.3', 'latest'), null);
  });
});

describe('ответ сервера выпусков', () => {
  const release = (over: Record<string, unknown> = {}) => ({
    tag_name: 'v0.7.2',
    draft: false,
    prerelease: false,
    html_url: 'https://code.example.com/releases/v0.7.2',
    published_at: '2026-09-16T01:02:03Z',
    ...over,
  });

  it('годный выпуск нормализует версию, ссылку и дату', () => {
    // Парный успешный путь не даёт защите скрыть корректный релиз.
    assert.deepEqual(parseLatestRelease(release({ tag_name: '0.7.2' })), {
      version: 'v0.7.2',
      url: 'https://code.example.com/releases/v0.7.2',
      publishedAt: '2026-09-16T01:02:03.000Z',
    });
  });

  it('черновик, пред-выпуск и неверная метка не становятся доступным обновлением', () => {
    // Ловит выкладку незавершённой версии людям через чужое или ошибочное зеркало API.
    assert.equal(parseLatestRelease(release({ draft: true })), null);
    assert.equal(parseLatestRelease(release({ prerelease: true })), null);
    assert.equal(parseLatestRelease(release({ tag_name: 'v0.7.2-rc1' })), null);
  });

  it('javascript, http и ссылка с логином отбрасываются, но сам выпуск остаётся', () => {
    // Ловит опасную ссылку «Что нового» без потери безопасных сведений о версии.
    for (const html_url of [
      'javascript:alert(1)',
      'http://code.example.com/releases/v0.7.2',
      'https://user:password@code.example.com/releases/v0.7.2',
    ]) {
      assert.deepEqual(parseLatestRelease(release({ html_url })), {
        version: 'v0.7.2',
        url: null,
        publishedAt: '2026-09-16T01:02:03.000Z',
      });
    }
  });

  it('мусорная дата становится null, не отбрасывая выпуск', () => {
    // Дата — декоративное поле: её ошибка не должна ни лгать интерфейсу, ни прятать обновление.
    assert.equal(parseLatestRelease(release({ published_at: 'когда-нибудь' }))?.publishedAt, null);
  });
});

describe('статус обновления с хоста', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const status = (over: Record<string, unknown> = {}) => ({
    state: 'done',
    step: 'health',
    requested: 'v0.7.2',
    version: 'v0.7.2',
    startedAt: '2026-09-16T11:55:00Z',
    finishedAt: '2026-09-16T12:00:00Z',
    error: '',
    backup: '.gusvoice-backups/db-20260916.sql.gz',
    ...over,
  });

  it('неизвестное состояние отвергается целиком', () => {
    // Ловит трактовку чужого формата как успешного или ещё идущего обновления.
    assert.equal(parseUpdateStatus(status({ state: 'paused' }), now), null);
  });

  it('running старше 45 минут превращается в failed/interrupted', () => {
    // Откат этой ветки навсегда заблокировал бы кнопку после перезагрузки посреди обновления.
    const startedAt = new Date(now - RUNNING_STALE_MS - 1).toISOString();
    const parsed = parseUpdateStatus(status({ state: 'running', startedAt, finishedAt: '' }), now);
    assert.equal(parsed?.state, 'failed');
    assert.equal(parsed?.error, 'interrupted');
  });

  it('ровно 45 минут ещё считается работающим обновлением', () => {
    // Ловит ошибку >= вместо > на принятой включительной границе живого процесса.
    const startedAt = new Date(now - RUNNING_STALE_MS).toISOString();
    assert.equal(parseUpdateStatus(status({ state: 'running', startedAt, finishedAt: '' }), now)?.state, 'running');
  });

  it('running без корректного startedAt считается прерванным', () => {
    // Иначе повреждённый статус заблокирует повтор навсегда без возможности посчитать возраст.
    const parsed = parseUpdateStatus(status({ state: 'running', startedAt: '', finishedAt: '' }), now);
    assert.equal(parsed?.state, 'failed');
    assert.equal(parsed?.error, 'interrupted');
  });

  it('выход backup из разрешённого каталога отбрасывается, а безопасный путь сохраняется', () => {
    // Ловит показ оператору подставленного системного пути как якобы созданной копии базы.
    assert.equal(parseUpdateStatus(status({ backup: '../../etc/passwd' }), now)?.backup, null);
    assert.equal(
      parseUpdateStatus(status({ backup: '.gusvoice-backups/db-safe.sql.gz' }), now)?.backup,
      '.gusvoice-backups/db-safe.sql.gz',
    );
  });

  it('версия с кавычками или HTML-углом отбрасывается, а обычная сохраняется', () => {
    // Ловит перенос чужого текста из status.json в интерфейс версии.
    assert.equal(parseUpdateStatus(status({ version: 'v0.7.2" onclick="x' }), now)?.version, null);
    assert.equal(parseUpdateStatus(status({ version: '<v0.7.2>' }), now)?.version, null);
    assert.equal(parseUpdateStatus(status({ version: 'v0.7.2' }), now)?.version, 'v0.7.2');
  });

  it('failed без кода получает interrupted, а безопасный неизвестный код сохраняется', () => {
    // Ловит пустое объяснение сбоя и потерю расширяемости между версиями хоста и клиента.
    assert.equal(parseUpdateStatus(status({ state: 'failed', error: '' }), now)?.error, 'interrupted');
    assert.equal(parseUpdateStatus(status({ state: 'failed', error: 'future-disk-error' }), now)?.error, 'future-disk-error');
  });
});

const latest = (version = 'v0.8.0'): NonNullable<InstanceUpdateInfo['latest']> => ({
  version,
  url: null,
  publishedAt: null,
});
const running: InstanceUpdateStatus = {
  state: 'running',
  step: 'pull',
  requested: 'v0.8.0',
  version: null,
  startedAt: '2026-09-16T12:00:00.000Z',
  finishedAt: null,
  error: null,
  backup: null,
};
const decision = (over: Partial<UpdateDecisionInput> = {}): UpdateDecisionInput => ({
  installed: 'v0.7.0',
  latest: latest(),
  checkDisabled: false,
  updater: { tag: 'latest' },
  status: null,
  requestAgeMs: null,
  ...over,
});

describe('порядок причин, запрещающих обновление', () => {
  it('каждая причина побеждает все достижимые более поздние причины', () => {
    // Таблица фиксирует порядок UX; изменение последовательности if краснит соответствующую строку.
    const cases: Array<[string, UpdateDecisionInput, InstanceUpdateInfo['blockedReason']]> = [
      [
        'dev-build раньше running',
        decision({ installed: 'dev', status: running, requestAgeMs: 1, checkDisabled: true, latest: null, updater: null }),
        'dev-build',
      ],
      [
        'running раньше pending',
        decision({ status: running, requestAgeMs: 1, checkDisabled: true, latest: null, updater: null }),
        'running',
      ],
      [
        'pending раньше check-disabled',
        decision({ requestAgeMs: 1, checkDisabled: true, latest: null, updater: null }),
        'pending',
      ],
      ['check-disabled раньше unknown-latest', decision({ checkDisabled: true, latest: null, updater: null }), 'check-disabled'],
      ['unknown-latest раньше no-updater', decision({ latest: null, updater: null }), 'unknown-latest'],
      ['up-to-date раньше no-updater', decision({ latest: latest('v0.7.0'), updater: null }), 'up-to-date'],
      ['no-updater при новом выпуске', decision({ updater: null }), 'no-updater'],
      ['pinned-tag после проверки службы', decision({ updater: { tag: 'v0.7.0' } }), 'pinned-tag'],
      ['все проверки пройдены', decision(), null],
    ];
    for (const [name, input, expected] of cases) {
      const result = decideUpdate(input);
      assert.equal(result.blockedReason, expected, name);
      assert.equal(result.canUpdate, expected === null, name);
    }
  });

  it('установленная версия новее свежего выпуска всё равно считается актуальной', () => {
    // Ловит предложение откатиться на последний публичный релиз с более новой локальной версии.
    assert.equal(decideUpdate(decision({ installed: 'v0.9.0', latest: latest('v0.8.0') })).blockedReason, 'up-to-date');
  });

  it('запрос ровно 30 секунд ещё не завис, следующая миллисекунда уже зависла', () => {
    // Ловит off-by-one в диагностике systemd, не меняя более раннюю причину pending.
    const edge = decideUpdate(decision({ requestAgeMs: REQUEST_STUCK_MS }));
    const late = decideUpdate(decision({ requestAgeMs: REQUEST_STUCK_MS + 1 }));
    assert.equal(edge.blockedReason, 'pending');
    assert.equal(edge.requestStuck, false);
    assert.equal(late.requestStuck, true);
  });
});

describe('кэш проверки выпусков', () => {
  const now = 1_000_000_000;

  it('без прошлой проверки спрашивает всегда', () => {
    // Ловит вечный пустой кэш после первого запуска инстанса.
    assert.equal(shouldCheckLatest(null, now, false), true);
    assert.equal(shouldCheckLatest(null, now, true), true);
  });

  it('обычная проверка живёт шесть часов с включительной границей обновления', () => {
    // Ловит лишние запросы к API и опоздание ровно на границе TTL.
    assert.equal(shouldCheckLatest(now - LATEST_CACHE_MS + 1, now, false), false);
    assert.equal(shouldCheckLatest(now - LATEST_CACHE_MS, now, false), true);
  });

  it('force разрешается не чаще минуты, ровно через минуту снова проходит', () => {
    // Ловит обход троттлинга частыми кликами и ошибку на граничной миллисекунде.
    assert.equal(shouldCheckLatest(now - LATEST_FORCE_MIN_MS + 1, now, true), false);
    assert.equal(shouldCheckLatest(now - LATEST_FORCE_MIN_MS, now, true), true);
  });
});

describe('строка запроса для хоста', () => {
  it('добавляет v и ровно один перевод строки к корректной версии', () => {
    // Парный успешный путь фиксирует точный файловый протокол backend → update.sh.
    assert.equal(updateRequestLine('0.7.2'), 'v0.7.2\n');
    assert.equal(updateRequestLine('v0.7.2'), 'v0.7.2\n');
  });

  it('команда и второй ряд внутри версии не попадают в файл запроса', () => {
    // Ловит превращение номера версии в shell-инъекцию или второй управляющий ряд.
    assert.equal(updateRequestLine('v0.7.2; rm -rf /'), null);
    assert.equal(updateRequestLine('v0.7.2\nrm'), null);
  });
});

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const updateScript = join(repoRoot, 'update.sh').replaceAll('\\', '/');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';

function shellHelper(body: string, args: string[] = []): string {
  const result = spawnSync(
    bash,
    ['-c', `GV_UPDATE_LIB_ONLY=1 . "$1"; shift; ${body}`, 'test', updateScript, ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function shellPredicate(name: 'panel_version_ok' | 'tag_is_pinned', value: string): boolean {
  return shellHelper(`${name} "$1"; printf '%s' "$?"`, [value]) === '0';
}

describe('чистые правила update.sh', () => {
  it('panel_version_ok принимает только vX.Y.Z с компонентами до четырёх цифр', () => {
    // Ловит расхождение хостовой проверки с backend и чтение второй строки как команды.
    assert.equal(shellPredicate('panel_version_ok', 'v0.7.2'), true);
    assert.equal(shellPredicate('panel_version_ok', 'v9999.9999.9999'), true);
    for (const value of ['0.7.2', 'v10000.0.0', 'v1.2', 'v1.2.3.4']) {
      assert.equal(shellPredicate('panel_version_ok', value), false, JSON.stringify(value));
    }
    assert.equal(
      shellHelper(`value=$'v0.7.2\\nrm'; panel_version_ok "$value"; printf '%s' "$?"`),
      '1',
      'перевод строки внутри версии',
    );
  });

  it('tag_is_pinned отличает конкретную версию от плавающих меток', () => {
    // Ловит бессмысленную кнопку при закреплённых образах и ложную блокировку latest/master.
    for (const value of ['v0.7.0', '0.7.0']) assert.equal(shellPredicate('tag_is_pinned', value), true, value);
    for (const value of ['latest', 'master', 'o3']) assert.equal(shellPredicate('tag_is_pinned', value), false, value);
  });

  it('json_str отбрасывает кавычку, слэш, пробел, перевод строки и слишком длинное значение', () => {
    // Откат фильтра сломал бы JSON статуса или позволил дописать в него чужое поле.
    const invalid = ['a"b', 'a\\b', 'a b', 'x'.repeat(121)];
    for (const value of invalid) assert.equal(shellHelper('json_str "$1"', [value]), 'null', JSON.stringify(value));
    assert.equal(shellHelper(`value=$'a\\nb'; json_str "$value"`), 'null', 'перевод строки');
    assert.equal(shellHelper('json_str "$1"', ['v0.7.2']), '"v0.7.2"');
  });

  it('status_json остаётся валидным JSON при восьми произвольных аргументах', () => {
    // Фаззинг ловит поле, которое забыли провести через json_str при расширении статуса.
    const corpus = [
      '',
      'safe',
      '2026-09-16T12:00:00Z',
      '.gusvoice-backups/db.sql.gz',
      'a"b',
      'a\\b',
      'a b',
      'a\nb',
      'x'.repeat(121),
      '<tag>',
    ];
    for (let offset = 0; offset < corpus.length; offset++) {
      const args = Array.from({ length: 8 }, (_, i) => corpus[(offset + i) % corpus.length]);
      const raw = shellHelper('status_json "$@"', args);
      assert.doesNotThrow(() => JSON.parse(raw), `offset ${offset}: ${raw}`);
    }
  });

  it('backups_to_prune оставляет пять новых, а пустой и нераскрывшийся glob не удаляет', () => {
    // Ловит удаление свежих копий и буквального db-*.sql.gz при пустом каталоге.
    const seven = Array.from({ length: 7 }, (_, i) => `db-${i + 1}.sql.gz`);
    assert.deepEqual(shellHelper('backups_to_prune 5 "$@"', seven).trim().split('\n'), seven.slice(0, 2));
    assert.equal(shellHelper('backups_to_prune 5 "$@"', seven.slice(0, 5)), '');
    assert.equal(shellHelper('backups_to_prune 5 "$@"'), '');
    assert.equal(shellHelper('backups_to_prune 5 "$@"', ['db-*.sql.gz']), '');
  });
});

describe('контракт backend, update.sh и клиента', () => {
  const updateSource = readFileSync(join(repoRoot, 'update.sh'), 'utf8');
  const rulesSource = readFileSync(new URL('./instanceUpdateRules.ts', import.meta.url), 'utf8');
  const cardSource = readFileSync(
    join(repoRoot, 'apps/client/src/components/InstanceUpdateCard.tsx'),
    'utf8',
  );
  const shellSteps = [...updateSource.matchAll(/\bpanel_step\s+([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  const shellErrors = [
    ...new Set([
      ...updateSource.matchAll(/\bPANEL_ERROR=([a-z][a-z0-9-]*)/g),
      ...updateSource.matchAll(/\bpanel_step\s+([a-z][a-z0-9-]*)/g),
    ].map((m) => m[1])),
  ];

  it('каждый шаг и код update.sh переживает status_json → parseUpdateStatus без подмены', () => {
    // Ловит несовместимое изменение файлового протокола между хостом и контейнером.
    const started = '2026-09-16T12:00:00Z';
    const now = Date.parse(started);
    for (const step of shellSteps) {
      const raw = shellHelper('status_json running "$1" v0.7.2 "" "$2" "" "" ""', [step, started]);
      assert.equal(parseUpdateStatus(JSON.parse(raw), now)?.step, step, step);
    }
    for (const error of shellErrors) {
      const raw = shellHelper('status_json failed "" v0.7.2 "" "$2" "$2" "$1" ""', [error, started]);
      assert.equal(parseUpdateStatus(JSON.parse(raw), now)?.error, error, error);
    }
  });

  it('backend знает каждый код ошибки и шаг, который может записать update.sh', () => {
    // Греп-страж краснеет сразу при добавлении host-кода без клиентского контракта.
    const errorBlock = /const ERROR_CODES[^=]*=\s*\[([\s\S]*?)\];/.exec(rulesSource)?.[1] ?? '';
    const backendErrors = [...errorBlock.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
    for (const code of shellErrors) assert.ok(backendErrors.includes(code), code);
    assert.deepEqual(shellSteps, [...UPDATE_STEPS]);
  });

  it('клиент показывает те же этапы и в том же порядке, что backend принимает от хоста', () => {
    // Ловит зависший или перепутанный прогресс при независимой правке React-карточки.
    const stepsBlock = /const STEPS[^=]*=\s*\[([\s\S]*?)\];/.exec(cardSource)?.[1] ?? '';
    const clientSteps = [...stepsBlock.matchAll(/\bid:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
    assert.deepEqual(clientSteps, [...UPDATE_STEPS]);
  });
});
