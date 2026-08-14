/**
 * Evaluate the parts of a program that exist only at compile time: numeric
 * constants, and the `area(...)` / `filter(...)` templates that become
 * parameter widgets.
 */

import type { Call, Expr, ListLiteral, ObjectLiteral } from "../ast.js";
import type { DiagnosticBag } from "../diagnostics.js";
import { AREA_TYPES, getAreaType } from "../spec/widgets.js";
import { area as areaNode } from "../emit/model.js";
import type { WidgetNode } from "../emit/model.js";
import type { CompileValue } from "./values.js";

export interface ConstScope {
  get(name: string): CompileValue | undefined;
}

export class ConstEvaluator {
  constructor(
    private readonly diagnostics: DiagnosticBag,
    private readonly scope: ConstScope,
  ) {}

  /** Returns undefined when the expression is not a compile-time constant. */
  eval(expr: Expr): CompileValue | undefined {
    switch (expr.kind) {
      case "int":
        return { kind: "int", value: expr.value };
      case "string":
        return { kind: "text", value: expr.value };
      case "bool":
        return { kind: "int", value: expr.value ? 1 : 0 };
      case "coord": {
        const x = this.evalInt(expr.x);
        const y = this.evalInt(expr.y);
        const z = this.evalInt(expr.z);
        if (x === undefined || y === undefined || z === undefined) return undefined;
        return { kind: "coord", value: [x, y, z] };
      }
      case "ident":
        return this.scope.get(expr.name);
      case "unary": {
        if (expr.op !== "-") return undefined;
        const operand = this.eval(expr.operand);
        if (operand?.kind === "int") return { kind: "int", value: -operand.value };
        if (operand?.kind === "coord") {
          return {
            kind: "coord",
            value: [-operand.value[0], -operand.value[1], -operand.value[2]],
          };
        }
        return undefined;
      }
      case "binary": {
        const left = this.eval(expr.left);
        const right = this.eval(expr.right);
        if (left?.kind !== "int" || right?.kind !== "int") return undefined;
        const value = foldInt(expr.op, left.value, right.value);
        return value === undefined ? undefined : { kind: "int", value };
      }
      case "call":
        return this.evalCall(expr);
      case "list":
        return this.evalList(expr);
      default:
        return undefined;
    }
  }

  /**
   * A list folds into one union: the members' chains concatenated in order.
   * The game reads a chain of parameter widgets on one row as a union, so a
   * list-valued const is exactly "an array of areas/points". Bare coordinates
   * become one-block areas, the same as everywhere else. Anything mixed or
   * non-constant returns undefined WITHOUT a diagnostic — lists also appear
   * where they are not constants at all (e.g. {sides: ["up"]}), and the
   * caller owns that error.
   */
  private evalList(expr: ListLiteral): CompileValue | undefined {
    const chain: WidgetNode[] = [];
    let kind: "area" | "itemFilter" | "liquidFilter" | undefined;
    for (const item of expr.items) {
      const value = this.eval(item);
      const resolved =
        value?.kind === "coord"
          ? { kind: "area" as const, chain: [areaNode(value.value)] }
          : value;
      if (
        resolved === undefined ||
        (resolved.kind !== "area" &&
          resolved.kind !== "itemFilter" &&
          resolved.kind !== "liquidFilter")
      ) {
        return undefined;
      }
      if (kind === undefined) kind = resolved.kind;
      if (resolved.kind !== kind) return undefined;
      chain.push(...resolved.chain);
    }
    return kind === undefined ? undefined : { kind, chain };
  }

  evalInt(expr: Expr): number | undefined {
    const value = this.eval(expr);
    return value?.kind === "int" ? value.value : undefined;
  }

  private evalCall(call: Call): CompileValue | undefined {
    if (call.callee.kind !== "ident") return undefined;
    switch (call.callee.name) {
      case "area":
        return this.evalArea(call);
      case "filter":
        return this.evalItemFilter(call);
      case "fluid":
        return this.evalFluidFilter(call);
      default:
        return undefined;
    }
  }

  private evalArea(call: Call): CompileValue | undefined {
    const fields: Record<string, unknown> = {};

    const first = call.args[0];
    if (!first) {
      this.diagnostics.error("area-args", "area() needs at least one position", call.span);
      return undefined;
    }
    if (!this.applyAreaPosition(fields, first, 1)) return undefined;

    const second = call.args[1];
    if (second) {
      if (!this.applyAreaPosition(fields, second, 2)) return undefined;
    } else {
      // A one-point area names the same point twice: an omitted pos2 reads back
      // as (0,0,0) on 1.20.4, not as "unset", which would stretch the area to
      // the world origin. See the note on `area()` in emit/model.ts.
      if (fields["pos1"] !== undefined) fields["pos2"] = fields["pos1"];
      if (fields["var1"] !== undefined) fields["var2"] = fields["var1"];
    }

    fields["area_type"] = this.evalAreaType(call);
    return { kind: "area", chain: [{ type: "area", fields }] };
  }

