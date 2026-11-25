import { createHash } from "node:crypto";
// ADAPT: import the real generator and its types from testkit
import { generateScenario } from "@nostro/testkit";
import type { Shape } from "./types.js";

export const DEFAULT_SEED = 121;

export interface BenchData {
  scenario: unknown; // ADAPT: use the generator's return type
  hash: string;
}

const SHAPE_OPTIONS: Record<Shape, Record<string, unknown>> = {
  // ADAPT these option names to whatever scenario.ts supports.
  payments: { /* mostly small payments */ },
  dex: { /* heavy on offers / path payments */ },
  exceptions: { /* ~20% unmatched or exception-causing movements */ },
};

export function buildData(shape: Shape, size: number, seed = DEFAULT_SEED): BenchData {
  const scenario = generateScenario({ seed, movements: size, ...SHAPE_OPTIONS[shape] }); // ADAPT
  const hash = createHash("sha256").update(JSON.stringify(scenario)).digest("hex");
  return { scenario, hash };
}