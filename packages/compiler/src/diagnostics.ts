/** Compiler messages, carrying spans so the editor can underline the source. */

export interface Span {
  /** Zero-based character offsets into the source text. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly span: Span;
  /** Stable identifier for tests and documentation links, e.g. "recursion". */
  readonly code: string;
}

export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  error(code: string, message: string, span: Span): void {
    this.items.push({ severity: "error", code, message, span });
  }

  warn(code: string, message: string, span: Span): void {
    this.items.push({ severity: "warning", code, message, span });
  }

  get all(): readonly Diagnostic[] {
    return this.items;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

export function spanOf(start: Span, end: Span): Span {
  return { start: start.start, end: end.end, line: start.line, column: start.column };
}
