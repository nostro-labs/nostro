import fs from "node:fs";
import type { BenchFile } from "./types.js";

const [basePath, headPath] = process.argv.slice(2);
const base: BenchFile = JSON.parse(fs.readFileSync(basePath, "utf8"));
const head: BenchFile = JSON.parse(fs.readFileSync(headPath, "utf8"));

const QUERY_TOLERANCE = 0.10;                                   // hard gate
const TIME_TOLERANCE = Number(process.env.BENCH_TIME_TOLERANCE ?? 1.5); // set from measured noise

let fail = false;
const lines: string[] = ["| store | shape | size | op | queries | time |", "|---|---|---|---|---|---|"];

for (const h of head.results) {
  const b = base.results.find(
    (r) => r.store === h.store && r.shape === h.shape && r.size === h.size && r.operation === h.operation);
  if (!b) continue;

  let q = "n/a";
  if (b.queries != null && h.queries != null && b.queries > 0) {
    const ratio = h.queries / b.queries;
    q = `${b.queries} → ${h.queries} (${ratio.toFixed(2)}x)`;
    if (ratio > 1 + QUERY_TOLERANCE) { fail = true; q += " ❌"; }
  }
  const tr = h.medianMs / b.medianMs;
  const t = `${b.medianMs.toFixed(0)} → ${h.medianMs.toFixed(0)} ms (${tr.toFixed(2)}x)` + (tr > TIME_TOLERANCE ? " ⚠️" : "");
  lines.push(`| ${h.store} | ${h.shape} | ${h.size} | ${h.operation} | ${q} | ${t} |`);
}

const out = lines.join("\n");
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n");
if (JSON.stringify(base.dataHashes) !== JSON.stringify(head.dataHashes)) {
  console.error("Data hashes differ: runs are not comparable.");
  process.exit(2);
}
process.exit(fail ? 1 : 0);