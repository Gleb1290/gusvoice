import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, type TestDb } from './harness.js';

test('R131 0134 повторяется и сохраняет метки, старые вставки получают NULL в новых колонках',async()=>{
  // Старый писатель не знает активности; повтор миграции не должен снять живой забор сборки.
  const raw=new PGlite();
  try{
    await raw.exec(`CREATE TABLE attachment_uploads(id text PRIMARY KEY,size bigint NOT NULL);INSERT INTO attachment_uploads VALUES ('old',3)`);
    const migration=await readFile(new URL('../drizzle/0134_attachment_upload_claim.sql',import.meta.url),'utf8');await raw.exec(migration);
    assert.deepEqual((await raw.query('SELECT * FROM attachment_uploads')).rows,[{id:'old',size:3,completing_at:null,last_part_at:null}]);
    await raw.exec(`INSERT INTO attachment_uploads(id,size) VALUES ('legacy',4);UPDATE attachment_uploads SET completing_at='2026-10-09T12:00:00Z',last_part_at='2026-10-09T11:00:00Z' WHERE id='old'`);await raw.exec(migration);
    const rows=(await raw.query<{id:string;completing_at:Date|null;last_part_at:Date|null}>(`SELECT id,completing_at,last_part_at FROM attachment_uploads ORDER BY id`)).rows;
    assert.equal(rows[0].completing_at,null);assert.equal(rows[0].last_part_at,null);assert.equal(new Date(rows[1].completing_at!).toISOString(),'2026-10-09T12:00:00.000Z');assert.equal(new Date(rows[1].last_part_at!).toISOString(),'2026-10-09T11:00:00.000Z');
  }finally{await raw.close();}
});

test('R129 0133 повторяется, default false сохраняет старый смысл и прежнюю вставку',async()=>{
  // Ловит принудительный перевод старых папок и потерю собственного режима при повторном старте.
  const raw=new PGlite();
  try{
    await raw.exec(`CREATE TABLE dm_folders(id text PRIMARY KEY,pinned_ids text[] NOT NULL DEFAULT '{}');INSERT INTO dm_folders VALUES ('old',ARRAY['two','one'])`);
    const migration=await readFile(new URL('../drizzle/0133_dm_folder_pinned_own.sql',import.meta.url),'utf8');await raw.exec(migration);
    assert.deepEqual((await raw.query('SELECT * FROM dm_folders')).rows,[{id:'old',pinned_ids:['two','one'],pinned_own:false}]);
    await raw.exec(`INSERT INTO dm_folders(id,pinned_ids) VALUES ('legacy',ARRAY['one']);UPDATE dm_folders SET pinned_own=true WHERE id='old'`);await raw.exec(migration);
    assert.deepEqual((await raw.query('SELECT * FROM dm_folders ORDER BY id')).rows,[{id:'legacy',pinned_ids:['one'],pinned_own:false},{id:'old',pinned_ids:['two','one'],pinned_own:true}]);
    await assert.rejects(()=>raw.exec(`UPDATE dm_folders SET pinned_own=NULL WHERE id='old'`),/not-null|null value/i);
  }finally{await raw.close();}
});

test('R127 0132 повторяется без потерь, старые attachments вставляются, FK каскадно стирает загрузку и части',async()=>{
  // Ловит неповторяемый старт, несовместимую старую запись и сироты после удаления членства.
  const raw=new PGlite();
  try{
    await raw.exec(`CREATE TABLE conversation_members(conversation_id text,user_id text,PRIMARY KEY(conversation_id,user_id));
      CREATE TABLE attachments(id text PRIMARY KEY,owner_id text,created_at timestamptz DEFAULT now());
      INSERT INTO conversation_members VALUES ('dm','a');INSERT INTO attachments(id,owner_id) VALUES ('old','a')`);
    const migration=await readFile(new URL('../drizzle/0132_attachment_uploads.sql',import.meta.url),'utf8');await raw.exec(migration);
    await raw.exec(`INSERT INTO attachment_uploads(id,conversation_id,owner_id,storage_key,s3_upload_id,name,declared_type,size,part_size)
      VALUES ('upload','dm','a','dm/upload','s3-upload','file','application/octet-stream',3,8);
      INSERT INTO attachment_upload_parts VALUES ('upload',1,'etag',3);INSERT INTO attachments(id,owner_id) VALUES ('legacy','a')`);
    await raw.exec(migration);
    assert.equal((await raw.query('SELECT * FROM attachment_uploads')).rows.length,1);assert.equal((await raw.query('SELECT * FROM attachment_upload_parts')).rows.length,1);
    assert.equal((await raw.query('SELECT * FROM attachments')).rows.length,2);
    const indexes=(await raw.query<{indexname:string}>(`SELECT indexname FROM pg_indexes`)).rows.map(r=>r.indexname);
    for(const index of ['attachment_uploads_owner_idx','attachment_uploads_created_idx','attachments_owner_created_idx'])assert.ok(indexes.includes(index),index);
    await assert.rejects(()=>raw.exec(`INSERT INTO attachment_upload_parts VALUES ('missing',1,'etag',3)`),/foreign key/i);
    await raw.exec(`DELETE FROM conversation_members`);
    assert.equal((await raw.query('SELECT * FROM attachment_uploads')).rows.length,0);assert.equal((await raw.query('SELECT * FROM attachment_upload_parts')).rows.length,0);
    assert.equal((await raw.query('SELECT * FROM attachments')).rows.length,2,'прежние файлы не затронуты');
  }finally{await raw.close();}
});

