/**
 * Recursive-descent parser with Pratt-style expression parsing.
 *
 * Hand-written for the sake of error recovery: this compiler runs on every
 * keystroke in the editor, so a broken program still has to produce a usable
 * tree and several precise diagnostics rather than one fatal error.
 */

import type {
  Assign,
  AssignOp,
  BinaryOp,
  Block,
  Expr,
  FuncDecl,
  Identifier,
  Member,
  ObjectLiteral,
  ObjectProperty,
  Param,
  SourceFile,
  Stmt,
  TopLevel,
  TypeName,
  VarScope,
} from "./ast.js";
import type { DiagnosticBag, Span } from "./diagnostics.js";
import { spanOf } from "./diagnostics.js";
import { tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const ASSIGN_OPS = new Set<string>(["=", "+=", "-=", "*=", "/="]);

/** Parsing above this level excludes the comparison operators, `<` and `>`. */
const COMPARISON_PRECEDENCE = 4;

class ParseError extends Error {}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly diagnostics: DiagnosticBag,
  ) {}

  private get current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private advance(): Token {
    const token = this.current;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  private at(value: string): boolean {
    const t = this.current;
    return (t.kind === "punct" || t.kind === "keyword") && t.value === value;
  }

  private eat(value: string): boolean {
    if (!this.at(value)) return false;
    this.advance();
    return true;
  }

  private expect(value: string, what = `"${value}"`): Token {
    if (this.at(value)) return this.advance();
    this.fail(`expected ${what}, found ${describe(this.current)}`);
  }

  private fail(message: string): never {
    this.diagnostics.error("syntax", message, this.current.span);
    throw new ParseError(message);
  }

  /** Skip ahead to somewhere a new statement plausibly starts. */
  private recover(): void {
    const depth0 = this.pos;
    while (this.current.kind !== "eof") {
      if (this.at(";")) {
        this.advance();
        return;
      }
      if (this.at("}")) return;
      this.advance();
    }
    if (this.pos === depth0) this.advance();
  }

  parseSourceFile(): SourceFile {
    const start = this.current.span;
    const body: TopLevel[] = [];
    while (this.current.kind !== "eof") {
      const before = this.pos;
      try {
        body.push(this.parseTopLevel());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recover();
      }
      // Guarantee progress even if a handler consumed nothing.
      if (this.pos === before) this.advance();
    }
    return { kind: "sourceFile", body, span: spanOf(start, this.current.span) };
  }

  private parseTopLevel(): TopLevel {
    if (this.isFunctionDeclaration()) return this.parseFunction();
    return this.parseStatement();
  }

  /** `void f(...)`, `int f(...)` — distinguished from `int x = ...` by the paren. */
  private isFunctionDeclaration(): boolean {
    const t = this.current;
    if (t.kind !== "keyword") return false;
    if (t.value !== "void" && t.value !== "int" && t.value !== "coord") return false;
    return this.peek(1).kind === "ident" && this.peek(2).value === "(";
  }

  private parseFunction(): FuncDecl {
    const start = this.advance(); // return type
    const returns = start.value as TypeName | "void";
    const name = this.expectIdent("a function name");
    this.expect("(");
    const params: Param[] = [];
    while (!this.at(")") && this.current.kind !== "eof") {
      const typeToken = this.current;
      if (typeToken.value !== "int" && typeToken.value !== "coord") {
        this.fail(`parameter type must be int or coord, found ${describe(typeToken)}`);
      }
      this.advance();
      const paramName = this.expectIdent("a parameter name");
      params.push({
        type: typeToken.value as TypeName,
        name: paramName.value,
        span: spanOf(typeToken.span, paramName.span),
      });
      if (!this.eat(",")) break;
    }
    this.expect(")");
    const body = this.parseBlock();
    return { kind: "func", name: name.value, returns, params, body, span: spanOf(start.span, body.span) };
  }

  private expectIdent(what: string): Token {
    if (this.current.kind === "ident") return this.advance();
    this.fail(`expected ${what}, found ${describe(this.current)}`);
  }

  private parseBlock(): Block {
    const start = this.expect("{");
    const body: Stmt[] = [];
    while (!this.at("}") && this.current.kind !== "eof") {
      const before = this.pos;
      try {
        body.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.recover();
      }
      if (this.pos === before) this.advance();
    }
    const end = this.expect("}");
    return { kind: "block", body, span: spanOf(start.span, end.span) };
  }

  private parseStatement(): Stmt {
    const t = this.current;

    if (t.kind === "punct" && t.value === "{") return this.parseBlock();

    if (t.kind === "keyword") {
      switch (t.value) {
        case "const":
          return this.parseConst();
        case "global":
        case "server":
        case "int":
        case "coord":
          return this.parseVarDecl();
        case "if":
          return this.parseIf();
        case "while":
          return this.parseWhile();
        case "for":
          return this.parseFor();
        case "foreach":
          return this.parseForEach();
        case "break": {
          this.advance();
          const end = this.expect(";");
          return { kind: "break", span: spanOf(t.span, end.span) };
        }
        case "continue": {
          this.advance();
          const end = this.expect(";");
          return { kind: "continue", span: spanOf(t.span, end.span) };
        }
        case "halt": {
          this.advance();
          const end = this.expect(";");
          return { kind: "halt", span: spanOf(t.span, end.span) };
        }
        case "return": {
          this.advance();
          const value = this.at(";") ? undefined : this.parseExpression();
          const end = this.expect(";");
          return { kind: "return", value, span: spanOf(t.span, end.span) };
        }
        default:
          break;
      }
    }

    return this.parseExpressionStatement();
  }

  private parseConst(): Stmt {
    const start = this.advance();
    const name = this.expectIdent("a constant name");
    this.expect("=");
    const value = this.parseExpression();
    const end = this.expect(";");
    return { kind: "const", name: name.value, value, span: spanOf(start.span, end.span) };
  }

  private parseVarDecl(): Stmt {
    const start = this.current;
    let scope: VarScope = "local";
    if (this.at("global")) {
      this.advance();
      scope = "global";
    } else if (this.at("server")) {
      this.advance();
      scope = "server";
    }
    const typeToken = this.current;
    if (typeToken.value !== "int" && typeToken.value !== "coord") {
      this.fail(`expected int or coord, found ${describe(typeToken)}`);
    }
    this.advance();
    const name = this.expectIdent("a variable name");
    const init = this.eat("=") ? this.parseExpression() : undefined;
    const end = this.expect(";");
    return {
      kind: "var",
      type: typeToken.value as TypeName,
      scope,
      name: name.value,
      init,
      span: spanOf(start.span, end.span),
    };
  }

  private parseIf(): Stmt {
    const start = this.advance();
    this.expect("(");
    const condition = this.parseExpression();
    this.expect(")");
    const then = this.parseStatement();
    const otherwise = this.eat("else") ? this.parseStatement() : undefined;
    return {
      kind: "if",
      condition,
      then,
      otherwise,
      span: spanOf(start.span, (otherwise ?? then).span),
    };
  }

  private parseWhile(): Stmt {
    const start = this.advance();
    this.expect("(");
    const condition = this.parseExpression();
    this.expect(")");
    const body = this.parseStatement();
    return { kind: "while", condition, body, span: spanOf(start.span, body.span) };
  }

  private parseFor(): Stmt {
    const start = this.advance();
    this.expect("(");
    const init = this.at(";") ? undefined : this.parseSimpleStatement();
    this.expect(";");
    const condition = this.at(";") ? undefined : this.parseExpression();
    this.expect(";");
    const step = this.at(")") ? undefined : this.parseSimpleStatement();
    this.expect(")");
    const body = this.parseStatement();
    return { kind: "for", init, condition, step, body, span: spanOf(start.span, body.span) };
  }

  /** The clause forms of `for`: a declaration or assignment, without the `;`. */
  private parseSimpleStatement(): Stmt {
    if (this.at("int") || this.at("coord") || this.at("global") || this.at("server")) {
      const start = this.current;
      let scope: VarScope = "local";
      if (this.at("global")) {
        this.advance();
        scope = "global";
      } else if (this.at("server")) {
        this.advance();
        scope = "server";
      }
      const typeToken = this.advance();
      const name = this.expectIdent("a variable name");
      const init = this.eat("=") ? this.parseExpression() : undefined;
      return {
        kind: "var",
        type: typeToken.value as TypeName,
        scope,
        name: name.value,
        init,
        span: spanOf(start.span, this.current.span),
      };
    }
    return this.parseBareExpressionStatement();
  }

  private parseForEach(): Stmt {
    const start = this.advance();
    this.expect("(");
    const variable = this.expectIdent("a loop variable name");
    this.expect("in", '"in"');
    const iterable = this.parseExpression();
    this.expect(")");
    const body = this.parseStatement();
    return {
      kind: "foreach",
      variable: variable.value,
      iterable,
      body,
      span: spanOf(start.span, body.span),
    };
  }

  private parseExpressionStatement(): Stmt {
    const stmt = this.parseBareExpressionStatement();
    const end = this.expect(";");
    return { ...stmt, span: spanOf(stmt.span, end.span) } as Stmt;
  }

  private parseBareExpressionStatement(): Stmt {
    const expr = this.parseExpression();

    if (this.current.kind === "punct" && ASSIGN_OPS.has(this.current.value)) {
      const op = this.advance().value as AssignOp;
      if (expr.kind !== "ident" && expr.kind !== "member") {
        this.diagnostics.error("bad-assign", "left side of an assignment must be a variable", expr.span);
      }
      const value = this.parseExpression();
      return {
        kind: "assign",
        op,
        target: expr as Identifier | Member,
        value,
        span: spanOf(expr.span, value.span),
      } satisfies Assign;
    }

    if (this.at("++") || this.at("--")) {
      const token = this.advance();
      if (expr.kind !== "ident" && expr.kind !== "member") {
        this.diagnostics.error("bad-assign", `left side of "${token.value}" must be a variable`, expr.span);
      }
      const one: Expr = { kind: "int", value: 1, span: token.span };
      return {
        kind: "assign",
        op: token.value === "++" ? "+=" : "-=",
        target: expr as Identifier | Member,
        value: one,
        span: spanOf(expr.span, token.span),
      } satisfies Assign;
    }

    return { kind: "exprStmt", expr, span: expr.span };
  }

  // --- Expressions ---------------------------------------------------------

  parseExpression(minPrecedence = 0): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.current;
      if (t.kind !== "punct") break;
      const precedence = BINARY_PRECEDENCE[t.value];
      if (precedence === undefined || precedence <= minPrecedence) break;
      this.advance();
      const right = this.parseExpression(precedence);
      left = {
        kind: "binary",
        op: t.value as BinaryOp,
        left,
        right,
        span: spanOf(left.span, right.span),
      };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.at("-") || this.at("!")) {
      const token = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "unary",
        op: token.value as "-" | "!",
        operand,
        span: spanOf(token.span, operand.span),
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at(".")) {
        this.advance();
        const name = this.expectIdent("a property name");
        expr = {
          kind: "member",
          target: expr,
          property: name.value,
          span: spanOf(expr.span, name.span),
        } satisfies Member;
        continue;
      }
      if (this.at("(")) {
        expr = this.parseCall(expr);
        continue;
      }
      break;
    }
    return expr;
  }

  private parseCall(callee: Expr): Expr {
    this.expect("(");
    const args: Expr[] = [];
    let options: ObjectLiteral | undefined;
    while (!this.at(")") && this.current.kind !== "eof") {
      // A trailing `{ ... }` carries the widget's scalar settings.
      if (this.at("{")) {
        options = this.parseObjectLiteral();
      } else {
        args.push(this.parseExpression());
      }
      if (!this.eat(",")) break;
    }
    const end = this.expect(")");
    return { kind: "call", callee, args, options, span: spanOf(callee.span, end.span) };
  }

  private parseObjectLiteral(): ObjectLiteral {
    const start = this.expect("{");
    const properties: ObjectProperty[] = [];
    while (!this.at("}") && this.current.kind !== "eof") {
      const nameToken = this.current;
      if (nameToken.kind !== "ident" && nameToken.kind !== "keyword" && nameToken.kind !== "string") {
        this.fail(`expected an option name, found ${describe(nameToken)}`);
      }
      this.advance();
      this.expect(":");
      const value = this.parseExpression();
      properties.push({ name: nameToken.value, value, span: spanOf(nameToken.span, value.span) });
      if (!this.eat(",")) break;
    }
    const end = this.expect("}");
    return { kind: "object", properties, span: spanOf(start.span, end.span) };
  }

  private parsePrimary(): Expr {
    const t = this.current;

    if (t.kind === "int") {
      this.advance();
      return { kind: "int", value: Number.parseInt(t.value, 10), span: t.span };
    }
    if (t.kind === "string") {
      this.advance();
      return { kind: "string", value: t.value, span: t.span };
    }
    if (t.kind === "ident") {
      this.advance();
      return { kind: "ident", name: t.value, span: t.span };
    }
    if (t.kind === "keyword" && (t.value === "true" || t.value === "false")) {
      this.advance();
      return { kind: "bool", value: t.value === "true", span: t.span };
    }
    if (this.at("(")) {
      this.advance();
      const inner = this.parseExpression();
      this.expect(")");
      return inner;
    }
    if (this.at("[")) {
      const start = this.advance();
      const items: Expr[] = [];
      while (!this.at("]") && this.current.kind !== "eof") {
        items.push(this.parseExpression());
        if (!this.eat(",")) break;
      }
      const end = this.expect("]");
      return { kind: "list", items, span: spanOf(start.span, end.span) };
    }
    if (this.at("{")) {
      return this.parseObjectLiteral();
    }
    // In primary position `<` opens a coordinate literal; it is never a
    // comparison here, since a comparison needs a left operand.
    if (this.at("<")) {
      const start = this.advance();
      // Components parse at arithmetic precedence so the closing ">" is not
      // mistaken for a comparison operator.
      const x = this.parseExpression(COMPARISON_PRECEDENCE);
      this.expect(",");
      const y = this.parseExpression(COMPARISON_PRECEDENCE);
      this.expect(",");
      const z = this.parseExpression(COMPARISON_PRECEDENCE);
      const end = this.expect(">");
      return { kind: "coord", x, y, z, span: spanOf(start.span, end.span) };
    }

    this.fail(`expected an expression, found ${describe(t)}`);
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of file";
    case "string":
      return `string "${token.value}"`;
    default:
      return `"${token.value}"`;
  }
}

export function parse(source: string, diagnostics: DiagnosticBag): SourceFile {
  const tokens = tokenize(source, diagnostics);
  return new Parser(tokens, diagnostics).parseSourceFile();
}

export type { Span };
