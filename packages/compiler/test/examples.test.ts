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
    // Both formats have to work: the examples are what people start from.
    for (const target of ["1.20.4", "1.21"] as const) {
      it(`compiles ${file} for ${target}`, () => {
        const source = readFileSync(join(EXAMPLES_DIR, file), "utf8");
        const result = compile(source, { target });
        expect(
          result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `${d.code}: ${d.message}`),
        ).toEqual([]);
        expect(result.issues).toEqual([]);
        // Piece count is a property of the layout, so it holds for both.
        expect(result.pieces).toBe(EXPECTED_PIECES[file]);

        if (target === "1.21") {
          expect((result.json as { version: number }).version).toBe(3);
        } else {
          expect(Object.keys(result.json!)).toEqual(["pneumaticcraft:progWidgets"]);
        }
      });
    }
  }
});
