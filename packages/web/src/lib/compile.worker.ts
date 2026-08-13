/**
 * The compiler runs off the main thread so typing stays responsive even on
 * large programs.
 */

import { compile } from "@dronescript/compiler";
import type { CompileResult, Target } from "@dronescript/compiler";

export interface CompileRequest {
  readonly id: number;
  readonly source: string;
  readonly target: Target;
}

export interface CompileResponse {
  readonly id: number;
  readonly result: CompileResult;
}

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const { id, source, target } = event.data;
  const result = compile(source, { target, tolerateIssues: true });
  const response: CompileResponse = { id, result };
  self.postMessage(response);
};
