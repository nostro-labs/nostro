import type { StoreName } from "./types.js";

export interface StoreHandle {
  store: any; // ADAPT: the real Store interface type
  queries: () => number;
  resetQueries: () => void;
  close: () => Promise<void>;
}

/** Wraps every function property of the store to count calls. Cheap, deterministic proxy. */
function withCounter<T extends object>(store: T): { store: T; count: () => number; reset: () => void } {
  let n = 0;
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          n++;
          return v.apply(target, args);
        };
      }
      return v;
    },
  });
  return { store: proxy, count: () => n, reset: () => (n = 0) };
}

export async function openStore(name: StoreName): Promise<StoreHandle> {
  let raw: any;
  let close = async () => {};

  if (name === "memory") {
    // ADAPT: e.g. raw = createMemoryStore();
  } else if (name === "sqlite") {
    // ADAPT: e.g. raw = await createSqliteStore({ path: ":memory:" });
  } else {
    // ADAPT: e.g. connect using process.env.NOSTRO_BENCH_PG_URL, create a fresh schema, drop on close
    // close = async () => { await raw.close(); };
  }

  const c = withCounter(raw);
  return { store: c.store, queries: c.count, resetQueries: c.reset, close };
}