test('R126 0130 повторяема, сохраняет отметку и допускает старую вставку без frequent_hidden_at',async()=>{
  // Ловит потерю персональной отметки при повторе миграции и поломку откатного писателя.
  const raw=new PGlite();
  try{
    await raw.exec(`CREATE TABLE conversation_members(conversation_id text,user_id text);INSERT INTO conversation_members VALUES ('old','a')`);
    const migration=await readFile(new URL('../drizzle/0130_conv_frequent_hidden.sql',import.meta.url),'utf8');
    await raw.exec(migration);
    assert.deepEqual((await raw.query(`SELECT frequent_hidden_at FROM conversation_members`)).rows,[{frequent_hidden_at:null}]);
    await raw.exec(`UPDATE conversation_members SET frequent_hidden_at='2026-10-09T10:00:00Z';INSERT INTO conversation_members(conversation_id,user_id) VALUES ('legacy','a')`);
    await raw.exec(migration);
    const rows=(await raw.query<{conversation_id:string;frequent_hidden_at:Date|null}>(`SELECT * FROM conversation_members ORDER BY conversation_id`)).rows;
    assert.equal(rows[0].frequent_hidden_at,null);assert.equal(new Date(rows[1].frequent_hidden_at!).toISOString(),'2026-10-09T10:00:00.000Z');
  }finally{await raw.close();}
});
test('R126 0131 даёт пустой pinned_ids старым строкам и старым вставкам, повтор сохраняет порядок',async()=>{
  // Ловит NULL вместо массива по умолчанию и сброс собственного порядка повторным запуском.
  const raw=new PGlite();
  try{
    await raw.exec(`CREATE TABLE dm_folders(id text PRIMARY KEY,user_id text);INSERT INTO dm_folders VALUES ('old','a')`);
    const migration=await readFile(new URL('../drizzle/0131_dm_folder_pinned.sql',import.meta.url),'utf8');await raw.exec(migration);
    assert.deepEqual((await raw.query(`SELECT pinned_ids FROM dm_folders`)).rows,[{pinned_ids:[]}]);
    await raw.exec(`INSERT INTO dm_folders(id,user_id) VALUES ('legacy','a');UPDATE dm_folders SET pinned_ids=ARRAY['two','one'] WHERE id='old'`);
    await raw.exec(migration);
    assert.deepEqual((await raw.query(`SELECT id,pinned_ids FROM dm_folders ORDER BY id`)).rows,[{id:'legacy',pinned_ids:[]},{id:'old',pinned_ids:['two','one']}]);
    await assert.rejects(()=>raw.exec(`UPDATE dm_folders SET pinned_ids=NULL WHERE id='old'`),/not-null|null value/i);
  }finally{await raw.close();}
});

test('0128 сохраняет старое устройство с NULL поясом, повторяема и совместима со старой вставкой', async () => {
  const raw = new PGlite();
  try {
    await raw.exec(`CREATE TABLE push_devices (id text PRIMARY KEY, endpoint text NOT NULL);
      INSERT INTO push_devices VALUES ('old','https://example.test/old')`);
    const { migrationsDir } = await import('../src/db/index.js');
    const migration = await readFile(join(migrationsDir, '0128_push_device_tz.sql'), 'utf8');
    await raw.exec(migration);
    assert.deepEqual((await raw.query('SELECT * FROM push_devices')).rows, [{ id: 'old', endpoint: 'https://example.test/old', tz: null }]);
    await raw.exec(`INSERT INTO push_devices (id,endpoint) VALUES ('rollback','https://example.test/new');
      UPDATE push_devices SET tz='Europe/Moscow' WHERE id='old'`);
    await raw.exec(migration);
    assert.deepEqual((await raw.query('SELECT id,tz FROM push_devices ORDER BY id')).rows, [{ id: 'old', tz: 'Europe/Moscow' }, { id: 'rollback', tz: null }]);
  } finally { await raw.close(); }
});

async function beforeScheduledMedia() {
  const { raw, migration } = await beforePins();
  const { migrationsDir } = await import('../src/db/index.js');
  await raw.exec(migration);
  for (const name of ['0084_conv_silent.sql','0085_conv_scheduled.sql','0086_conv_pending_members.sql']) {
    // Имя 0086 берём из реального каталога, чтобы фикстура не подменяла порядок миграций.
    const file = name.startsWith('0086') ? (await readdir(migrationsDir)).find(f => f.startsWith('0086_'))! : name;
    await raw.exec(await readFile(join(migrationsDir,file),'utf8'));
  }
  await raw.exec(`INSERT INTO conversation_scheduled(id,conversation_id,author_id,client_id,payload_hash,content,when_online)
    VALUES ('media-sched','pins','live','media-client','hash','caption',true);
    INSERT INTO attachments(id,conversation_id,owner_id,storage_key,name,content_type,size,state)
    VALUES ('media-att','pins','live','media-key','a.png','image/png',10,'pending');`);
  return { raw, migration: await readFile(join(migrationsDir,'0087_conv_scheduled_attachments.sql'),'utf8') };
}

