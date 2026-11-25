export type StoreName = "memory" | "sqlite" | "postgres";
export type Shape = "payments" | "dex" | "exceptions";
export type Operation = "sync" | "reconcile" | "postJournal" | "doctor" | "journalCsv";

export interface OpResult {
  store: StoreName;
  shape: Shape;
  size: number;
  operation: Operation;
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  queries: number | null; // null if the store can't be proxied
  peakRssMb?: number;
}

export interface BenchFile {
  schema: 1;
  gitSha: string;
  seed: number;
  dataHashes: Record<string, string>; // key: `${shape}:${size}`
  machine: { cpu: string; cores: number; ramGb: number; os: string; node: string };
  startedAt: string;
  results: OpResult[];
}