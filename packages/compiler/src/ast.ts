/** DroneScript syntax tree. Every node carries a span for diagnostics. */

import type { Span } from "./diagnostics.js";

export type TypeName = "int" | "coord";
export type VarScope = "local" | "global" | "server";

export interface Node {
  readonly span: Span;
}

// --- Expressions -----------------------------------------------------------

export type Expr =
  | IntLiteral
  | StringLiteral
  | BoolLiteral
  | CoordLiteral
  | Identifier
  | Member
  | Unary
  | Binary
  | Call
  | ListLiteral
  | ObjectLiteral;

export interface IntLiteral extends Node {
  readonly kind: "int";
  readonly value: number;
}

export interface StringLiteral extends Node {
  readonly kind: "string";
  readonly value: string;
}

export interface BoolLiteral extends Node {
  readonly kind: "bool";
  readonly value: boolean;
}

/** `<x, y, z>` — a BlockPos literal. */
export interface CoordLiteral extends Node {
  readonly kind: "coord";
  readonly x: Expr;
  readonly y: Expr;
  readonly z: Expr;
}

export interface Identifier extends Node {
  readonly kind: "ident";
  /** Includes any scope sigil: `x`, `#score`, `%flag`, `$drone_pos`. */
  readonly name: string;
}

/** `p.x` — a coordinate component. */
export interface Member extends Node {
  readonly kind: "member";
  readonly target: Expr;
  readonly property: string;
}

export type UnaryOp = "-" | "!";

export interface Unary extends Node {
  readonly kind: "unary";
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export interface Binary extends Node {
  readonly kind: "binary";
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface Call extends Node {
  readonly kind: "call";
  readonly callee: Expr;
  readonly args: readonly Expr[];
  /** Trailing `{ ... }` options, which map onto a widget's scalar fields. */
  readonly options?: ObjectLiteral;
}

export interface ListLiteral extends Node {
  readonly kind: "list";
  readonly items: readonly Expr[];
}

export interface ObjectProperty {
  readonly name: string;
  readonly value: Expr;
  readonly span: Span;
}

export interface ObjectLiteral extends Node {
  readonly kind: "object";
  readonly properties: readonly ObjectProperty[];
}

// --- Statements ------------------------------------------------------------

export type Stmt =
  | Block
  | VarDecl
  | ConstDecl
  | ExprStmt
  | Assign
  | If
  | While
  | For
  | ForEach
  | Break
  | Continue
  | Return;

export interface Block extends Node {
  readonly kind: "block";
  readonly body: readonly Stmt[];
}

export interface VarDecl extends Node {
  readonly kind: "var";
  readonly type: TypeName;
  readonly scope: VarScope;
  readonly name: string;
  readonly init?: Expr;
}

/** Compile-time binding: areas, filters, text, and constant numbers. */
export interface ConstDecl extends Node {
  readonly kind: "const";
  readonly name: string;
  readonly value: Expr;
}

export interface ExprStmt extends Node {
  readonly kind: "exprStmt";
  readonly expr: Expr;
}

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=";

export interface Assign extends Node {
  readonly kind: "assign";
  readonly op: AssignOp;
  readonly target: Identifier | Member;
  readonly value: Expr;
}

export interface If extends Node {
  readonly kind: "if";
  readonly condition: Expr;
  readonly then: Stmt;
  readonly otherwise?: Stmt;
}

export interface While extends Node {
  readonly kind: "while";
  readonly condition: Expr;
  readonly body: Stmt;
}

export interface For extends Node {
  readonly kind: "for";
  readonly init?: Stmt;
  readonly condition?: Expr;
  readonly step?: Stmt;
  readonly body: Stmt;
}

/** `foreach (c in area)` and `foreach (it in items(drone))`. */
export interface ForEach extends Node {
  readonly kind: "foreach";
  readonly variable: string;
  readonly iterable: Expr;
  readonly body: Stmt;
}

export interface Break extends Node {
  readonly kind: "break";
}

export interface Continue extends Node {
  readonly kind: "continue";
}

export interface Return extends Node {
  readonly kind: "return";
  readonly value?: Expr;
}

// --- Declarations ----------------------------------------------------------

export interface Param {
  readonly type: TypeName;
  readonly name: string;
  readonly span: Span;
}

export interface FuncDecl extends Node {
  readonly kind: "func";
  readonly name: string;
  readonly returns: TypeName | "void";
  readonly params: readonly Param[];
  readonly body: Block;
}

export type TopLevel = FuncDecl | Stmt;

export interface SourceFile extends Node {
  readonly kind: "sourceFile";
  readonly body: readonly TopLevel[];
}

export function isLValue(expr: Expr): expr is Identifier | Member {
  return expr.kind === "ident" || expr.kind === "member";
}