test('0087 поверх 0086 сохраняет старые строки, повторяема и создаёт индексы с отложенной ссылкой', async () => {
  // Откатный писатель не знает новых полей: прежние вставки должны сохраняться, а повтор старта — не менять данные.
  const {raw,migration}=await beforeScheduledMedia();
  try {
    const before=(await raw.query(`SELECT id,content FROM conversation_scheduled`)).rows;
    await raw.exec(migration);
    assert.deepEqual((await raw.query(`SELECT id,content FROM conversation_scheduled`)).rows,before);
    assert.deepEqual((await raw.query(`SELECT attachments FROM conversation_scheduled`)).rows,[{attachments:[]}]);
    assert.deepEqual((await raw.query(`SELECT state,scheduled_id FROM attachments`)).rows,[{state:'pending',scheduled_id:null}]);
    await raw.exec(`UPDATE attachments SET state='scheduled',scheduled_id='media-sched' WHERE id='media-att'`);
    await raw.exec(migration);
    assert.deepEqual((await raw.query(`SELECT state,scheduled_id FROM attachments`)).rows,[{state:'scheduled',scheduled_id:'media-sched'}]);
    const indexes=(await raw.query<{indexname:string;indexdef:string}>(`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='attachments'`)).rows;
    assert.match(indexes.find(x=>x.indexname==='attachments_scheduled_idx')?.indexdef??'',/scheduled_id.*WHERE.*IS NOT NULL/i);
    assert.match(indexes.find(x=>x.indexname==='attachments_owner_scheduled_idx')?.indexdef??'',/owner_id.*WHERE.*scheduled/i);
    assert.deepEqual((await raw.query(`SELECT condeferrable,condeferred,confdeltype FROM pg_constraint WHERE conname='attachments_scheduled_id_fkey'`)).rows,
      [{condeferrable:true,condeferred:true,confdeltype:'a'}]);
  } finally {await raw.close();}
});

test('0087 проверяет оба CHECK сразу, а удаление отложенного — при COMMIT с возможностью починить ссылку', async () => {
  // Старый такт без перевода вложений обязан откатиться; новый может удалить сначала отложенное, затем освободить файлы.
  const {raw,migration}=await beforeScheduledMedia();
  try {
    await raw.exec(migration);
    for (const state of ['pending','attached','deleted']) {
      await raw.query(`UPDATE attachments SET state=$1 WHERE id='media-att'`,[state]);
      assert.equal((await raw.query<{state:string}>(`SELECT state FROM attachments`)).rows[0]?.state,state,'прежние состояния без scheduled_id остаются допустимыми');
    }
    await raw.exec(`UPDATE attachments SET state='pending' WHERE id='media-att'`);
    await assert.rejects(raw.exec(`UPDATE attachments SET state='unknown' WHERE id='media-att'`),/attachments_state_check/);
    await assert.rejects(raw.exec(`UPDATE attachments SET state='scheduled' WHERE id='media-att'`),/attachments_scheduled_check/);
    await assert.rejects(raw.exec(`UPDATE attachments SET scheduled_id='media-sched' WHERE id='media-att'`),/attachments_scheduled_check/);
    await raw.exec(`UPDATE attachments SET state='scheduled',scheduled_id='media-sched' WHERE id='media-att'`);
    await raw.exec('BEGIN');
    await raw.exec(`DELETE FROM conversation_scheduled WHERE id='media-sched'`);
    assert.equal((await raw.query(`SELECT * FROM conversation_scheduled`)).rows.length,0,'DELETE ещё не отказал до фиксации');
    await assert.rejects(raw.exec('COMMIT'),/attachments_scheduled_id_fkey/);
    await raw.exec('ROLLBACK');
    assert.equal((await raw.query(`SELECT * FROM conversation_scheduled`)).rows.length,1,'откат вернул отложенное');
    await raw.exec(`BEGIN; DELETE FROM conversation_scheduled WHERE id='media-sched';
      UPDATE attachments SET state='deleted',scheduled_id=NULL WHERE id='media-att'; COMMIT;`);
    assert.equal((await raw.query(`SELECT * FROM conversation_scheduled`)).rows.length,0);
    assert.deepEqual((await raw.query(`SELECT state,scheduled_id FROM attachments`)).rows,[{state:'deleted',scheduled_id:null}]);
  } finally {await raw.close();}
});

test('0087 отвергает неизвестную отложенную ссылку при фиксации и сохраняет каскад выхода автора', async () => {
  // Неотложенная FK ломает порядок новых транзакций, а отсутствие проверки оставляет файлы без хозяина.
  const {raw,migration}=await beforeScheduledMedia();
  try {
    await raw.exec(migration);
    await raw.exec(`BEGIN; UPDATE attachments SET state='scheduled',scheduled_id='missing' WHERE id='media-att';`);
    assert.equal((await raw.query<{scheduled_id:string}>(`SELECT scheduled_id FROM attachments`)).rows[0]?.scheduled_id,'missing');
    await assert.rejects(raw.exec('COMMIT'),/attachments_scheduled_id_fkey/);
    await raw.exec('ROLLBACK');
    await raw.exec(`UPDATE attachments SET state='scheduled',scheduled_id='media-sched' WHERE id='media-att';
      DELETE FROM conversation_members WHERE conversation_id='pins' AND user_id='live';`);
    assert.equal((await raw.query(`SELECT * FROM attachments`)).rows.length,0);
    assert.equal((await raw.query(`SELECT * FROM conversation_scheduled`)).rows.length,0);
  } finally {await raw.close();}
});