  /** A position is a coordinate literal, a constant, or a variable name. */
  private applyAreaPosition(
    fields: Record<string, unknown>,
    expr: Expr,
    slot: 1 | 2,
  ): boolean {
    if (expr.kind === "ident" && !this.scope.get(expr.name)) {
      // Not a constant, so treat it as a runtime coordinate variable.
      fields[`var${slot}`] = expr.name;
      return true;
    }
    const value = this.eval(expr);
    if (value?.kind === "coord") {
      fields[`pos${slot}`] = value.value;
      return true;
    }
    this.diagnostics.error(
      "area-args",
      "an area position must be a coordinate literal, constant, or variable",
      expr.span,
    );
    return false;
  }

  private evalAreaType(call: Call): Record<string, unknown> {
    // The shape comes from the options object: {shape: "sphere", ...}.
    const options = call.options;
    const shapeExpr = findOption(options, "shape");
    let shape = "box";
    if (shapeExpr) {
      const value = this.eval(shapeExpr);
      if (value?.kind !== "text") {
        this.diagnostics.error("area-shape", "shape must be a string", shapeExpr.span);
      } else if (!AREA_TYPES.some((a) => a.id === value.value)) {
        this.diagnostics.error(
          "area-shape",
          `unknown area shape "${value.value}"; expected one of ${AREA_TYPES.map((a) => a.id).join(", ")}`,
          shapeExpr.span,
        );
      } else {
        shape = value.value;
      }
    }

    const out: Record<string, unknown> = { type: shape };
    const spec = getAreaType(shape);
    for (const property of options?.properties ?? []) {
      if (property.name === "shape") continue;
      const field = spec.fields.find((f) => f.json === property.name);
      if (!field) {
        this.diagnostics.error(
          "area-option",
          `area shape "${shape}" has no option "${property.name}"`,
          property.span,
        );
        continue;
      }
      const value = this.eval(property.value);
      if (value === undefined) {
        this.diagnostics.error("area-option", `${property.name} must be a constant`, property.span);
        continue;
      }
      out[property.name] = value.kind === "text" ? value.value : value.kind === "int" ? value.value : undefined;
    }

    for (const field of spec.fields) {
      if (field.required && out[field.json] === undefined) {
        this.diagnostics.error(
          "area-option",
          `area shape "${shape}" needs option "${field.json}"`,
          call.span,
        );
      }
    }
    return out;
  }

  private evalItemFilter(call: Call): CompileValue | undefined {
    const fields: Record<string, unknown> = {};
    const first = call.args[0];
    if (first) {
      const value = this.eval(first);
      if (value?.kind !== "text") {
        this.diagnostics.error(
          "filter-args",
          'filter() takes an item id, like filter("minecraft:cobblestone")',
          first.span,
        );
        return undefined;
      }
      fields["chk_item"] = { id: value.value, count: 1 };
    }
    for (const property of call.options?.properties ?? []) {
      const map: Record<string, string> = {
        matchDurability: "chk_durability",
        matchComponents: "chk_components",
        matchMod: "chk_mod",
        matchBlock: "chk_block",
        var: "var",
      };
      const json = map[property.name];
      if (!json) {
        this.diagnostics.error("filter-option", `filter() has no option "${property.name}"`, property.span);
        continue;
      }
      const value = this.eval(property.value);
      if (value === undefined) {
        this.diagnostics.error("filter-option", `${property.name} must be a constant`, property.span);
        continue;
      }
      fields[json] = value.kind === "int" ? value.value !== 0 : value.kind === "text" ? value.value : undefined;
    }
    return { kind: "itemFilter", chain: [{ type: "item_filter", fields }] };
  }

  private evalFluidFilter(call: Call): CompileValue | undefined {
    const first = call.args[0];
    if (!first) {
      this.diagnostics.error("filter-args", 'fluid() takes a fluid id, like fluid("minecraft:water")', call.span);
      return undefined;
    }
    const value = this.eval(first);
    if (value?.kind !== "text") {
      this.diagnostics.error("filter-args", "fluid() takes a fluid id string", first.span);
      return undefined;
    }
    const amountExpr = findOption(call.options, "amount");
    const amount = amountExpr ? this.evalInt(amountExpr) : undefined;
    return {
      kind: "liquidFilter",
      chain: [{ type: "liquid_filter", fields: { fluid: { id: value.value, amount: amount ?? 1000 } } }],
    };
  }
}

function findOption(options: ObjectLiteral | undefined, name: string): Expr | undefined {
  return options?.properties.find((p) => p.name === name)?.value;
}

function foldInt(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? undefined : Math.trunc(a / b);
    default:
      return undefined;
  }
}
