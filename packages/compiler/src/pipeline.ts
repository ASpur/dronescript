/**
 * The back half of the compiler: a widget program in, importable JSON out,
 * verified on the way.
 */

import { emit, emitString, puzzlePieceCount } from "./emit/emit.js";
import type { ProgramJson } from "./emit/emit.js";
import type { PlacedWidget, Program } from "./emit/model.js";
import { layout } from "./layout/place.js";
import type { LayoutOptions } from "./layout/place.js";
import { verify } from "./verify/graphcheck.js";
import type { VerifyIssue } from "./verify/graphcheck.js";

export interface BuildResult {
  readonly json: ProgramJson;
  readonly text: string;
  readonly placed: readonly PlacedWidget[];
  readonly issues: readonly VerifyIssue[];
  /** Programming Puzzle pieces the program will cost to load onto a drone. */
  readonly pieces: number;
}

export class VerifyError extends Error {
  constructor(readonly issues: readonly VerifyIssue[]) {
    super(
      `emitted program does not match its intended structure:\n` +
        issues.map((i) => `  - ${i.message}`).join("\n"),
    );
    this.name = "VerifyError";
  }
}

export interface BuildOptions extends LayoutOptions {
  /**
   * Return issues instead of throwing. Off by default: a program that fails
   * verification imports as an empty one in game, with no visible error.
   */
  readonly tolerateIssues?: boolean;
}

export function build(program: Program, options: BuildOptions = {}): BuildResult {
  const { placed, intent } = layout(program, options);
  const { issues } = verify(placed, intent);
  if (issues.length > 0 && !options.tolerateIssues) {
    throw new VerifyError(issues);
  }
  return {
    json: emit(placed),
    text: emitString(placed),
    placed,
    issues,
    pieces: puzzlePieceCount(placed),
  };
}