let t: TestDb;

before(async () => {
  t = await createTestDb();
});

after(async () => t.close());

test('чистая база применяет каждый SQL-файл ровно один раз', async () => {
  // Ловит забытый файл, неверный порядок и расхождение таблицы учёта с реально применёнными миграциями.
  const { migrationsDir, migrationOrder, migrationPlan } = await import('../src/db/index.js');
  const expected = migrationOrder(await readdir(migrationsDir));
  const recorded = await t.raw.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
  assert.deepEqual(t.appliedMigrations, expected);
  assert.deepEqual(recorded.rows.map((r) => r.name), expected);
  assert.equal(new Set(recorded.rows.map((r) => r.name)).size, expected.length);
  for (const prefix of ['0114_', '0121_', '0125_', '0129_']) {
    const file = expected.find((name) => name.startsWith(prefix));
    assert.ok(file, `есть migration ${prefix}`);
    assert.equal(migrationPlan(await readFile(join(migrationsDir, file), 'utf8')).transaction, false,
      `${file} с CREATE INDEX CONCURRENTLY идёт без транзакции`);
  }
  const indexes = await t.raw.query<{ name: string; valid: boolean }>(`
    SELECT indexrelid::regclass::text AS name, indisvalid AS valid FROM pg_index
    WHERE indexrelid IN ('conversation_messages_author_conv_idx'::regclass,'conversation_messages_author_time_idx'::regclass,'conv_messages_media_idx'::regclass,'conv_messages_voice_idx'::regclass)
    ORDER BY name`);
  assert.deepEqual(indexes.rows.map((row) => row.name), ['conv_messages_media_idx', 'conv_messages_voice_idx', 'conversation_messages_author_conv_idx', 'conversation_messages_author_time_idx']);
  assert.ok(indexes.rows.every((row) => row.valid), 'после последовательности no-transaction шагов индексы валидны');
  const frequentIndex = (await t.raw.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname='conversation_messages_author_time_idx'`)).rows[0];
  assert.match(frequentIndex.indexdef, /\(author_id, created_at\)/);
  assert.match(frequentIndex.indexdef, /WHERE.*deleted_at IS NULL.*service IS NULL/);
});

test('migrationPlan включает режим без транзакции только по первой строке и делит повторяемые шаги', async () => {
  // CREATE INDEX CONCURRENTLY нельзя оборачивать в BEGIN; поздний маркер не должен случайно менять способ применения файла.
  const { migrationPlan, NO_TRANSACTION_MARK } = await import('../src/db/index.js');
  const marked = '\uFEFF-- gv:no-transaction\r\n-- gv:step\r\nCREATE INDEX CONCURRENTLY a ON t (id);\r\n-- gv:step optional\r\n-- only comments\r\n-- gv:step\r\nDROP INDEX CONCURRENTLY IF EXISTS a;';
  assert.deepEqual(migrationPlan(marked), {
    transaction: false,
    steps: [
      { sql: 'CREATE INDEX CONCURRENTLY a ON t (id);\n', optional: false },
      { sql: 'DROP INDEX CONCURRENTLY IF EXISTS a;\n', optional: false },
    ],
  });
  assert.deepEqual(migrationPlan('SELECT 1;'), { transaction: true, sql: 'SELECT 1;' });
  const lateMarker = '\n-- gv:no-transaction\n-- gv:step\nCREATE INDEX CONCURRENTLY a ON t (id);';
  assert.deepEqual(migrationPlan(lateMarker), { transaction: true, sql: lateMarker });

  const source = migrationPlan.toString().replace(/\r\n/g, '\n');
  const laterAnywhere = source.replace('(lines[0]??"").trim()!==NO_TRANSACTION_MARK', '!lines.some(line=>line.trim()===NO_TRANSACTION_MARK)');
  assert.notEqual(laterAnywhere, source, 'мутация должна переносить распознавание маркера с первой строки на любую');
  const mutant = runInNewContext(`(${laterAnywhere})`, { NO_TRANSACTION_MARK }) as typeof migrationPlan;
  assert.throws(() => assert.deepEqual(mutant(lateMarker), { transaction: true, sql: lateMarker }), assert.AssertionError,
    'мутант включает режим по позднему маркеру и ломает контракт');

  const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
  const postgresStart = compose.indexOf('\n  postgres:') + 1;
  assert.ok(postgresStart > 0, 'compose содержит сервис postgres');
  const nextService = /^  [A-Za-z0-9_-]+:\s*$/gm;
  nextService.lastIndex = postgresStart + 1;
  const next = nextService.exec(compose);
  const postgres = compose.slice(postgresStart, next?.index ?? compose.length);
  assert.match(postgres, /command:\s*\[[^\]]*['"]jit=off['"]/,
    'только аргументы postgres: JIT выключен для дорогого поиска по типу медиа');
});

test('0075 с ключами пуша применяется после всей схемы 0074', () => {
  // Ловит неверную сортировку миграций, при которой ALTER пуш-таблицы идёт раньше её актуальной базы.
  const before = t.appliedMigrations.indexOf('0074_federation_links_confirm_pending.sql');
  const crypto = t.appliedMigrations.indexOf('0075_push_devices_webpush_keys.sql');
  assert.ok(before >= 0, 'не найдена миграция 0074');
  assert.equal(crypto, before + 1);
});

test('0077 добавляет непустой по умолчанию массив скрывших без новой ссылки на users', async () => {
  // Ловит миграцию, которая ломает старые строки ЛС или неожиданно меняет политику удаления аккаунта.
  const before = t.appliedMigrations.indexOf('0076_user_blocks.sql');
  const hidden = t.appliedMigrations.indexOf('0077_dm_hidden_for.sql');
  assert.equal(hidden, before + 1);
  const column = await t.raw.query<{ is_nullable: string; column_default: string }>(`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'dm_messages' AND column_name = 'hidden_for'
  `);
  assert.equal(column.rows[0]?.is_nullable, 'NO');
  assert.match(column.rows[0]?.column_default ?? '', /\{\}/);
  const fks = await t.raw.query(`
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_name = 'dm_messages' AND column_name = 'hidden_for'
  `);
  assert.equal(fks.rows.length, 0);
});

test('0062 одобряет всех пользователей, существовавших до миграции', async () => {
  // Ловит выкладку, после которой старые аккаунты внезапно оказываются ожидающими ручного одобрения.
  const raw = new PGlite();
  try {
    const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
    const files = migrationOrder(await readdir(migrationsDir));
    for (const file of files) {
      if (file === '0062_registration_approval.sql') break;
      await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    }
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at)
      VALUES ('before-0062', 'BeforeApproval', 'Before Approval', 'hash', '2025-05-06T07:08:09Z')
    `);
    await raw.exec(await readFile(join(migrationsDir, '0062_registration_approval.sql'), 'utf8'));
    const result = await raw.query<{ created_at: Date; approved_at: Date | null }>(
      `SELECT created_at, approved_at FROM users WHERE id = 'before-0062'`,
    );
    assert.equal(result.rows[0]?.approved_at?.toISOString(), result.rows[0]?.created_at.toISOString());
  } finally {
    await raw.close();
  }
});

