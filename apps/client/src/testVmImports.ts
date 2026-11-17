import { createRequire } from 'node:module';

/** Test-only VM boundary. Resolve imports without executing them; dormant modules
 * need no registration. Reading any unprovided export fails at the point of use.
 * Pass the URL of the source module, not the test, so relative imports resolve.
 * Mocks are ES module namespace records: a default export needs a `default` key.
 * Absent `then` stays undefined so Promise/dynamic import can resolve a namespace.
 * Only namespace exports are checked; nested service objects keep their identity.
 * No fallback to real execution (and therefore no accidental network/store IO).
 */
export function testVmImports(source: URL, mocks: Record<string, unknown>) {
  const resolve = createRequire(source).resolve;
  const dormant = new Map<string, object>();
  const provided = new Map<string, object>();
  const missing = (id: string, key: PropertyKey): never => {
    throw new Error(`Не подготовлен mock экспорта ${id}.${String(key)} из ${source.pathname}`);
  };
  return (id: string): unknown => {
    if (Object.hasOwn(mocks, id)) {
      const mock = mocks[id];
      if (mock === null || (typeof mock !== 'object' && typeof mock !== 'function')) return mock;
      if (!provided.has(id)) provided.set(id, new Proxy(mock, {
        get(target, key, receiver) {
          if (key === '__esModule' && !Reflect.has(target, key)) return true;
          if (key === 'then' && !Reflect.has(target, key)) return undefined;
          if (!Reflect.has(target, key)) return missing(id, key);
          return Reflect.get(target, key, receiver);
        },
      }));
      return provided.get(id);
    }
    try { resolve(id); } catch {
      throw new Error(`Неизвестная зависимость ${id} из ${source.pathname}`);
    }
    if (!dormant.has(id)) dormant.set(id, new Proxy(Object.create(null), {
      get(_target, key) {
        if (key === '__esModule') return true;
        if (key === 'then') return undefined;
        return missing(id, key);
      },
      ownKeys() { return missing(id, '*'); },
      has(_target, key) { return missing(id, key); },
    }));
    return dormant.get(id);
  };
}
