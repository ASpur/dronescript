/**
 * Lower the syntax tree to the widget CFG.
 *
 * Two things shape almost every decision here:
 *
 *  - There are no runtime booleans. A condition only ever exists as branching,
 *    so conditions lower by destination-passing: `lowerCondition(expr, ifTrue,
 *    ifFalse)`. Because a condition widget carries both a true target and a
 *    false target, `&&`/`||` chains cost no jump widgets at all.
 *
 *  - Arithmetic exists only as the coordinate operator widget, which folds a
 *    whole chain of operands in one widget. So `a + b - c` is one widget with
 *    three coordinate parameters, not three widgets.
 */

import type {
  Assign,
  Block,
  Call,
  Expr,
  FuncDecl,
  Identifier,
  Member,
  SourceFile,
  Stmt,
  TypeName,
} from "../ast.js";
import type { DiagnosticBag, Span } from "../diagnostics.js";
import { BlockBuilder } from "../ir/ir.js";
import type { Block as IrBlock, BlockId, IrProgram, Routine } from "../ir/ir.js";
import type { WidgetNode } from "../emit/model.js";
import { coordinate, text as textWidget, widget } from "../emit/model.js";
import { ALL_AXES, DIRECTIONS, encodeSides } from "../spec/widgets.js";
import type { DirectionName } from "../spec/widgets.js";
import { getBuiltin, getSensor } from "../spec/builtins.js";
import type { BuiltinSpec, FieldBinding, SensorVariants } from "../spec/builtins.js";
import { controllerNote } from "../spec/controller.js";
import { ConstEvaluator } from "../sema/consteval.js";
import type { CompileValue } from "../sema/values.js";
import { describeValue, isSpecialVariable, scopeOf } from "../sema/values.js";

/** Comparison operators the game supports directly. */
type RawOperator = "eq" | "ge" | "le";

interface VarInfo {
  readonly type: TypeName;
  /** Name as written into widgets, after shadowing is resolved. */
  readonly runtimeName: string;
}

interface Scope {
  readonly vars: Map<string, VarInfo>;
  readonly consts: Map<string, CompileValue>;
  readonly parent?: Scope;
}

interface LoopContext {
  readonly breakTo: BlockId;
  readonly continueTo: BlockId;
  /** Native foreach widgets manage their own iteration; breaking out is unsafe. */
  readonly native: boolean;
}

interface FunctionContext {
  readonly name: string;
  readonly returnVar?: string;
  readonly exit: BlockId;
}

export interface LowerResult {
  readonly program: IrProgram;
}

export interface LowerOptions {
  /** Hold the program to what a Programmable Controller can run. */
  readonly controller?: boolean;
}

export class Lowerer {
  private readonly builder = new BlockBuilder();
  private readonly routines: Routine[] = [];
  private readonly functions = new Map<string, FuncDecl>();
  private readonly callGraph = new Map<string, Set<string>>();
  private readonly emittedFunctions = new Set<string>();
  private readonly rootScope: Scope = { vars: new Map(), consts: new Map() };
  private scope: Scope = this.rootScope;
  private loop?: LoopContext;
  private fn?: FunctionContext;
  private current!: IrBlock;
  private tempCounter = 0;
  private shadowCounter = 0;
  private currentFunctionName = "<main>";
  private readonly callCounts = new Map<string, number>();
  private readonly inlining: string[] = [];

  constructor(
    private readonly diagnostics: DiagnosticBag,
    private readonly options: LowerOptions = {},
  ) {}

  /**
   * Report what a Programmable Controller would make of this call. Every widget
   * built from a builtin passes through here, so a piece the controller refuses
   * cannot slip out via a sensor or a condition.
   */
  private checkController(builtin: BuiltinSpec, span: Span): void {
    if (!this.options.controller) return;
    const note = controllerNote(builtin);
    if (!note) return;
    if (note.severity === "error") this.diagnostics.error(note.code, note.message, span);
    else this.diagnostics.warn(note.code, note.message, span);
  }

  lower(file: SourceFile): LowerResult {
    for (const item of file.body) {
      if (item.kind === "func") {
        if (this.functions.has(item.name)) {
          this.diagnostics.error("duplicate-function", `function "${item.name}" is already defined`, item.span);
        }
        this.functions.set(item.name, item);
      }
    }
    countCalls(file, this.callCounts);

    const entry = this.builder.create();
    this.current = entry;
    for (const item of file.body) {
      if (item.kind !== "func") this.lowerStatement(item);
    }
    this.current.terminator = { kind: "end" };

    const main: Routine = { name: "<main>", entry: entry.id, blocks: this.builder.blocks };

    // Functions are emitted on demand, so unreferenced ones cost nothing.
    for (const name of [...this.emittedFunctions]) {
      this.emitFunctionBody(name);
    }
    this.checkForRecursion();

    return { program: { main, routines: this.routines } };
  }

  // --- Scopes --------------------------------------------------------------

  private pushScope(): void {
    this.scope = { vars: new Map(), consts: new Map(), parent: this.scope };
  }

  private popScope(): void {
    if (this.scope.parent) this.scope = this.scope.parent;
  }

