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

export interface CompileOptions extends BuildOptions {
  /**
   * Compile for a Programmable Controller rather than a drone: reject the
   * pieces it excludes, and flag the ones that mean something else there.
   */
  readonly controller?: boolean;
}

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

  const { program: ir } = new Lowerer(diagnostics, {
    controller: options.controller,
  }).lower(file);
  if (diagnostics.hasErrors) return { diagnostics: diagnostics.all };

  const program = linearize(ir);

  // A start widget with nothing under it is a program the game refuses as well,
  // but the cause is that the source said nothing to do — the user's business,
  // not the structural mismatch the verifier would otherwise report.
  if (program.chains.reduce((n, chain) => n + chain.widgets.length, 0) <= 1) {
    diagnostics.error(
      "empty-program",
      "this program does nothing; a drone needs at least one action",
      { start: 0, end: 0, line: 1, column: 1 },
    );
    return { diagnostics: diagnostics.all };
  }

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