async function beforeDmMove(): Promise<{ raw: PGlite; migration: string }> {
  const raw = new PGlite();
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  const files = migrationOrder(await readdir(migrationsDir));
  const migration = await readFile(join(migrationsDir, '0079_dm_to_conversations.sql'), 'utf8');
  for (const file of files) {
    if (file === '0079_dm_to_conversations.sql') break;
    await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  await raw.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
  return { raw, migration };
}

async function checkDmMove(window = true): Promise<void> {
  // Ловит перестановку сообщений внутри миллисекунды и вспышку старого unread после миграции.
  const { raw, migration } = await beforeDmMove();
  try {
    // Одна база времени во всех INSERT: тест не стареет и не теряет микросекунды в JS Date.
    await raw.exec("CREATE TEMP TABLE fixture_clock AS SELECT date_trunc('second', now()) - interval '1 day' AS base");
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash) VALUES
        ('a','a','A','hash'),('b','b','B','hash'),('c','c','C','hash'),('d','d','D','hash');
      INSERT INTO dm_channels (id, user_a, user_b) VALUES
        ('ab','a','b'),('ac','a','c'),('empty','b','d');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content, created_at) VALUES
        ('z','ab','b','first',(SELECT base FROM fixture_clock) + interval '100 microseconds'),
        ('a','ab','b','second',(SELECT base FROM fixture_clock) + interval '900 microseconds'),
        ('same-b','ab','b','same',(SELECT base FROM fixture_clock) + interval '1000 microseconds'),
        ('same-a','ab','b','same',(SELECT base FROM fixture_clock) + interval '1000 microseconds'),
        ('same-c','ab','b','same',(SELECT base FROM fixture_clock) + interval '1000 microseconds'),
        ('next-us','ab','b','next',(SELECT base FROM fixture_clock) + interval '1001 microseconds');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content, created_at) VALUES
        ('old','ac','c','old', now() - interval '15 days'),
        ('young','ac','c','young', now() - interval '13 days');
      INSERT INTO dm_reads (dm_channel_id, user_id, last_read_at) VALUES
        ('ab','a',(SELECT base FROM fixture_clock) + interval '1000 microseconds'),
        ('ab','b',now() + interval '1 day');
      UPDATE dm_messages SET hidden_for = ARRAY['a'] WHERE id = 'same-c';
      UPDATE dm_messages SET withheld = true WHERE id = 'next-us';
      UPDATE dm_messages SET reply_to_id = 'a' WHERE id = 'same-a';
      INSERT INTO dm_message_reactions (message_id, user_id, emoji) VALUES ('a','a','👍');
    `);
    const oldOrder = (await raw.query<{ id: string }>(
      `SELECT id FROM dm_messages WHERE dm_channel_id = 'ab' ORDER BY created_at, id`,
    )).rows.map((r) => r.id);
    const oldUnread = (await raw.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM dm_messages m WHERE m.dm_channel_id = 'ac' AND m.author_id <> 'a'
        AND m.created_at > now() - interval '14 days' AND NOT m.withheld AND NOT ('a' = ANY(m.hidden_for))
    `)).rows[0]?.n;

    const sql = window ? migration : migration.replace("now() - interval '14 days'", "'-infinity'::timestamptz");
    if (!window) assert.notEqual(sql, migration);
    await raw.exec(`BEGIN; ${sql} INSERT INTO _migrations (name) VALUES ('0079_dm_to_conversations.sql'); COMMIT;`);
    const moved = (await raw.query<{ id: string; sort_key: number }>(
      `SELECT id, sort_key FROM conversation_messages WHERE conversation_id = 'ab' ORDER BY sort_key`,
    )).rows;
    assert.deepEqual(moved.map((r) => r.id), oldOrder);
    assert.equal(new Set(moved.map((r) => String(r.sort_key))).size, moved.length);
    for (let i = 1; i < moved.length; i++) assert.ok(Number(moved[i]!.sort_key) > Number(moved[i - 1]!.sort_key));
    const members = await raw.query<{ user_id: string; last_read_key: number }>(
      `SELECT user_id, last_read_key FROM conversation_members WHERE conversation_id = 'ab' ORDER BY user_id`,
    );
    const keyOf = (id: string) => Number(moved.find((r) => r.id === id)?.sort_key);
    // Старая отметка была временем: включает ВСЕ строки с тем же timestamp, в том числе соседний id.
    assert.equal(Number(members.rows[0]?.last_read_key), keyOf('same-c'));
    assert.equal(Number(members.rows[1]?.last_read_key), keyOf('next-us'));
    const newUnread = (await raw.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM conversation_messages m JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id AND cm.user_id = 'a'
      WHERE m.conversation_id = 'ac' AND m.author_id <> 'a' AND m.sort_key > cm.last_read_key
        AND NOT m.withheld AND m.deleted_at IS NULL AND NOT ('a' = ANY(m.hidden_for))
    `)).rows[0]?.n;
    assert.equal(newUnread, oldUnread);
    assert.equal(newUnread, 1);
    const links = await raw.query<{ reply_to_id: string; hidden_for: string[] }>(
      `SELECT reply_to_id, hidden_for FROM conversation_messages WHERE id = 'same-a'`,
    );
    assert.equal(links.rows[0]?.reply_to_id, 'a');
    assert.deepEqual((await raw.query(`SELECT emoji FROM conversation_message_reactions WHERE message_id = 'a'`)).rows,
      [{ emoji: '👍' }]);
    assert.deepEqual((await raw.query<{ hidden_for: string[] }>(`SELECT hidden_for FROM conversation_messages WHERE id = 'same-c'`)).rows[0]?.hidden_for, ['a']);
    assert.equal((await raw.query<{ withheld: boolean }>(`SELECT withheld FROM conversation_messages WHERE id = 'next-us'`)).rows[0]?.withheld, true);
    assert.equal(Number((await raw.query<{ last_sort_key: number }>(`SELECT last_sort_key FROM conversations WHERE id = 'empty'`)).rows[0]?.last_sort_key), 0);
    assert.equal((await raw.query(`SELECT id FROM dm_messages`)).rows.length, 8);
  } finally {
    await raw.close();
  }
}

test('0079 сохраняет старый порядок, связи и непрочитанное при переносе живых ЛС', () => checkDmMove());

test('0079 без окна непрочитанного возвращает старые сообщения — контрфакт отклоняется', async () => {
  // Ловит ослабление фикстуры: тот же сценарий обязан отвергать потерю 14-дневного окна.
  await assert.rejects(checkDmMove(false), assert.AssertionError);
});

test('0079 отказывается от непустой таблицы бесед и не переносит ничего частично', async () => {
  // Ловит смешение старых и новых ЛС после неудачного старта миграции.
  const { raw, migration } = await beforeDmMove();
  try {
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash) VALUES ('a','a','A','hash'),('b','b','B','hash');
      INSERT INTO dm_channels (id, user_a, user_b) VALUES ('old','a','b');
      INSERT INTO dm_messages (id, dm_channel_id, author_id, content) VALUES ('old-msg','old','a','old');
      INSERT INTO conversations (id, kind, direct_key) VALUES ('existing','direct','a:b');
    `);
    await assert.rejects(raw.exec(`BEGIN; ${migration} INSERT INTO _migrations (name) VALUES ('0079_dm_to_conversations.sql'); COMMIT;`),
      /не пуста/);
    await raw.exec('ROLLBACK');
    assert.deepEqual((await raw.query(`SELECT id FROM conversations`)).rows, [{ id: 'existing' }]);
    assert.equal((await raw.query(`SELECT id FROM conversation_messages`)).rows.length, 0);
    assert.deepEqual((await raw.query(`SELECT id FROM dm_messages`)).rows, [{ id: 'old-msg' }]);
    assert.equal((await raw.query(`SELECT name FROM _migrations`)).rows.length, 0);
  } finally {
    await raw.close();
  }
});

