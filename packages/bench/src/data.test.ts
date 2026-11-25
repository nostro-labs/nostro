import { describe, it, expect } from "vitest";
import { buildData } from "./data.js";

describe("bench data", () => {
  it("same seed gives identical data", () => {
    expect(buildData("payments", 500, 121).hash).toBe(buildData("payments", 500, 121).hash);
  });
  it("different seed gives different data", () => {
    expect(buildData("payments", 500, 121).hash).not.toBe(buildData("payments", 500, 122).hash);
  });
});