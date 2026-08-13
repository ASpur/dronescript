import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/api.js";

const EXAMPLES_DIR = join(import.meta.dirname, "..", "..", "..", "examples");

/**
 * Widget counts are the point of the optimizer, so they are pinned. A change
 * here is either a win worth recording or a regression worth explaining.
 */
const EXPECTED_PIECES: Record<string, number> = {
  "quarry.drn": 27,
  "sorter.drn": 26,
};

describe("examples", () => {
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".drn"));

  it("finds the example programs", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`compiles ${file} to a program the game will read back correctly`, () => {
      const source = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      const result = compile(source);
      expect(
        result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
      ).toEqual([]);
      expect(result.issues).toEqual([]);
      expect(result.json?.version).toBe(3);
      expect(result.pieces).toBe(EXPECTED_PIECES[file]);
    });
  }
});
