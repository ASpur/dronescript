/** The compiler's public entry point: DroneScript source in, program JSON out. */

import { DiagnosticBag } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import { parse } from "./parser.js";
import { Lowerer } from "./lower/lower.js";
import { linearize } from "./layout/linearize.js";
import { build } from "./pipeline.js";
import type { BuildOptions } from "./pipeline.js";
import type { ProgramJson } from "./emit/emit.js";
import type { PlacedWidget } from "./emit/model.js";
import type { IntentNode } from "./layout/place.js";
import type { VerifyIssue } from "./verify/graphcheck.js";
import type { Target } from "./spec/targets.js";

export interface CompileOptions extends BuildOptions {}

export interface CompileResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Absent when compilation failed. */
  readonly json?: ProgramJson | Record<string, unknown>;
  readonly text?: string;
  readonly placed?: readonly PlacedWidget[];
  /** What layout meant to connect, for re-verifying a rearranged layout. */
  readonly intent?: readonly IntentNode[];
  readonly issues?: readonly VerifyIssue[];
  /** Programming Puzzle pieces the program costs. */
  readonly pieces?: number;
  readonly target?: Target;
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const diagnostics = new DiagnosticBag();

  const file = parse(source, diagnostics);
  if (diagnostics.hasErrors) return { diagnostics: diagnostics.all };

  const { program: ir } = new Lowerer(diagnostics).lower(file);
  if (diagnostics.hasErrors) return { diagnostics: diagnostics.all };

  const program = linearize(ir);

  try {
    const result = build(program, options);
    return {
      diagnostics: diagnostics.all,
      json: result.json,
      text: result.text,
      placed: result.placed,
      intent: result.intent,
      issues: result.issues,
      pieces: result.pieces,
      target: result.target,
    };
  } catch (error) {
    diagnostics.error(
      "codegen",
      error instanceof Error ? error.message : String(error),
      { start: 0, end: 0, line: 1, column: 1 },
    );
    return { diagnostics: diagnostics.all };
  }
}
