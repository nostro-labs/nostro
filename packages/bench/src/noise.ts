import { execSync } from "node:child_process";
import fs from "node:fs";
import { cv } from "./stats.js";
import type { BenchFile } from "./types.js";

const N = Number(process.argv[2] ?? 10);
const files: BenchFile[] = [];
for (let i = 0; i < N; i++) {
  execSync("tsx src/run.ts --sizes 10000 --runs 3 --out bench-noise", { stdio: "inherit" });
  files.push(JSON.parse(fs.readFileSync("bench-noise/latest.json", "utf8")));
}

const keys = new Map<string, number[]>();
for (const f of files)
  for (const r of f.results) {
    const k = `${r.store} ${r.shape} ${r.size} ${r.operation}`;
    keys.set(k, [...(keys.get(k) ?? []), r.medianMs]);
  }

const rows = ["| case | CV | min ms | max ms |", "|---|---|---|---|"];
let worst = 0;
for (const [k, xs] of keys) {
  const c = cv(xs); worst = Math.max(worst, c);
  rows.push(`| ${k} | ${(c * 100).toFixed(1)}% | ${Math.min(...xs).toFixed(0)} | ${Math.max(...xs).toFixed(0)} |`);
}
console.log(rows.join("\n"));
console.log(`\nWorst CV: ${(worst * 100).toFixed(1)}%  → suggested time tolerance ≈ ${(1 + worst * 3).toFixed(2)}x`);
fs.writeFileSync("bench-noise/summary.md", rows.join("\n") + `\n\nWorst CV: ${(worst * 100).toFixed(1)}%\n`);