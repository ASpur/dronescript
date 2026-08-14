/**
 * The back half of the compiler: a widget program in, importable JSON out,
 * verified on the way.
 */

import { emit, emitString, puzzlePieceCount } from "./emit/emit.js";
import type { ProgramJson } from "./emit/emit.js";
import { emitV2 } from "./emit/emitV2.js";
import type { PlacedWidget, Program } from "./emit/model.js";
import { DEFAULT_TARGET } from "./spec/targets.js";
import type { Target } from "./spec/targets.js";
import { layout } from "./layout/place.js";
import type { IntentNode, LayoutOptions } from "./layout/place.js";
import { verify } from "./verify/graphcheck.js";
import type { VerifyIssue } from "./verify/graphcheck.js";

export interface BuildResult {
  /** The document to paste into the Programmer; its shape depends on the target. */
  readonly json: ProgramJson | Record<string, unknown>;
  readonly text: string;
  readonly placed: readonly PlacedWidget[];
  /** What layout meant to connect — lets callers re-verify a moved layout. */
  readonly intent: readonly IntentNode[];
  readonly issues: readonly VerifyIssue[];
  /** Programming Puzzle pieces the program will cost to load onto a drone. */
  readonly pieces: number;
  readonly target: Target;
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
  /** Which mod version to write for. Defaults to the 1.20.4 format. */
  readonly target?: Target;
}

export function build(program: Program, options: BuildOptions = {}): BuildResult {
  const target = options.target ?? DEFAULT_TARGET;
  const { placed, intent } = layout(program, options);
  const { issues } = verify(placed, intent);
  if (issues.length > 0 && !options.tolerateIssues) {
    throw new VerifyError(issues);
  }

  // Geometry and linking are identical across targets; only the encoding differs.
  const encoded =
    target === "1.21"
      ? { json: emit(placed) as ProgramJson | Record<string, unknown>, text: emitString(placed) }
      : emitV2(placed);

  return {
    json: encoded.json,
    text: encoded.text,
    placed,
    intent,
    issues,
    pieces: puzzlePieceCount(placed),
    target,
  };
}