async function beforePins(): Promise<{ raw: PGlite; migration: string }> {
  const raw = new PGlite();
  const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
  for (const file of migrationOrder(await readdir(migrationsDir))) {
    if (file === '0083_conv_pins.sql') break;
    await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  await raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash, deleted_at) VALUES
      ('dead', 'dead', 'Удалённый пользователь', 'hash', now()),
      ('live', 'live', 'Удалённый пользователь', 'hash', NULL),
      ('viewer', 'viewer', 'Viewer', 'hash', NULL);
    INSERT INTO conversations (id, kind, direct_key) VALUES ('pins', 'direct', 'live:viewer');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES ('pins', 'live'), ('pins', 'viewer');
    INSERT INTO conversation_messages (id, conversation_id, author_id, sort_key, forwarded_from, deleted_at) VALUES
      ('dead-copy', 'pins', 'live', 1, '{"userId":"dead","displayName":"Old name","at":"2026-01-01T00:00:00Z"}', NULL),
      ('dead-tombstone', 'pins', 'live', 2, '{"userId":"dead","displayName":"Old name","at":"2026-01-02T00:00:00Z"}', now()),
      ('live-copy', 'pins', 'live', 3, '{"userId":"live","displayName":"Удалённый пользователь","at":"2026-01-03T00:00:00Z"}', NULL),
      ('already', 'pins', 'live', 4, '{"userId":"dead","displayName":"Anonymized","at":"2026-01-04T00:00:00Z","deleted":true}', NULL),
      ('plain', 'pins', 'live', 5, NULL, NULL);
  `);
  return { raw, migration: await readFile(join(migrationsDir, '0083_conv_pins.sql'), 'utf8') };
}

test('0083 дополняет старые снимки удалённых авторов, но не узнаёт удаление по имени', async () => {
  // Ловит пропущенные старые/надгробные снимки и ложное удаление живого тёзки; повтор не меняет байты JSONB.
  const { raw, migration } = await beforePins();
  try {
    const snapshots = () => raw.query<{ id: string; snapshot: string | null }>(
      `SELECT id, forwarded_from::text AS snapshot FROM conversation_messages ORDER BY id`,
    );
    const before = (await snapshots()).rows;
    await raw.exec(migration);
    const after = (await snapshots()).rows;
    for (const row of before) {
      const actual = after.find((r) => r.id === row.id)?.snapshot;
      if (row.id === 'dead-copy' || row.id === 'dead-tombstone') {
        assert.deepEqual(JSON.parse(actual!), { ...JSON.parse(row.snapshot!), deleted: true });
      } else assert.equal(actual, row.snapshot);
    }
    await raw.exec(migration);
    assert.deepEqual((await snapshots()).rows, after);
  } finally { await raw.close(); }
});

test('0083 разрешает журнал закрепа и создаёт отдельные строки с каскадом по сообщению', async () => {
  // Ловит схему, которая теряет личные закрепы, не принимает новый kind или оставляет сирот после удаления сообщения.
  const { raw, migration } = await beforePins();
  try {
    await raw.exec(migration);
    await raw.exec(`
      INSERT INTO user_sync (user_id) VALUES ('live');
      INSERT INTO user_changes (user_id, pts, conversation_id, kind) VALUES ('live', 1, 'pins', 'pin');
      INSERT INTO conversation_pins (conversation_id, user_id, message_id, pinned_by) VALUES
        ('pins', 'live', 'plain', 'viewer'), ('pins', 'viewer', 'plain', 'live');
    `);
    assert.deepEqual((await raw.query(`SELECT user_id, for_both FROM conversation_pins ORDER BY user_id`)).rows,
      [{ user_id: 'live', for_both: false }, { user_id: 'viewer', for_both: false }]);
    assert.deepEqual((await raw.query(`SELECT kind, message_id FROM user_changes`)).rows, [{ kind: 'pin', message_id: null }]);
    await assert.rejects(raw.exec(`INSERT INTO conversation_pins (conversation_id, user_id, message_id, pinned_by)
      VALUES ('pins', 'live', 'plain', 'live')`), /duplicate key/);
    await assert.rejects(raw.exec(`INSERT INTO conversation_pins (conversation_id, user_id, message_id, pinned_by)
      VALUES ('pins', 'dead', 'plain', 'live')`), /foreign key/);
    await assert.rejects(raw.exec(`INSERT INTO conversation_pins (conversation_id, user_id, message_id, pinned_by)
      VALUES ('pins', 'live', 'live-copy', 'dead')`), /foreign key/);
    await raw.exec(`DELETE FROM conversation_messages WHERE id = 'plain'`);
    assert.equal((await raw.query(`SELECT * FROM conversation_pins`)).rows.length, 0);
  } finally { await raw.close(); }
});

test('0070 переносит существующие пары членства в поручительства без дублей', async () => {
  // Ловит выкладку, после которой старые гости перестают получать обновления и пуши до повторного входа.
  const raw = new PGlite();
  try {
    const { migrationsDir, migrationOrder } = await import('../src/db/index.js');
    const files = migrationOrder(await readdir(migrationsDir));
    for (const file of files) {
      if (file === '0070_federation_guest_grants.sql') break;
      await raw.exec(await readFile(join(migrationsDir, file), 'utf8'));
    }
    await raw.exec(`
      INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('local', 'local', 'Local', 'hash');
      INSERT INTO federation_memberships
        (instance_id, user_id, server_id, server_name, state, updated_at)
      VALUES
        ('peer', 'local', 'one', 'One', 'active', 1),
        ('peer', 'local', 'two', 'Two', 'active', 2)
    `);
    await raw.exec(await readFile(join(migrationsDir, '0070_federation_guest_grants.sql'), 'utf8'));
    const result = await raw.query<{ user_id: string; instance_id: string }>(
      `SELECT user_id, instance_id FROM federation_guest_grants`,
    );
    assert.deepEqual(result.rows, [{ user_id: 'local', instance_id: 'peer' }]);
  } finally {
    await raw.close();
  }
});

test('0084 поверх 0083 сохраняет старые сообщения и даёт silent false вставкам отката', async () => {
  // Ловит неожиданно тихие старые сообщения и обязательный новый столбец, ломающий старый бэкенд.
  const { raw, migration } = await beforePins();
  try {
    await raw.exec(migration);
    const { migrationsDir } = await import('../src/db/index.js');
    const silent = await readFile(join(migrationsDir, '0084_conv_silent.sql'), 'utf8');
    await raw.exec(silent);
    assert.equal((await raw.query(`SELECT * FROM conversation_messages WHERE silent`)).rows.length, 0);
    await raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,sort_key,content)
      VALUES ('rollback-silent','pins','live',6,'old writer');
      UPDATE conversation_messages SET silent=true WHERE id='plain'`);
    await raw.exec(silent);
    assert.deepEqual((await raw.query(`SELECT id,silent FROM conversation_messages WHERE id IN ('plain','rollback-silent') ORDER BY id`)).rows,
      [{ id: 'plain', silent: true }, { id: 'rollback-silent', silent: false }]);
    await assert.rejects(raw.exec(`UPDATE conversation_messages SET silent=NULL WHERE id='plain'`), /not-null/);
  } finally { await raw.close(); }
});

