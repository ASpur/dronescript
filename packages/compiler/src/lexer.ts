/** Tokenizer for DroneScript. */

import type { DiagnosticBag, Span } from "./diagnostics.js";

export type TokenKind =
  | "int"
  | "string"
  | "ident"
  | "keyword"
  | "punct"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** Source text for idents/puncts/keywords; decoded value for strings. */
  readonly value: string;
  readonly span: Span;
}

export const KEYWORDS = new Set([
  "const",
  "global",
  "server",
  "int",
  "coord",
  "void",
  "if",
  "else",
  "while",
  "for",
  "foreach",
  "in",
  "break",
  "continue",
  "return",
  "drone",
  "true",
  "false",
]);

// Longest first, so that `<=` wins over `<` and `&&` over `&`.
const PUNCTUATION = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "<",
  ">",
  ";",
  ",",
  ".",
  ":",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
];

const IDENT_START = /[A-Za-z_#%$]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export function tokenize(source: string, diagnostics: DiagnosticBag): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const spanFrom = (start: number, startLine: number, startCol: number): Span => ({
    start,
    end: i,
    line: startLine,
    column: startCol,
  });

  while (i < source.length) {
    const c = source[i]!;

    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    // Comments are for the reader, not the drone: they never reach the program.
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      const startCol = i - lineStart + 1;
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        diagnostics.error("unterminated-comment", "unterminated block comment", spanFrom(start, startLine, startCol));
      }
      continue;
    }

    const start = i;
    const startCol = i - lineStart + 1;
    const startLine = line;

    if (c >= "0" && c <= "9") {
      while (i < source.length && source[i]! >= "0" && source[i]! <= "9") i++;
      tokens.push({ kind: "int", value: source.slice(start, i), span: spanFrom(start, startLine, startCol) });
      continue;
    }

    if (IDENT_START.test(c)) {
      i++;
      while (i < source.length && IDENT_PART.test(source[i]!)) i++;
      const raw = source.slice(start, i);
      // A bare sigil is a typo, not an identifier.
      if (raw.length === 1 && (c === "#" || c === "%" || c === "$")) {
        diagnostics.error(
          "bare-sigil",
          `"${c}" must be followed by a variable name`,
          spanFrom(start, startLine, startCol),
        );
        continue;
      }
      tokens.push({
        kind: KEYWORDS.has(raw) ? "keyword" : "ident",
        value: raw,
        span: spanFrom(start, startLine, startCol),
      });
      continue;
    }

    if (c === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === "\\" && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === "\n") break;
        value += ch;
        i++;
      }
      if (!closed) {
        diagnostics.error("unterminated-string", "unterminated string literal", spanFrom(start, startLine, startCol));
      }
      tokens.push({ kind: "string", value, span: spanFrom(start, startLine, startCol) });
      continue;
    }

    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (punct) {
      i += punct.length;
      tokens.push({ kind: "punct", value: punct, span: spanFrom(start, startLine, startCol) });
      continue;
    }

    i++;
    diagnostics.error("unexpected-character", `unexpected character "${c}"`, spanFrom(start, startLine, startCol));
  }

  tokens.push({
    kind: "eof",
    value: "",
    span: { start: i, end: i, line, column: i - lineStart + 1 },
  });
  return tokens;
}
