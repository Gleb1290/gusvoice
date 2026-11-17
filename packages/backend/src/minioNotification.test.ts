import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
type NotificationApi = Pick<typeof import('minio'), 'NotificationPoller'>;
type ParserFactory = {
    asStream(options: import('node:stream').DuplexOptions): import('node:stream').Duplex;
};
type RequestArgs = [
    options: {
        method: string;
        bucketName: string;
        query: string;
    },
    body: string,
    status: number[],
    region: string
];
type PollerClient = ConstructorParameters<NotificationApi['NotificationPoller']>[0];
// Только SDK и локальные потоки: application config, настоящий HTTP client и сеть не используются.
const requireBackend = createRequire(import.meta.url);
const minioRoot = dirname(requireBackend.resolve('minio/package.json'));
const requireMinio = createRequire(join(minioRoot, 'package.json'));
const parser = (await import(pathToFileURL(requireMinio.resolve('stream-json/jsonl/parser.js')).href)).default as ParserFactory;
const apis: ReadonlyArray<readonly [
    'CJS' | 'ESM',
    NotificationApi
]> = [['CJS', requireMinio('./dist/main/notification.js')], ['ESM', await import(pathToFileURL(join(minioRoot, 'dist/esm/notification.mjs')).href)]];
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 100; i++) {
    if (check())
        return;
    await pause(2);
} assert.ok(check(), 'ограниченное ожидание события потока'); }
const line = (records: unknown): string => JSON.stringify({ Records: records }) + '\n';
function harness(Api: NotificationApi) {
    const requests: RequestArgs[] = [], responses: PassThrough[] = [], records: unknown[] = [], errors: unknown[] = [];
    const client = { region: 'fixture-region', async makeRequestAsync(...args: RequestArgs): Promise<PassThrough> {
            assert.ok(requests.length < 4, 'не более четырёх fixture-запросов');
            requests.push(args);
            const stream = new PassThrough({ highWaterMark: 64 });
            responses.push(stream);
            return stream;
        } };
    const poller = new Api.NotificationPoller(client as unknown as PollerClient, 'fixture-bucket', 'папка /', '!?', ['s3:ObjectCreated:*', 's3:ObjectRemoved:*']);
    poller.on('notification', record => records.push(record));
    poller.on('error', error => errors.push(error));
    return { requests, responses, records, errors, poller, close() { poller.stop(); for (const response of responses)
            response.destroy(); } };
}
for (const [kind, Api] of apis) {
    it(`${kind}: отмена до открытия ответа не запрашивает S3`, { timeout: 1500 }, async () => {
        const h = harness(Api);
        try {
            if (kind === 'CJS')
                h.poller.checkForChanges(); // Новый async ESM-loader ещё не открыл HTTP stream.
            h.poller.stop();
            h.poller.start();
            h.poller.stop();
            await pause(30);
            assert.equal(h.requests.length, 0);
            assert.deepEqual(h.errors, []);
        }
        finally {
            h.close();
        }
    });
    it(`${kind}: JSONL приходит до EOF и сохраняет UTF-8, heartbeat и хвост без перевода строки`, { timeout: 1500 }, async () => {
        const h = harness(Api);
        try {
            h.poller.start();
            await until(() => h.responses.length === 1);
            const response = h.responses[0];
            response.write('\n' + line(null) + JSON.stringify({}) + '\r\n');
            const first = { eventName: 's3:ObjectCreated:Put', s3: { object: { key: 'папка/гусь.png', size: 7 } } };
            for (const byte of Buffer.from(line([first])))
                response.write(Buffer.from([byte]));
            await until(() => h.records.length === 1);
            assert.deepEqual(h.records, [first]);
            assert.equal(response.readableEnded, false, 'уведомление выдано до EOF');
            const [options, body, status, region] = h.requests[0];
            assert.equal(options.method, 'GET');
            assert.equal(options.bucketName, 'fixture-bucket');
            assert.equal(options.query, 'events=s3%3AObjectCreated%3A%2A&events=s3%3AObjectRemoved%3A%2A&prefix=%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0%20%2F&suffix=%21%3F');
            assert.equal(body, '');
            assert.deepEqual(status, [200]);
            assert.equal(region, 'fixture-region');
            const second = { eventName: 's3:ObjectRemoved:Delete', s3: { object: { key: 'next.png' } } };
            h.poller.on('notification', () => { if (h.records.length === 2)
                h.poller.stop(); });
            response.end(JSON.stringify({ Records: [second] }));
            await until(() => h.records.length === 2);
            assert.deepEqual(h.records, [first, second]);
            assert.deepEqual(h.errors, []);
            await tick();
            assert.equal(h.requests.length, 1);
        }
        finally {
            h.close();
        }
    });
    it(`${kind}: EOF повторяет polling, stop закрывает ответ и исключает следующий запрос`, { timeout: 1500 }, async () => {
        const h = harness(Api);
        try {
            h.poller.start();
            await until(() => h.responses.length === 1);
            h.responses[0].end(line([]));
            await until(() => h.responses.length === 2);
            h.poller.on('notification', () => h.poller.stop());
            h.responses[1].write(line([{ eventName: 's3:ObjectCreated:Put' }]));
            await until(() => h.records.length === 1);
            await until(() => h.responses[1].destroyed);
            await pause(10);
            assert.equal(h.requests.length, 2);
            assert.deepEqual(h.errors, []);
        }
        finally {
            h.close();
        }
    });
    it(`${kind}: ошибка JSONL передаётся обработчику без пропуска строки и уведомлений`, { timeout: 1500 }, async () => {
        const h = harness(Api);
        try {
            h.poller.start();
            await until(() => h.responses.length === 1);
            h.responses[0].write('{"Records":\n');
            await until(() => h.errors.length === 1);
            assert.ok(h.errors[0] instanceof SyntaxError);
            assert.deepEqual(h.records, []);
            assert.equal(h.requests.length, 1);
        }
        finally {
            h.close();
        }
    });
    it(`${kind}: ошибка исходного S3-потока доходит без замены и повторного запроса`, { timeout: 1500 }, async () => {
        const h = harness(Api);
        try {
            h.poller.start();
            await until(() => h.responses.length === 1 && h.responses[0].listenerCount('error') > 0);
            const expected = new Error('fixture source failure');
            h.responses[0].destroy(expected);
            await until(() => h.errors.length === 1);
            assert.equal(h.errors[0], expected);
            assert.deepEqual(h.records, []);
            assert.equal(h.requests.length, 1);
        }
        finally {
            h.close();
        }
    });
    it(`${kind}: адаптер Node stream останавливает чтение у медленного потребителя`, { timeout: 1500 }, async () => {
        let supplied = 0;
        const source = Readable.from((function* () { for (let i = 0; i < 1024; i++) {
            supplied++;
            yield Buffer.from(line([{ key: 'x'.repeat(64), i }]));
        } })(), { objectMode: false, highWaterMark: 64 });
        const sink = parser.asStream({ readableHighWaterMark: 1, writableHighWaterMark: 64 });
        try {
            source.pipe(sink);
            await pause(20);
            assert.ok(supplied < 1024, 'источник не дочитан без потребителя');
            assert.ok(sink.readableLength <= sink.readableHighWaterMark, 'очередь результата ограничена highWaterMark');
            const item = sink.read() as {
                value: {
                    Records: {
                        i: number;
                    }[];
                };
            } | null;
            assert.ok(item);
            assert.equal(item.value.Records[0].i, 0);
        }
        finally {
            source.unpipe(sink);
            source.destroy();
            sink.destroy();
        }
    });
}
