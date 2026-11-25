import fs from "node:fs";
import { parseArgs } from "node:util";
import { buildData, DEFAULT_SEED } from "./data.js";
import { openStore } from "./stores.js";
import { OPS, prepare } from "./ops.js";
import { median, timeMs } from "./stats.js";
import { machineInfo, gitSha } from "./machine.js";
import type { BenchFile, OpResult, Operation, Shape, StoreName } from "./types.js";

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "10000" },
    stores: { type: "string", default: "memory,sqlite,postgres" },
    shapes: { type: "string", default: "payments,dex,exceptions" },
    runs: { type: "string", default: "5" },
    seed: { type: "string", default: String(DEFAULT_SEED) },
    out: { type: "string", default: "bench-results" },
  },
});

const sizes = values.sizes!.split(",").map(Number);
const stores = values.stores!.split(",") as StoreName[];
const shapes = values.shapes!.split(",") as Shape[];
const runs = Number(values.runs);
const seed = Number(values.seed);

const results: OpResult[] = [];
const dataHashes: Record<string, string> = {};

async function measure(
  store: StoreName, shape: Shape, size: number, operation: Operation,
  setup: () => Promise<{ h: Awaited<ReturnType<typeof openStore>>; run: () => Promise<unknown> }>,
) {
  const times: number[] = [];
  let queries: number | null = null;
  let peakRss = 0;

  for (let i = 0; i < runs + 1; i++) {            // run 0 = warm-up, discarded
    const { h, run } = await setup();
    h.resetQueries();
    const { ms } = await timeMs(run);
    if (i > 0) times.push(ms);
    queries = h.queries();
    peakRss = Math.max(peakRss, process.memoryUsage().rss / 1024 ** 2);
    await h.close();
  }
  results.push({
    store, shape, size, operation, runs,
    medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times),
    queries, ...(operation === "journalCsv" ? { peakRssMb: Math.round(peakRss) } : {}),
  });
  console.log(`${store} ${shape} ${size} ${operation}: ${median(times).toFixed(0)} ms, ${queries} queries`);
}

for (const shape of shapes) {
  for (const size of sizes) {
    const data = buildData(shape, size, seed);
    dataHashes[`${shape}:${size}`] = data.hash;

    for (const store of stores) {
      // sync: fresh store every run
      await measure(store, shape, size, "sync", async () => {
        const h = await openStore(store);
        return { h, run: () => prepare(h, data) };
      });

      // the other four ops: fresh, synced store every run
      for (const op of Object.keys(OPS) as (keyof typeof OPS)[]) {
        await measure(store, shape, size, op, async () => {
          const h = await openStore(store);
          await prepare(h, data);
          return { h, run: () => OPS[op](h) };
        });
      }
    }
  }
}

const file: BenchFile = {
  schema: 1, gitSha: gitSha(), seed, dataHashes,
  machine: machineInfo(), startedAt: new Date().toISOString(), results,
};
fs.mkdirSync(values.out!, { recursive: true });
const path = `${values.out}/${file.gitSha}-${Date.now()}.json`;
fs.writeFileSync(path, JSON.stringify(file, null, 2));
fs.writeFileSync(`${values.out}/latest.json`, JSON.stringify(file, null, 2));
console.log("wrote", path);