  private lookupVar(name: string): VarInfo | undefined {
    for (let s: Scope | undefined = this.scope; s; s = s.parent) {
      const found = s.vars.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private lookupConst(name: string): CompileValue | undefined {
    for (let s: Scope | undefined = this.scope; s; s = s.parent) {
      const found = s.consts.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private constEvaluator(): ConstEvaluator {
    return new ConstEvaluator(this.diagnostics, { get: (name) => this.lookupConst(name) });
  }

  private declareVar(name: string, type: TypeName, span: Span): VarInfo {
    if (this.scope.vars.has(name)) {
      this.diagnostics.error("duplicate-var", `"${name}" is already declared in this scope`, span);
    }
    // Runtime variables are global to the drone, so a shadowed local needs its
    // own name to avoid clobbering the outer one.
    const shadowed = this.lookupVar(name) !== undefined;
    const runtimeName = shadowed ? `${name}__${this.shadowCounter++}` : name;
    const info: VarInfo = { type, runtimeName };
    this.scope.vars.set(name, info);
    return info;
  }

  private temp(): string {
    return `__t${this.tempCounter++}`;
  }

  // --- Blocks --------------------------------------------------------------

  private emit(node: WidgetNode): void {
    this.current.ops.push({ node });
  }

  private startBlock(block: IrBlock): void {
    this.current = block;
  }

  // --- Statements ----------------------------------------------------------

  private lowerStatement(stmt: Stmt): void {
    switch (stmt.kind) {
      case "block":
        this.pushScope();
        for (const s of stmt.body) this.lowerStatement(s);
        this.popScope();
        return;
      case "const": {
        const value = this.constEvaluator().eval(stmt.value);
        if (value === undefined) {
          this.diagnostics.error(
            "not-constant",
            `"${stmt.name}" must be a compile-time constant (a number, string, coordinate, area, filter, or a list of areas or filters)`,
            stmt.span,
          );
          return;
        }
        this.scope.consts.set(stmt.name, value);
        return;
      }
      case "var": {
        const info = this.declareVar(stmt.name, stmt.type, stmt.span);
        if (stmt.init) this.assignTo(info, stmt.init, stmt.span);
        return;
      }
      case "assign":
        this.lowerAssign(stmt);
        return;
      case "exprStmt":
        this.lowerExpressionStatement(stmt.expr);
        return;
      case "if":
        this.lowerIf(stmt);
        return;
      case "while":
        this.lowerWhile(stmt);
        return;
      case "for":
        this.lowerFor(stmt);
        return;
      case "foreach":
        this.lowerForEach(stmt);
        return;
      case "break": {
        if (!this.loop) {
          this.diagnostics.error("break-outside-loop", "break is only valid inside a loop", stmt.span);
          return;
        }
        if (this.loop.native) {
          this.diagnostics.error(
            "break-in-foreach",
            "break cannot leave a foreach loop: the game's iteration widget controls the loop and would lose track of it",
            stmt.span,
          );
          return;
        }
        this.current.terminator = { kind: "jump", to: this.loop.breakTo };
        this.startBlock(this.builder.create());
        return;
      }
      case "continue": {
        if (!this.loop) {
          this.diagnostics.error("continue-outside-loop", "continue is only valid inside a loop", stmt.span);
          return;
        }
        this.current.terminator = { kind: "jump", to: this.loop.continueTo };
        this.startBlock(this.builder.create());
        return;
      }
      case "return": {
        if (!this.fn) {
          this.diagnostics.error("return-outside-function", "return is only valid inside a function", stmt.span);
          return;
        }
        if (stmt.value) {
          if (!this.fn.returnVar) {
            this.diagnostics.error(
              "void-return-value",
              `function "${this.fn.name}" is declared void, so return takes no value`,
              stmt.span,
            );
          } else {
            this.assignTo({ type: "int", runtimeName: this.fn.returnVar }, stmt.value, stmt.span);
          }
        }
        this.current.terminator = { kind: "jump", to: this.fn.exit };
        this.startBlock(this.builder.create());
        return;
      }
    }
  }

  private lowerIf(stmt: Extract<Stmt, { kind: "if" }>): void {
    const thenBlock = this.builder.create();
    const elseBlock = this.builder.create();
    const join = this.builder.create();

    this.lowerCondition(stmt.condition, thenBlock.id, elseBlock.id);

    this.startBlock(thenBlock);
    this.lowerStatement(stmt.then);
    this.current.terminator = { kind: "jump", to: join.id };

    this.startBlock(elseBlock);
    if (stmt.otherwise) this.lowerStatement(stmt.otherwise);
    this.current.terminator = { kind: "jump", to: join.id };

    this.startBlock(join);
  }

  private lowerWhile(stmt: Extract<Stmt, { kind: "while" }>): void {
    const test = this.builder.create();
    const body = this.builder.create();
    const exit = this.builder.create();

    this.current.terminator = { kind: "jump", to: test.id };

    this.startBlock(test);
    this.lowerCondition(stmt.condition, body.id, exit.id);

    const outer = this.loop;
    this.loop = { breakTo: exit.id, continueTo: test.id, native: false };
    this.startBlock(body);
    this.lowerStatement(stmt.body);
    this.current.terminator = { kind: "jump", to: test.id };
    this.loop = outer;

    this.startBlock(exit);
  }

  private lowerFor(stmt: Extract<Stmt, { kind: "for" }>): void {
    this.pushScope();
    if (stmt.init) this.lowerStatement(stmt.init);

    const test = this.builder.create();
    const body = this.builder.create();
    const step = this.builder.create();
    const exit = this.builder.create();

    this.current.terminator = { kind: "jump", to: test.id };

    this.startBlock(test);
    if (stmt.condition) {
      this.lowerCondition(stmt.condition, body.id, exit.id);
    } else {
      this.current.terminator = { kind: "jump", to: body.id };
    }

    const outer = this.loop;
    // `continue` runs the step clause, so it targets the step block.
    this.loop = { breakTo: exit.id, continueTo: step.id, native: false };
    this.startBlock(body);
    this.lowerStatement(stmt.body);
    this.current.terminator = { kind: "jump", to: step.id };
    this.loop = outer;

    this.startBlock(step);
    if (stmt.step) this.lowerStatement(stmt.step);
    this.current.terminator = { kind: "jump", to: test.id };

    this.startBlock(exit);
    this.popScope();
  }

  private lowerForEach(stmt: Extract<Stmt, { kind: "foreach" }>): void {
    this.pushScope();
    const info = this.declareVar(stmt.variable, "coord", stmt.span);
    const bodyLabel = `__foreach${this.tempCounter++}`;

    const node = this.buildForEachWidget(stmt.iterable, info.runtimeName, stmt.span);
    if (!node) {
      this.popScope();
      return;
    }

    const cont = this.builder.create();
    const bodyEntry = this.builder.create();
    this.current.terminator = {
      kind: "foreach",
      node: { ...node, params: withTextParam(node, textWidget(bodyLabel)) },
      body: bodyLabel,
      cont: cont.id,
    };

    // The body is its own chain; running off its end returns to the widget via
    // the game's jump-back stack.
    const saved = this.current;
    const outerLoop = this.loop;
    const exitBlock = this.builder.create();
    this.loop = { breakTo: exitBlock.id, continueTo: exitBlock.id, native: true };
    this.startBlock(bodyEntry);
    this.lowerStatement(stmt.body);
    this.current.terminator = { kind: "jump", to: exitBlock.id };
    this.startBlock(exitBlock);
    this.current.terminator = { kind: "end" };
    this.loop = outerLoop;

    this.routines.push({
      name: bodyLabel,
      entryLabel: bodyLabel,
      entry: bodyEntry.id,
      blocks: this.builder.blocks,
    });

    void saved;
    this.startBlock(cont);
    this.popScope();
  }

  /** `foreach (c in area)` vs `foreach (it in items(drone, {only: f}))`. */
  private buildForEachWidget(
    iterable: Expr,
    varName: string,
    span: Span,
  ): WidgetNode | undefined {
    if (iterable.kind === "call" && iterable.callee.kind === "ident" && iterable.callee.name === "items") {
      const first = iterable.args[0];
      if (!first || !isDroneSubject(first) || iterable.args.length > 1) {
        this.diagnostics.error(
          "foreach-iterable",
          "foreach iterates the drone's own inventory: items(drone), with an optional {only: filter}",
          iterable.span,
        );
        return undefined;
      }
      let chain: WidgetNode[] = [];
      for (const property of iterable.options?.properties ?? []) {
        if (property.name !== "only") {
          this.diagnostics.error(
            "unknown-option",
            `items(drone) as a foreach iterable takes only the "only" option`,
            property.span,
          );
          return undefined;
        }
        const filters = this.evalFilterList(property.value, "itemFilter", "items");
        if (!filters) return undefined;
        chain = filters;
      }
      return widget("for_each_item", { var: varName }, { params: [chain, []] });
    }
    const area = this.evalAreaOperand(iterable);
    if (!area) {
      this.diagnostics.error("foreach-iterable", "foreach takes an area, or items(drone)", span);
      return undefined;
    }
    return widget("for_each_coordinate", { var: varName }, { params: [area, []] });
  }

  // --- Assignment and arithmetic -------------------------------------------

  private lowerAssign(stmt: Assign): void {
    if (stmt.target.kind === "member") {
      this.lowerMemberAssign(stmt);
      return;
    }
    const name = stmt.target.name;
    if (scopeOf(name) === "special") {
      this.diagnostics.error("assign-special", `"${name}" is read-only`, stmt.span);
      return;
    }
    const info = this.resolveVariable(stmt.target);
    if (!info) return;

    if (stmt.op === "=") {
      this.assignTo(info, stmt.value, stmt.span);
      return;
    }
    // `a += b` folds into the same widget as `a = a + b` would.
    const op = stmt.op[0] as "+" | "-" | "*" | "/";
    const synthetic: Expr = {
      kind: "binary",
      op,
      left: stmt.target,
      right: stmt.value,
      span: stmt.span,
    };
    this.assignTo(info, synthetic, stmt.span);
  }

  /**
   * Component assignment. Only the axis being written participates, so the
   * other two are inherited from the first (unmasked) operand — which is why
   * the target itself leads the chain.
   */
  private lowerMemberAssign(stmt: Assign): void {
    const target = stmt.target as Member;
    if (target.target.kind !== "ident") {
      this.diagnostics.error("bad-assign", "only a variable's component can be assigned", stmt.span);
      return;
    }
    const axis = axisIndex(target.property);
    if (axis === undefined) {
      this.diagnostics.error("bad-member", `"${target.property}" is not a coordinate component`, stmt.span);
      return;
    }
    const info = this.resolveVariable(target.target);
    if (!info) return;

    const value = this.constEvaluator().eval(stmt.value);
    if (value?.kind !== "int") {
      this.diagnostics.error(
        "component-assign",
        `assigning ${target.property} from a runtime value is not supported; the game's coordinate operator cannot move a value between axes`,
        stmt.span,
      );
      return;
    }
    const operand: [number, number, number] = [0, 0, 0];
    operand[axis] = value.value;

    const self = coordinate(info.runtimeName);
    const whitelist = [self, coordinate(operand)];
    // Subtracting the target's own component leaves exactly the new value.
    const blacklist = stmt.op === "=" ? [coordinate(info.runtimeName)] : [];
    if (stmt.op !== "=" && stmt.op !== "+=" && stmt.op !== "-=") {
      this.diagnostics.error("component-assign", `${stmt.op} is not supported on a component`, stmt.span);
      return;
    }
    if (stmt.op === "-=") operand[axis] = -value.value;

    this.emit(
      widget(
        "coordinate_operator",
        { var: info.runtimeName, coord_op: "plus_minus", axis_options: 1 << axis },
        { params: [whitelist], blacklist: [blacklist] },
      ),
    );
  }

  private resolveVariable(ident: Identifier): VarInfo | undefined {
    if (ident.name === "drone") {
      this.diagnostics.error(
        "drone-subject",
        `"drone" is not a variable; it names the sensor subject, as in pressure(drone)`,
        ident.span,
      );
      return undefined;
    }
    const scope = scopeOf(ident.name);
    if (scope !== "local") {
      // Global, server, and special variables are named directly.
      return { type: "coord", runtimeName: ident.name };
    }
    const info = this.lookupVar(ident.name);
    if (!info) {
      this.diagnostics.error("undefined-var", `"${ident.name}" is not declared`, ident.span);
      return undefined;
    }
    return info;
  }

  /** Emit whatever widgets compute `expr` into `target`. */
  private assignTo(target: VarInfo, expr: Expr, span: Span): void {
    const sensor = this.asSensorCall(expr);
    if (sensor === "failed") return;
    if (sensor) {
      // A sensor in value position measures into the variable and falls through.
      this.emitSensor(sensor.call, sensor.builtin, { measureInto: target.runtimeName });
      return;
    }

    const folded = this.foldOperands(expr);
    if (folded) {
      this.emit(
        widget(
          "coordinate_operator",
          { var: target.runtimeName, coord_op: folded.op, axis_options: ALL_AXES },
          { params: [folded.whitelist], blacklist: [folded.blacklist] },
        ),
      );
      return;
    }

    this.diagnostics.error(
      "unsupported-expression",
      "this expression cannot be computed by a drone; break it into simpler assignments",
      span,
    );
  }

  /**
   * Flatten an expression into one coordinate-operator widget: a chain of
   * operands on the whitelist side and a chain on the blacklist side.
   *
   * The first whitelist operand seeds the result unmasked, so a chain of ints
   * (whose y and z are always zero) folds cleanly.
   */
  private foldOperands(
    expr: Expr,
  ): { op: "plus_minus" | "multiply_divide"; whitelist: WidgetNode[]; blacklist: WidgetNode[] } | undefined {
    // The top-level operator picks the widget; an operand from the other
    // class becomes its own temp via operandOf, so `a + b * c` is two
    // widgets. Choosing by inspection (rather than trying additive first)
    // matters: the additive walk would otherwise see `b * c` as one leaf and
    // ask operandOf to materialize it — or, for a top-level `a * b`, recurse
    // into folding the very expression it was asked about.
    if (expr.kind === "binary" && (expr.op === "*" || expr.op === "/")) {
      const multiplicative = this.collect(expr, "*", "/");
      if (multiplicative && multiplicative.positive.length > 0) {
        return {
          op: "multiply_divide",
          whitelist: multiplicative.positive,
          blacklist: multiplicative.negative,
        };
      }
      return undefined;
    }
    const additive = this.collect(expr, "+", "-");
    if (additive && additive.positive.length > 0) {
      return { op: "plus_minus", whitelist: additive.positive, blacklist: additive.negative };
    }
    return undefined;
  }

  private collect(
    expr: Expr,
    plus: "+" | "*",
    minus: "-" | "/",
  ): { positive: WidgetNode[]; negative: WidgetNode[] } | undefined {
    const positive: WidgetNode[] = [];
    const negative: WidgetNode[] = [];

    const walk = (node: Expr, inverted: boolean): boolean => {
      if (node.kind === "binary" && (node.op === plus || node.op === minus)) {
        if (!walk(node.left, inverted)) return false;
        return walk(node.right, node.op === minus ? !inverted : inverted);
      }
      const operand = this.operandOf(node);
      if (!operand) return false;
      (inverted ? negative : positive).push(operand);
      return true;
    };

    return walk(expr, false) ? { positive, negative } : undefined;
  }

  /** A single value that can become one coordinate parameter widget. */
  private operandOf(expr: Expr): WidgetNode | undefined {
    const constant = this.constEvaluator().eval(expr);
    if (constant?.kind === "int") return coordinate([constant.value, 0, 0]);
    if (constant?.kind === "coord") return coordinate([...constant.value] as [number, number, number]);

    if (expr.kind === "ident") {
      if (scopeOf(expr.name) === "special" && !isSpecialVariable(expr.name)) {
        this.diagnostics.error("unknown-special", `"${expr.name}" is not a built-in variable`, expr.span);
        return undefined;
      }
      const info = this.resolveVariable(expr);
      return info ? coordinate(info.runtimeName) : undefined;
    }

    if (expr.kind === "unary" && expr.op === "-") {
      // Negation of a non-constant needs its own widget; keep it simple and
      // report it rather than emitting something subtly wrong.
      return undefined;
    }

    if (expr.kind === "binary" && isArithmetic(expr.op)) {
      const tmp = this.materializeArithmetic(expr);
      return tmp ? coordinate(tmp) : undefined;
    }

    return undefined;
  }

  /**
   * Compute a runtime arithmetic expression into a fresh temp variable, so it
   * can appear inline where a widget wants a single coordinate — as in
   * `goto(refuelTarget + <0,1,0>)`. The operator widget lands just before the
   * widget that reads the temp, which is what makes the inline form exactly
   * as many pieces as writing the assignment out by hand.
   */
  private materializeArithmetic(expr: Expr): string | undefined {
    const folded = this.foldOperands(expr);
    if (!folded) return undefined;
    const tmp = this.temp();
    this.emit(
      widget(
        "coordinate_operator",
        { var: tmp, coord_op: folded.op, axis_options: ALL_AXES },
        { params: [folded.whitelist], blacklist: [folded.blacklist] },
      ),
    );
    return tmp;
  }

  // --- Expression statements ----------------------------------------------

  private lowerExpressionStatement(expr: Expr): void {
    if (expr.kind !== "call") {
      if (expr.kind === "ident" && expr.name === "halt") {
        // The pre-rework spelling of suicide(), once a statement keyword.
        this.diagnostics.error("unknown-function", `"halt" was replaced by suicide()`, expr.span);
        return;
      }
      this.diagnostics.error("useless-statement", "this expression has no effect", expr.span);
      return;
    }
    const name = calleeName(expr);
    if (!name) {
      this.diagnostics.error("bad-call", "unrecognised function call", expr.span);
      return;
    }

    const userFunction = this.functions.get(name);
    if (userFunction) {
      this.lowerUserCall(name, userFunction, expr);
      return;
    }

    if (getSensor(name)) {
      this.diagnostics.error(
        "sensor-as-statement",
        `${name}() reads a value; use it in a condition or assign it to a variable`,
        expr.span,
      );
      return;
    }
    const builtin = getBuiltin(name);
    if (!builtin) {
      this.diagnostics.error("unknown-function", unknownFunctionMessage(name), expr.span);
      return;
    }
    if (builtin.name === "suicide") {
      // Not an ordinary widget: nothing can follow it, so it is a terminator,
      // and it never reaches buildActionWidget's controller check.
      this.checkController(builtin, expr.span);
      if (expr.args.length > 0 || expr.options) {
        this.diagnostics.error("arity", "suicide() takes no arguments or options", expr.span);
      }
      this.current.terminator = { kind: "suicide" };
      this.startBlock(this.builder.create());
      return;
    }
    const node = this.buildActionWidget(builtin, expr);
    if (node) this.emit(node);
  }

  private lowerUserCall(name: string, decl: FuncDecl, call: Call): void {
    this.noteCall(name);

    if (call.args.length !== decl.params.length) {
      this.diagnostics.error(
        "arity",
        `${name}() takes ${decl.params.length} argument${decl.params.length === 1 ? "" : "s"}, got ${call.args.length}`,
        call.span,
      );
      return;
    }
    // There is no call stack for arguments, so each function has its own
    // variables. That is sound precisely because recursion is rejected.
    decl.params.forEach((param, i) => {
      const arg = call.args[i]!;
      this.assignTo({ type: param.type, runtimeName: argVar(name, i) }, arg, arg.span);
    });

    if (this.shouldInline(name)) {
      this.inlineCall(name, decl);
      return;
    }

    this.emittedFunctions.add(name);
    const cont = this.builder.create();
    this.current.terminator = { kind: "call", target: functionLabel(name), cont: cont.id };
    this.startBlock(cont);
  }

  /**
   * Keeping a function as a subroutine costs a label, its text, and a jump-sub
   * plus its text at each call — four widgets when it is called once, which
   * inlining removes outright. With two or more calls the subroutine usually
   * wins, so only the unambiguous case is taken.
   */
  private shouldInline(name: string): boolean {
    if ((this.callCounts.get(name) ?? 0) !== 1) return false;
    // A cycle would inline forever. It is an error anyway, reported below.
    return !this.inlining.includes(name);
  }

  private inlineCall(name: string, decl: FuncDecl): void {
    const cont = this.builder.create();

    const savedScope = this.scope;
    const savedFn = this.fn;
    const savedLoop = this.loop;
    const savedName = this.currentFunctionName;

    this.inlining.push(name);
    this.currentFunctionName = name;
    // The body sees top-level declarations and its own parameters, not the
    // caller's locals — the same scope it would have as a subroutine.
    this.scope = { vars: new Map(), consts: new Map(), parent: this.rootScope };
    this.loop = undefined;
    this.fn = {
      name,
      returnVar: decl.returns === "void" ? undefined : returnVar(name),
      exit: cont.id,
    };
    decl.params.forEach((param, i) => {
      this.scope.vars.set(param.name, { type: param.type, runtimeName: argVar(name, i) });
    });

    for (const stmt of decl.body.body) this.lowerStatement(stmt);
    this.current.terminator = { kind: "jump", to: cont.id };

    this.inlining.pop();
    this.scope = savedScope;
    this.fn = savedFn;
    this.loop = savedLoop;
    this.currentFunctionName = savedName;

    this.startBlock(cont);
  }

  private noteCall(callee: string): void {
    let set = this.callGraph.get(this.currentFunctionName);
    if (!set) {
      set = new Set();
      this.callGraph.set(this.currentFunctionName, set);
    }
    set.add(callee);
  }

  private emitFunctionBody(name: string): void {
    const decl = this.functions.get(name);
    if (!decl) return;
    if (this.routines.some((r) => r.name === name)) return;

    const entry = this.builder.create();
    const exit = this.builder.create();

    const savedBlock = this.current;
    const savedScope = this.scope;
    const savedFn = this.fn;
    const savedLoop = this.loop;
    const savedName = this.currentFunctionName;

    this.currentFunctionName = name;
    // A function body sees top-level declarations but not any caller's locals,
    // so it hangs off the root scope rather than wherever the call appeared.
    this.scope = { vars: new Map(), consts: new Map(), parent: this.rootScope };
    this.loop = undefined;
    this.fn = {
      name,
      returnVar: decl.returns === "void" ? undefined : returnVar(name),
      exit: exit.id,
    };

    decl.params.forEach((param, i) => {
      this.scope.vars.set(param.name, { type: param.type, runtimeName: argVar(name, i) });
    });

    this.startBlock(entry);
    for (const stmt of decl.body.body) this.lowerStatement(stmt);
    this.current.terminator = { kind: "jump", to: exit.id };

    this.startBlock(exit);
    // Falling off the end of a chain returns to the caller.
    this.current.terminator = { kind: "end" };

    this.routines.push({
      name,
      entryLabel: functionLabel(name),
      entry: entry.id,
      blocks: this.builder.blocks,
    });

    this.current = savedBlock;
    this.scope = savedScope;
    this.fn = savedFn;
    this.loop = savedLoop;
    this.currentFunctionName = savedName;

    // Emitting a body can discover further calls.
    for (const called of this.emittedFunctions) {
      if (!this.routines.some((r) => r.name === called)) this.emitFunctionBody(called);
    }
  }

  private checkForRecursion(): void {
    const state = new Map<string, "visiting" | "done">();
    const path: string[] = [];

    const visit = (name: string): boolean => {
      const seen = state.get(name);
      if (seen === "done") return false;
      if (seen === "visiting") {
        const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
        const decl = this.functions.get(name);
        this.diagnostics.error(
          "recursion",
          `recursive calls are not possible on a drone: ${cycle}`,
          decl?.span ?? { start: 0, end: 0, line: 1, column: 1 },
        );
        return true;
      }
      state.set(name, "visiting");
      path.push(name);
      for (const callee of this.callGraph.get(name) ?? []) {
        if (this.functions.has(callee) && visit(callee)) break;
      }
      path.pop();
      state.set(name, "done");
      return false;
    };

    for (const name of this.functions.keys()) visit(name);
  }

  // --- Conditions ----------------------------------------------------------

  /**
   * Lower a condition so control reaches `ifTrue` or `ifFalse`.
   *
   * `&&` and `||` short-circuit by threading destinations rather than computing
   * values, which is the only option: there is no boolean to compute.
   */
  private lowerCondition(expr: Expr, ifTrue: BlockId, ifFalse: BlockId): void {
    if (expr.kind === "bool") {
      this.current.terminator = { kind: "jump", to: expr.value ? ifTrue : ifFalse };
      this.startBlock(this.builder.create());
      return;
    }

    if (expr.kind === "unary" && expr.op === "!") {
      this.lowerCondition(expr.operand, ifFalse, ifTrue);
      return;
    }

    if (expr.kind === "binary" && expr.op === "&&") {
      const rhs = this.builder.create();
      this.lowerCondition(expr.left, rhs.id, ifFalse);
      this.startBlock(rhs);
      this.lowerCondition(expr.right, ifTrue, ifFalse);
      return;
    }

    if (expr.kind === "binary" && expr.op === "||") {
      const rhs = this.builder.create();
      this.lowerCondition(expr.left, ifTrue, rhs.id);
      this.startBlock(rhs);
      this.lowerCondition(expr.right, ifTrue, ifFalse);
      return;
    }

    if (expr.kind === "binary" && isComparison(expr.op)) {
      this.lowerComparison(expr.op, expr.left, expr.right, ifTrue, ifFalse, expr.span);
      return;
    }

    // A bare sensor call reads as "at least one", matching the widget default.
    const sensor = this.asSensorCall(expr);
    if (sensor === "failed") return;
    if (sensor) {
      const node = this.emitSensorAsCondition(sensor.call, sensor.builtin, "ge", 1);
      if (node) this.branchOn(node, ifTrue, ifFalse);
      return;
    }

    this.diagnostics.error(
      "bad-condition",
      "a condition must compare values or call a sensor; there are no boolean variables",
      expr.span,
    );
  }

  private lowerComparison(
    op: string,
    left: Expr,
    right: Expr,
    ifTrue: BlockId,
    ifFalse: BlockId,
    span: Span,
  ): void {
    // A comparison of two constants needs no widget at all.
    const leftValue = this.constEvaluator().evalInt(left);
    const rightValue = this.constEvaluator().evalInt(right);
    if (leftValue !== undefined && rightValue !== undefined) {
      const holds = evaluateComparison(op, leftValue, rightValue);
      this.current.terminator = { kind: "jump", to: holds ? ifTrue : ifFalse };
      this.startBlock(this.builder.create());
      return;
    }

    // The game offers only =, >= and <=. The rest are those three with the
    // branch targets swapped, which costs nothing.
    const { raw, swap } = normalizeComparison(op);
    const trueTarget = swap ? ifFalse : ifTrue;
    const falseTarget = swap ? ifTrue : ifFalse;

    // A sensor compared against a constant folds into the sensor widget itself.
    const leftSensor = this.asSensorCall(left);
    if (leftSensor === "failed") return;
    const rightConstant = this.constEvaluator().evalInt(right);
    if (leftSensor && rightConstant !== undefined) {
      const node = this.emitSensorAsCondition(leftSensor.call, leftSensor.builtin, raw, rightConstant);
      if (node) this.branchOn(node, trueTarget, falseTarget);
      return;
    }

    const rightSensor = this.asSensorCall(right);
    if (rightSensor === "failed") return;
    const leftConstant = this.constEvaluator().evalInt(left);
    if (rightSensor && leftConstant !== undefined) {
      // Reverse the comparison so the sensor stays on the left.
      const mirrored = raw === "ge" ? "le" : raw === "le" ? "ge" : "eq";
      const node = this.emitSensorAsCondition(rightSensor.call, rightSensor.builtin, mirrored, leftConstant);
      if (node) this.branchOn(node, trueTarget, falseTarget);
      return;
    }

    // Otherwise compare two coordinates, on whichever axes were named.
    const comparison = this.buildCoordinateComparison(left, right, raw, span);
    if (comparison) this.branchOn(comparison, trueTarget, falseTarget);
  }

  private buildCoordinateComparison(
    left: Expr,
    right: Expr,
    raw: RawOperator,
    span: Span,
  ): WidgetNode | undefined {
    const leftAxis = memberAxis(left);
    const rightAxis = memberAxis(right);
    if (leftAxis !== undefined && rightAxis !== undefined && leftAxis.axis !== rightAxis.axis) {
      this.diagnostics.error(
        "axis-mismatch",
        "a comparison can only look at the same component on both sides",
        span,
      );
      return undefined;
    }
    const axis = leftAxis?.axis ?? rightAxis?.axis;
    const leftExpr = leftAxis?.target ?? left;
    const rightExpr = rightAxis?.target ?? right;

    const a = this.operandOf(leftExpr);
    const b = this.operandOf(rightExpr);
    if (!a || !b) {
      this.diagnostics.error(
        "bad-condition",
        "both sides of a comparison must be a variable, a constant, or a sensor reading",
        span,
      );
      return undefined;
    }

    return widget(
      "condition_coordinate",
      { axis_options: axis === undefined ? ALL_AXES : 1 << axis, cond_op: raw },
      { params: [[a], [b], []] },
    );
  }

  /** Turn a built condition widget into a two-way branch terminator. */
  private branchOn(node: WidgetNode, ifTrue: BlockId, ifFalse: BlockId): void {
    this.current.terminator = { kind: "cond", node, ifTrue, ifFalse };
    this.startBlock(this.builder.create());
  }

  /**
   * A sensor call, resolved to the variant its first argument selects.
   * "failed" means it was a sensor but the subject was wrong — the error is
   * already reported, so the caller should stop rather than diagnose again.
   */
  private asSensorCall(expr: Expr): { call: Call; builtin: BuiltinSpec } | "failed" | undefined {
    if (expr.kind !== "call") return undefined;
    const name = calleeName(expr);
    if (!name) return undefined;
    const variants = getSensor(name);
    if (!variants) {
      // The pre-rework spelling deserves a pointed message, not "bad-condition".
      const [head, tail] = name.split(".");
      if (head === "drone" && tail && getSensor(tail)) {
        this.diagnostics.error("unknown-function", unknownFunctionMessage(name), expr.span);
        return "failed";
      }
      return undefined;
    }
    return this.resolveSensorVariant(expr, name, variants);
  }

  private resolveSensorVariant(
    call: Call,
    name: string,
    variants: SensorVariants,
  ): { call: Call; builtin: BuiltinSpec } | "failed" {
    const first = call.args[0];
    if (!first) {
      this.diagnostics.error(
        "missing-subject",
        `${name}() needs a subject to measure: ${name}(drone), or ${name}(someArea)`,
        call.span,
      );
      return "failed";
    }
    if (isDroneSubject(first)) {
      if (!variants.drone) {
        this.diagnostics.error(
          "wrong-subject",
          `${name}() can only measure an area, not the drone`,
          first.span,
        );
        return "failed";
      }
      if (call.args.length > 1) {
        this.diagnostics.error(
          "arity",
          `${name}(drone) takes no further arguments; filters go in the trailing {…} options`,
          call.args[1]!.span,
        );
        return "failed";
      }
      return { call, builtin: variants.drone };
    }
    if (!variants.area) {
      this.diagnostics.error(
        "wrong-subject",
        `${name}() can only measure the drone itself — write ${name}(drone)`,
        first.span,
      );
      return "failed";
    }
    return { call, builtin: variants.area };
  }

  private emitSensorAsCondition(
    call: Call,
    builtin: BuiltinSpec,
    operator: RawOperator,
    count: number,
  ): WidgetNode | undefined {
    return this.buildActionWidget(builtin, call, { operator, count });
  }

  /** A sensor used for its value: it measures into a variable and falls through. */
  private emitSensor(call: Call, builtin: BuiltinSpec, options: { measureInto: string }): void {
    const node = this.buildActionWidget(builtin, call, { measureInto: options.measureInto });
    if (node) this.emit(node);
  }

  // --- Widget construction from a call -------------------------------------

  private buildActionWidget(
    builtin: BuiltinSpec,
    call: Call,
    condition?: { operator?: RawOperator; count?: number; measureInto?: string },
  ): WidgetNode | undefined {
    this.checkController(builtin, call.span);

    const fields: Record<string, unknown> = {};
    const params: WidgetNode[][] = [];
    const blacklist: WidgetNode[][] = [];

    let ok = true;

    for (const binding of builtin.params) {
      const chain = this.resolveParamChain(builtin, binding, call);
      if (chain === undefined) {
        if (binding.required) {
          this.diagnostics.error(
            "missing-argument",
            `${builtin.name}() needs ${describeBinding(binding)}`,
            call.span,
          );
          ok = false;
        }
        continue;
      }
      const target = binding.side === "whitelist" ? params : blacklist;
      while (target.length <= binding.row) target.push([]);
      target[binding.row] = chain;
    }

    for (const field of builtin.fields) {
      const provided = call.options?.properties.find((p) => p.name === field.option);
      if (!provided) {
        if (field.fallback !== undefined) setPath(fields, field.path, field.fallback);
        continue;
      }
      const value = this.evalFieldValue(field, provided.value, builtin.name);
      if (value === undefined) {
        ok = false;
        continue;
      }
      setPath(fields, field.path, value);
      for (let i = 0; i + 1 < (field.enables?.length ?? 0) + 1 && field.enables; i++) {
        // `enables` is a full path to the boolean that switches the value on.
        setPath(fields, field.enables, true);
        break;
      }
    }

    // Report options that do not belong to this builtin, so typos surface.
    const known = new Set<string>(builtin.fields.map((f) => f.option));
    for (const binding of builtin.params) {
      if (binding.from.kind === "option") known.add(binding.from.name);
    }
    for (const property of call.options?.properties ?? []) {
      if (!known.has(property.name)) {
        this.diagnostics.error(
          "unknown-option",
          `${builtin.name}() has no option "${property.name}"`,
          property.span,
        );
        ok = false;
      }
    }

    if (builtin.condition) {
      const paths = builtin.condition;
      if (condition?.operator) setPath(fields, paths.operator, condition.operator);
      if (condition?.count !== undefined) setPath(fields, paths.count, condition.count);
      if (condition?.measureInto) setPath(fields, paths.measure, condition.measureInto);
      // Conditions with a count also need the flag that switches counting on.
      if (condition?.count !== undefined && paths.count[0] === "inv") {
        setPath(fields, ["inv", "use_count"], true);
      }
    }

    if (!ok) return undefined;

    const node = widget(builtin.widget, fields, {
      params: params.length > 0 ? params : undefined,
      blacklist: blacklist.length > 0 ? blacklist : undefined,
    });
    return node;
  }

  private resolveParamChain(
    builtin: BuiltinSpec,
    binding: ParamBindingLike,
    call: Call,
  ): WidgetNode[] | undefined {
    const source = binding.from;
    let expr: Expr | undefined;
    if (source.kind === "arg") {
      expr = call.args[source.index];
    } else {
      expr = call.options?.properties.find((p) => p.name === source.name)?.value;
    }
    if (!expr) return undefined;

    switch (binding.type) {
      case "area": {
        const chain = this.evalAreaOperand(expr);
        if (!chain) {
          this.diagnostics.error("bad-area", `${builtin.name}() expects an area or coordinate`, expr.span);
          return undefined;
        }
        return chain;
      }
      case "item_filter":
        return this.evalFilterList(expr, "itemFilter", builtin.name);
      case "liquid_filter":
        return this.evalFilterList(expr, "liquidFilter", builtin.name);
      case "text": {
        const value = this.constEvaluator().eval(expr);
        if (value?.kind === "text") return [textWidget(value.value)];
        if (value?.kind === "int") return [textWidget(String(value.value))];
        this.diagnostics.error(
          "bad-text",
          `${builtin.name}() expects a constant here; the game reads this parameter as literal text`,
          expr.span,
        );
        return undefined;
      }
      case "coordinate": {
        const operand = this.operandOf(expr);
        return operand ? [operand] : undefined;
      }
    }
  }

  /** An area argument may be an area constant, a list of them, or a coordinate. */
  private evalAreaOperand(expr: Expr): WidgetNode[] | undefined {
    if (expr.kind === "list") {
      const out: WidgetNode[] = [];
      for (const item of expr.items) {
        const chain = this.evalAreaOperand(item);
        if (!chain) return undefined;
        out.push(...chain);
      }
      return out;
    }
    const value = this.constEvaluator().eval(expr);
    if (value?.kind === "area") return value.chain.map(cloneNode);
    // Both points are named even though these are single blocks: an omitted
    // pos2/var2 reads back as (0,0,0) on 1.20.4 rather than as "unset", which
    // would stretch the area to the world origin. See `area()` in emit/model.ts.
    if (value?.kind === "coord") {
      return [
        {
          type: "area",
          fields: { pos1: value.value, pos2: value.value, area_type: { type: "box" } },
        },
      ];
    }
    // Inline arithmetic: computed into a temp just before the widget that
    // uses it, then read back as a single-block area.
    if (expr.kind === "binary" && isArithmetic(expr.op)) {
      const tmp = this.materializeArithmetic(expr);
      if (!tmp) return undefined;
      return [
        {
          type: "area",
          fields: { var1: tmp, var2: tmp, area_type: { type: "box" } },
        },
      ];
    }
    // A runtime coordinate variable becomes a single-block area.
    if (expr.kind === "ident") {
      const scope = scopeOf(expr.name);
      if (scope !== "local" || this.lookupVar(expr.name)) {
        const info = this.resolveVariable(expr);
        if (info) {
          return [
            {
              type: "area",
              fields: {
                var1: info.runtimeName,
                var2: info.runtimeName,
                area_type: { type: "box" },
              },
            },
          ];
        }
      }
    }
    return undefined;
  }

  private evalFilterList(
    expr: Expr,
    kind: "itemFilter" | "liquidFilter",
    builtinName: string,
  ): WidgetNode[] | undefined {
    const items = expr.kind === "list" ? expr.items : [expr];
    const out: WidgetNode[] = [];
    for (const item of items) {
      const value = this.constEvaluator().eval(item);
      if (value?.kind !== kind) {
        this.diagnostics.error(
          "bad-filter",
          `${builtinName}() expects ${kind === "itemFilter" ? "an item filter" : "a fluid filter"}${
            value ? `, got ${describeValue(value)}` : ""
          }`,
          item.span,
        );
        return undefined;
      }
      out.push(...value.chain.map(cloneNode));
    }
    return out;
  }

  private evalFieldValue(field: FieldBinding, expr: Expr, builtinName: string): unknown {
    const value = this.constEvaluator().eval(expr);
    switch (field.kind) {
      case "int":
        if (value?.kind !== "int") {
          this.diagnostics.error("bad-option", `${builtinName}.${field.option} must be a number`, expr.span);
          return undefined;
        }
        return value.value;
      case "bool":
        if (expr.kind === "bool") return expr.value;
        if (value?.kind === "int") return value.value !== 0;
        this.diagnostics.error("bad-option", `${builtinName}.${field.option} must be true or false`, expr.span);
        return undefined;
      case "string":
        if (value?.kind !== "text") {
          this.diagnostics.error("bad-option", `${builtinName}.${field.option} must be a string`, expr.span);
          return undefined;
        }
        return value.value;
      case "enum": {
        if (value?.kind !== "text" || !field.values?.includes(value.value)) {
          this.diagnostics.error(
            "bad-option",
            `${builtinName}.${field.option} must be one of ${field.values?.join(", ")}`,
            expr.span,
          );
          return undefined;
        }
        return value.value;
      }
      case "direction": {
        if (value?.kind !== "text" || !DIRECTIONS.includes(value.value as DirectionName)) {
          this.diagnostics.error(
            "bad-option",
            `${builtinName}.${field.option} must be one of ${DIRECTIONS.join(", ")}`,
            expr.span,
          );
          return undefined;
        }
        return value.value;
      }
      case "sides": {
        const names = expr.kind === "list" ? expr.items : [expr];
        const sides: DirectionName[] = [];
        for (const item of names) {
          const side = this.constEvaluator().eval(item);
          if (side?.kind !== "text" || !DIRECTIONS.includes(side.value as DirectionName)) {
            this.diagnostics.error(
              "bad-option",
              `${builtinName}.${field.option} takes side names: ${DIRECTIONS.join(", ")}`,
              item.span,
            );
            return undefined;
          }
          sides.push(side.value as DirectionName);
        }
        // Every sided widget errors in the Programmer with "no side active"
        // when none is selected, so an empty selection can never be meant.
        if (sides.length === 0) {
          this.diagnostics.error(
            "no-side",
            `${builtinName}.${field.option} needs at least one side — the game rejects the widget with "no side active". Omit the option to use the widget's default.`,
            expr.span,
          );
          return undefined;
        }
        return encodeSides(sides);
      }
    }
  }
}

type ParamBindingLike = BuiltinSpec["params"][number];

function describeBinding(binding: ParamBindingLike): string {
  return binding.from.kind === "arg"
    ? `an argument in position ${binding.from.index + 1}`
    : `the "${binding.from.name}" option`;
}

function cloneNode(node: WidgetNode): WidgetNode {
  // Parameter widgets are physical: each use site needs its own copy.
  return {
    type: node.type,
    fields: { ...node.fields },
    params: node.params?.map((chain) => chain?.map(cloneNode)),
    blacklist: node.blacklist?.map((chain) => chain?.map(cloneNode)),
  };
}

function withTextParam(node: WidgetNode, text: WidgetNode): (WidgetNode[] | undefined)[] {
  const rows = (node.params ?? []).map((row) => (row ? [...row] : []));
  // The loop widget's last row names the chain its body lives in.
  while (rows.length < 2) rows.push([]);
  rows[1] = [text];
  return rows;
}

function isDroneSubject(expr: Expr): boolean {
  return expr.kind === "ident" && expr.name === "drone";
}

/** Steer anyone typing the pre-rework spelling (`drone.rf()`) to the new one. */
function unknownFunctionMessage(name: string): string {
  const [head, tail] = name.split(".");
  if (head === "drone" && tail && getSensor(tail)) {
    return `no function named "${name}" — the drone is the sensor's argument: ${tail}(drone)`;
  }
  return `no function named "${name}"`;
}

function calleeName(call: Call): string | undefined {
  if (call.callee.kind === "ident") return call.callee.name;
  if (call.callee.kind === "member" && call.callee.target.kind === "ident") {
    return `${call.callee.target.name}.${call.callee.property}`;
  }
  return undefined;
}

function isComparison(op: string): boolean {
  return ["==", "!=", "<", "<=", ">", ">="].includes(op);
}

function isArithmetic(op: string): op is "+" | "-" | "*" | "/" {
  return op === "+" || op === "-" || op === "*" || op === "/";
}

/**
 * Rewrite a comparison into one the game has. `>` is `<=` with the branches
 * swapped, and so on — swapping targets is free, so this costs nothing.
 */
function normalizeComparison(op: string): { raw: RawOperator; swap: boolean } {
  switch (op) {
    case "==":
      return { raw: "eq", swap: false };
    case "!=":
      return { raw: "eq", swap: true };
    case ">=":
      return { raw: "ge", swap: false };
    case "<=":
      return { raw: "le", swap: false };
    case ">":
      return { raw: "le", swap: true };
    case "<":
      return { raw: "ge", swap: true };
    default:
      throw new Error(`not a comparison: ${op}`);
  }
}

function evaluateComparison(op: string, a: number, b: number): boolean {
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw new Error(`not a comparison: ${op}`);
  }
}

function axisIndex(name: string): number | undefined {
  return name === "x" ? 0 : name === "y" ? 1 : name === "z" ? 2 : undefined;
}

function memberAxis(expr: Expr): { target: Expr; axis: number } | undefined {
  if (expr.kind !== "member") return undefined;
  const axis = axisIndex(expr.property);
  return axis === undefined ? undefined : { target: expr.target, axis };
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

/**
 * Count call sites per name across the whole file, so the lowering can tell a
 * function called once from one called repeatedly before it emits either.
 */
function countCalls(file: SourceFile, into: Map<string, number>): void {
  const visitExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case "call": {
        const name = calleeName(expr);
        if (name) into.set(name, (into.get(name) ?? 0) + 1);
        visitExpr(expr.callee);
        expr.args.forEach(visitExpr);
        expr.options?.properties.forEach((p) => visitExpr(p.value));
        return;
      }
      case "binary":
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case "unary":
        visitExpr(expr.operand);
        return;
      case "member":
        visitExpr(expr.target);
        return;
      case "coord":
        visitExpr(expr.x);
        visitExpr(expr.y);
        visitExpr(expr.z);
        return;
      case "list":
        expr.items.forEach(visitExpr);
        return;
      case "object":
        expr.properties.forEach((p) => visitExpr(p.value));
        return;
      default:
        return;
    }
  };

  const visitStmt = (stmt: Stmt): void => {
    switch (stmt.kind) {
      case "block":
        stmt.body.forEach(visitStmt);
        return;
      case "var":
        if (stmt.init) visitExpr(stmt.init);
        return;
      case "const":
        visitExpr(stmt.value);
        return;
      case "assign":
        visitExpr(stmt.target);
        visitExpr(stmt.value);
        return;
      case "exprStmt":
        visitExpr(stmt.expr);
        return;
      case "if":
        visitExpr(stmt.condition);
        visitStmt(stmt.then);
        if (stmt.otherwise) visitStmt(stmt.otherwise);
        return;
      case "while":
        visitExpr(stmt.condition);
        visitStmt(stmt.body);
        return;
      case "for":
        if (stmt.init) visitStmt(stmt.init);
        if (stmt.condition) visitExpr(stmt.condition);
        if (stmt.step) visitStmt(stmt.step);
        visitStmt(stmt.body);
        return;
      case "foreach":
        visitExpr(stmt.iterable);
        visitStmt(stmt.body);
        return;
      case "return":
        if (stmt.value) visitExpr(stmt.value);
        return;
      default:
        return;
    }
  };

  for (const item of file.body) {
    if (item.kind === "func") item.body.body.forEach(visitStmt);
    else visitStmt(item);
  }
}

export function functionLabel(name: string): string {
  return `fn_${name}`;
}

function argVar(fn: string, index: number): string {
  return `__${fn}_a${index}`;
}

function returnVar(fn: string): string {
  return `__${fn}_ret`;
}
