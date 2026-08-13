import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

import { compile } from "../src/api.js";

const EXAMPLES_DIR = join(import.meta.dirname, "..", "..", "..", "examples");

/** Not an assertion — a way to read what the compiler actually produced. */
describe.skipIf(!process.env["INSPECT"])("inspect", () => {
  for (const file of ["quarry.drn", "sorter.drn"]) {
    it(file, () => {
      const result = compile(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
      const counts: Record<string, number> = {};
      for (const p of result.placed ?? []) counts[p.type] = (counts[p.type] ?? 0) + 1;
      console.log(file, "pieces:", result.pieces);
      console.log(counts);
      console.log(
        (result.placed ?? [])
          .map((p) => `${p.x},${p.y} ${p.type} ${JSON.stringify(p.fields)}`)
          .join("\n"),
      );
    });
  }
});