test('0085 поверх 0084 добавляет отложенные с единственным режимом, авторским ключом и новым журналом', async () => {
  // Ловит выкладку без режима/индексов, сироты отложенного и запрет нового kind существующим CHECK.
  const { raw, migration } = await beforePins();
  try {
    await raw.exec(migration);
    const { migrationsDir } = await import('../src/db/index.js');
    await raw.exec(await readFile(join(migrationsDir, '0084_conv_silent.sql'), 'utf8'));
    const sched = await readFile(join(migrationsDir, '0085_conv_scheduled.sql'), 'utf8');
    await raw.exec(sched);
    await raw.exec(`INSERT INTO conversation_scheduled (id,conversation_id,author_id,client_id,payload_hash,content,send_at)
      VALUES ('time','pins','live','client-time','hash','later','2026-12-01T00:00:00Z');
      INSERT INTO conversation_scheduled (id,conversation_id,author_id,client_id,payload_hash,content,when_online)
      VALUES ('online','pins','viewer','client-online','hash','online',true);
      INSERT INTO user_sync (user_id) VALUES ('live');
      INSERT INTO user_changes (user_id,pts,conversation_id,kind) VALUES ('live',1,'pins','sched');`);
    const before = (await raw.query(`SELECT * FROM conversation_scheduled ORDER BY id`)).rows;
    await raw.exec(sched);
    assert.deepEqual((await raw.query(`SELECT * FROM conversation_scheduled ORDER BY id`)).rows, before);
    assert.deepEqual((await raw.query(`SELECT kind,message_id FROM user_changes`)).rows, [{ kind: 'sched', message_id: null }]);
    const insert = `INSERT INTO conversation_scheduled (id,conversation_id,author_id,client_id,payload_hash,content,send_at,when_online) VALUES`;
    await assert.rejects(raw.exec(`${insert} ('none','pins','live','none','hash','x',NULL,false)`), /mode_check/);
    await assert.rejects(raw.exec(`${insert} ('both','pins','live','both','hash','x',now(),true)`), /mode_check/);
    await assert.rejects(raw.exec(`${insert} ('duplicate','pins','live','client-time','hash','x',now(),false)`), /duplicate key/);
    await assert.rejects(raw.exec(`${insert} ('foreign','pins','dead','foreign','hash','x',now(),false)`), /foreign key/);
    const indexes = (await raw.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename='conversation_scheduled'`)).rows.map((r) => r.indexname);
    for (const name of ['conversation_scheduled_client_uq','conversation_scheduled_owner_idx','conversation_scheduled_due_idx','conversation_scheduled_online_idx']) {
      assert.ok(indexes.includes(name), `индекс ${name} создан`);
    }
    await raw.exec(`DELETE FROM conversation_members WHERE conversation_id='pins' AND user_id='live'`);
    assert.deepEqual((await raw.query(`SELECT id FROM conversation_scheduled`)).rows, [{ id: 'online' }]);
  } finally { await raw.close(); }
});
