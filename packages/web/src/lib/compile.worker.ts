/**
 * The compiler runs off the main thread so typing stays responsive even on
 * large programs.
 */

import { applyChainOffsets, compile, emit, emitString, emitV2, verify } from "@dronescript/compiler";
import type { ChainOffsets, CompileResult, Target } from "@dronescript/compiler";

export interface CompileRequest {
  readonly id: number;
  readonly source: string;
  readonly target: Target;
  /** User drags, keyed by chain signature — applied after layout, re-verified. */
  readonly offsets?: ChainOffsets;
}

export interface CompileResponse {
  readonly id: number;
  readonly result: CompileResult;
  /** Which offset keys still matched a chain; the caller prunes the rest. */
  readonly applied?: readonly string[];
}

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const { id, source, target, offsets } = event.data;
  let result = compile(source, { target, tolerateIssues: true });

  // Rearranged chains re-verify and re-emit exactly the way build() does, so
  // the JSON tab and the export button always describe the moved layout.
  let applied: readonly string[] | undefined;
  if (offsets && Object.keys(offsets).length > 0 && result.placed && result.intent) {
    const adjusted = applyChainOffsets(result.placed, offsets);
    applied = adjusted.applied;
    if (adjusted.applied.length > 0) {
      const { issues } = verify(adjusted.placed, result.intent);
      const encoded =
        result.target === "1.21"
          ? { json: emit(adjusted.placed), text: emitString(adjusted.placed) }
          : emitV2(adjusted.placed);
      result = {
        ...result,
        placed: adjusted.placed,
        issues,
        json: encoded.json,
        text: encoded.text,
      };
    }
  }

  const response: CompileResponse = { id, result, applied };
  self.postMessage(response);
};
