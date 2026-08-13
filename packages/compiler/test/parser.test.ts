import { describe, expect, it } from "vitest";

import { DiagnosticBag } from "../src/diagnostics.js";
import { parse } from "../src/parser.js";
import { tokenize } from "../src/lexer.js";
import type { Assign, Binary, Call, FuncDecl, If, Stmt, VarDecl, While } from "../src/ast.js";

function parseOk(source: string) {
  const diagnostics = new DiagnosticBag();
  const file = parse(source, diagnostics);
  expect(diagnostics.all).toEqual([]);
  return file;
}

function parseWithErrors(source: string) {
  const diagnostics = new DiagnosticBag();
  const file = parse(source, diagnostics);
  return { file, diagnostics };
}

describe("lexer", () => {
  it("keeps scope sigils attached to the name", () => {
    const diagnostics = new DiagnosticBag();
    const tokens = tokenize("x #score %flag $drone_pos", diagnostics);
    expect(tokens.slice(0, 4).map((t) => t.value)).toEqual(["x", "#score", "%flag", "$drone_pos"]);
    expect(diagnostics.all).toEqual([]);
  });

  it("rejects a sigil with no name after it", () => {
    const diagnostics = new DiagnosticBag();
    tokenize("# ", diagnostics);
    expect(diagnostics.all[0]?.code).toBe("bare-sigil");
  });

  it("skips line and block comments", () => {
    const diagnostics = new DiagnosticBag();
    const tokens = tokenize("a // note\n/* more\n notes */ b", diagnostics);
    expect(tokens.map((t) => t.value)).toEqual(["a", "b", ""]);
    expect(diagnostics.all).toEqual([]);
  });

  it("reports an unterminated block comment", () => {
    const diagnostics = new DiagnosticBag();
    tokenize("/* never closed", diagnostics);
    expect(diagnostics.all[0]?.code).toBe("unterminated-comment");
  });

  it("tracks line numbers for diagnostics", () => {
    const diagnostics = new DiagnosticBag();
    const tokens = tokenize("a\n\nb", diagnostics);
    expect(tokens[1]?.span.line).toBe(3);
  });
});

describe("parser", () => {
  it("parses declarations with scope prefixes", () => {
    const file = parseOk("int x = 1; global int #score = 0; server coord %home;");
    const decls = file.body as VarDecl[];
    expect(decls.map((d) => [d.scope, d.type, d.name])).toEqual([
      ["local", "int", "x"],
      ["global", "int", "#score"],
      ["server", "coord", "%home"],
    ]);
  });

  it("parses coordinate literals in primary position", () => {
    const file = parseOk("coord home = <10, 64, -20>;");
    const decl = file.body[0] as VarDecl;
    expect(decl.init?.kind).toBe("coord");
  });

  it("still reads < as a comparison when it follows an operand", () => {
    const file = parseOk("if (a < b) { halt; }");
    const stmt = file.body[0] as If;
    expect((stmt.condition as Binary).op).toBe("<");
  });

  it("applies conventional operator precedence", () => {
    const file = parseOk("int x = 1 + 2 * 3;");
    const init = (file.body[0] as VarDecl).init as Binary;
    expect(init.op).toBe("+");
    expect((init.right as Binary).op).toBe("*");
  });

  it("makes && bind tighter than ||", () => {
    const file = parseOk("if (a || b && c) { halt; }");
    const condition = (file.body[0] as If).condition as Binary;
    expect(condition.op).toBe("||");
    expect((condition.right as Binary).op).toBe("&&");
  });

  it("desugars ++ and -- into compound assignment", () => {
    const file = parseOk("i++; j--;");
    const [inc, dec] = file.body as Assign[];
    expect(inc!.op).toBe("+=");
    expect(dec!.op).toBe("-=");
  });

  it("parses a call with positional args and a trailing options object", () => {
    const file = parseOk(`dig([quarry], {order: "closest", maxActions: 4});`);
    const call = (file.body[0] as { expr: Call }).expr;
    expect(call.kind).toBe("call");
    expect(call.args).toHaveLength(1);
    expect(call.options?.properties.map((p) => p.name)).toEqual(["order", "maxActions"]);
  });

  it("parses member access for namespaced builtins", () => {
    const file = parseOk("if (drone.pressure() >= 5) { halt; }");
    const condition = (file.body[0] as If).condition as Binary;
    const call = condition.left as Call;
    expect(call.callee.kind).toBe("member");
  });

  it("parses functions and distinguishes them from variables", () => {
    const file = parseOk("int add(int a, int b) { return a + b; } int x = 1;");
    const func = file.body[0] as FuncDecl;
    expect(func.kind).toBe("func");
    expect(func.returns).toBe("int");
    expect(func.params.map((p) => p.name)).toEqual(["a", "b"]);
    expect((file.body[1] as VarDecl).kind).toBe("var");
  });

  it("parses for loops with all clauses optional", () => {
    const file = parseOk("for (;;) { halt; }");
    const loop = file.body[0] as { kind: string; init?: Stmt; condition?: unknown; step?: Stmt };
    expect(loop.kind).toBe("for");
    expect(loop.init).toBeUndefined();
    expect(loop.condition).toBeUndefined();
    expect(loop.step).toBeUndefined();
  });

  it("parses foreach over an area", () => {
    const file = parseOk("foreach (c in quarry) { goto(c); }");
    const loop = file.body[0] as { kind: string; variable: string };
    expect(loop.kind).toBe("foreach");
    expect(loop.variable).toBe("c");
  });

  it("parses while with a block body", () => {
    const file = parseOk("while (true) { wait(20); }");
    expect((file.body[0] as While).kind).toBe("while");
  });

  it("recovers at the next statement after a syntax error", () => {
    const { file, diagnostics } = parseWithErrors("int x = ;\nint y = 2;");
    expect(diagnostics.hasErrors).toBe(true);
    // The good declaration after the broken one is still parsed.
    const names = file.body.filter((n): n is VarDecl => n.kind === "var").map((d) => d.name);
    expect(names).toContain("y");
  });

  it("reports several errors in one pass", () => {
    const { diagnostics } = parseWithErrors("int a = ;\nint b = ;\nint c = ;");
    expect(diagnostics.all.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects assigning to something that is not a variable", () => {
    const { diagnostics } = parseWithErrors("1 = 2;");
    expect(diagnostics.all.some((d) => d.code === "bad-assign")).toBe(true);
  });

  it("terminates on unbalanced braces instead of looping", () => {
    const { diagnostics } = parseWithErrors("void f() { if (a) {");
    expect(diagnostics.hasErrors).toBe(true);
  });
});
