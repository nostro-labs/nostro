// ADAPT all imports and call signatures to the real code
import { sync, reconcile, postJournal, doctor, journalCsv } from "@nostro/core";
import { FakeHorizon } from "@nostro/testkit";
import type { Operation } from "./types.js";
import type { StoreHandle } from "./stores.js";
import type { BenchData } from "./data.js";

/** Run once per fresh store: loads the scenario so later ops have data. Not timed. */
export async function prepare(h: StoreHandle, data: BenchData) {
  const horizon = new FakeHorizon(/* ADAPT: data.scenario */);
  await sync({ store: h.store, horizon /* ADAPT */ });
  return { horizon };
}

export const OPS: Record<Exclude<Operation, "sync">, (h: StoreHandle) => Promise<unknown>> = {
  reconcile: (h) => reconcile({ store: h.store /* ADAPT */ }),
  postJournal: (h) => postJournal({ store: h.store /* ADAPT */ }),
  doctor: (h) => doctor({ store: h.store /* ADAPT */ }),
  journalCsv: (h) => journalCsv({ store: h.store /* ADAPT */ }),
};