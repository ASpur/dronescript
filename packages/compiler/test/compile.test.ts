import { describe, expect, it } from "vitest";

import { compile } from "../src/api.js";
import type { CompileResult } from "../src/api.js";
import type { Target } from "../src/spec/targets.js";

function ok(source: string, target?: Target): CompileResult {
  const result = compile(source, target ? { target } : {});
  if (result.diagnostics.some((d) => d.severity === "error")) {
    throw new Error(
      "expected a clean compile, got:\n" +
        result.diagnostics.map((d) => `  ${d.code}: ${d.message}`).join("\n"),
    );
  }
  // The verifier confirms the game will read back exactly what we meant.
  expect(result.issues).toEqual([]);
  return result;
}

/** Assertions about codec field names only make sense against that format. */
function okV3(source: string): CompileResult {
  return ok(source, "1.21");
}

function v3Widgets(result: CompileResult): Record<string, unknown>[] {
  return (result.json as { widgets: Record<string, unknown>[] }).widgets;
}

function errors(source: string): string[] {
  return compile(source)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

/** Widget types in layout order — the same for every target. */
function types(result: CompileResult): string[] {
  return (result.placed ?? []).map((p) => p.type);
}

describe("straight-line programs", () => {
  it("compiles a sequence of actions", () => {
    const result = ok(`
      const home = area(<10, 64, 10>);
      goto(home);
      wait(20);
    `);
    expect(types(result)).toContain("start");
    expect(types(result)).toContain("goto");
    expect(types(result)).toContain("wait");
  });

  it("re-emits a shared area constant at each use site", () => {
    // Parameter widgets are physical, so two users cannot share one.
    const result = ok(`
      const spot = area(<1, 2, 3>);
      goto(spot);
      goto(spot);
    `);
    expect(types(result).filter((t) => t === "area")).toHaveLength(2);
  });

  it("passes options through to widget fields", () => {
    const result = okV3(`
      const quarry = area(<0, 60, 0>, <15, 64, 15>);
      dig(quarry, {order: "lowToHigh", maxActions: 8});
    `);
    const dig = v3Widgets(result).find((w) => w["type"] === "pneumaticcraft:dig")!;
    expect(dig["dig_place"]).toEqual({
      order: "lowToHigh",
      max_actions: 8,
      use_max_actions: true,
    });
  });

  it("always writes the order field, which the game requires", () => {
    const result = okV3(`dig(area(<0, 0, 0>));`);
    const dig = v3Widgets(result).find((w) => w["type"] === "pneumaticcraft:dig")!;
    expect(dig["dig_place"]).toEqual({ order: "closest" });
  });

  it("encodes side lists as a bitmask", () => {
    const result = okV3(`
      importItems(area(<0, 64, 0>), {sides: ["up", "down"]});
    `);
    const w = v3Widgets(result).find((x) => x["type"] === "pneumaticcraft:inventory_import")!;
    // down = bit 0, up = bit 1
    expect(w["inv"]).toEqual({ sides: 0b11 });
  });

  it("puts item filters on the whitelist and except on the blacklist", () => {
    const result = ok(`
      const ore = filter("minecraft:iron_ore");
      const junk = filter("minecraft:cobblestone");
      dig(area(<0, 0, 0>, <4, 4, 4>), {only: ore, except: junk});
    `);
    const filters = result.placed!.filter((p) => p.type === "item_filter");
    expect(filters).toHaveLength(2);
    // Whitelist sits to the right of the dig widget, blacklist to the left.
    const dig = result.placed!.find((p) => p.type === "dig")!;
    expect(filters.some((f) => f.x > dig.x)).toBe(true);
    expect(filters.some((f) => f.x < dig.x)).toBe(true);
  });
});

describe("arithmetic", () => {
  it("folds a whole additive chain into one widget", () => {
    const result = ok(`
      int a = 1;
      int b = 2;
      int c;
      c = a + b - 3;
    `);
    const operators = result.placed!.filter((p) => p.type === "coordinate_operator");
    // One for each of a, b and c: the chain does not need extra widgets.
    expect(operators).toHaveLength(3);
    const last = operators[operators.length - 1]!;
    expect(last.fields["coord_op"]).toBe("plus_minus");
  });

  it("compiles compound assignment as one operation", () => {
    const result = ok(`
      int i = 0;
      i += 5;
    `);
    expect(result.placed!.filter((p) => p.type === "coordinate_operator")).toHaveLength(2);
  });

  it("uses the multiply operator for products", () => {
    const result = ok(`
      int a = 3;
      int b;
      b = a * 4;
    `);
    const ops = result.placed!.filter((p) => p.type === "coordinate_operator");
    expect(ops.some((o) => o.fields["coord_op"] === "multiply_divide")).toBe(true);
  });

  it("stores an int in the x component only", () => {
    const result = ok(`int n = 7;`);
    const coord = result.placed!.find((p) => p.type === "coordinate")!;
    expect(coord.fields["coord"]).toEqual([7, 0, 0]);
  });
});

describe("conditions", () => {
  it("rewrites > as <= with the branches swapped", () => {
    const result = okV3(`
      const chest = area(<0, 64, 0>);
      const cobble = filter("minecraft:cobblestone");
      if (itemsIn(chest, {only: cobble}) > 10) { wait(20); }
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:condition_item_inventory",
    )!;
    // ">" has no widget, so the compiler emits "<=" and swaps the targets.
    expect((condition["cond"] as Record<string, unknown>)["cond_op"]).toBe("le");
  });

  it("keeps >= as-is", () => {
    const result = okV3(`if (drone.pressure() >= 5) { wait(1); }`);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:drone_condition_pressure",
    )!;
    expect((condition["drone_cond"] as Record<string, unknown>)["cond_op"]).toBeUndefined();
    expect((condition["drone_cond"] as Record<string, unknown>)["required_count"]).toBe(5);
  });

  it("spends no jump widgets on a chain of &&", () => {
    const result = ok(`
      if (drone.pressure() >= 3 && drone.rf() >= 10 && drone.items() >= 1) {
        wait(20);
      }
    `);
    const conditions = result.placed!.filter((p) => p.type.startsWith("drone_condition"));
    expect(conditions).toHaveLength(3);
    // Each condition carries its own false target, so no jump widget is needed.
    expect(result.placed!.filter((p) => p.type === "jump")).toHaveLength(0);
  });

  it("compiles if/else", () => {
    const result = ok(`
      if (drone.pressure() >= 5) { wait(10); } else { wait(20); }
    `);
    expect(types(result)).toContain("drone_condition_pressure");
    expect(result.placed!.filter((p) => p.type === "wait")).toHaveLength(2);
  });

  it("compares two variables with a coordinate condition", () => {
    const result = okV3(`
      int a = 1;
      int b = 2;
      if (a == b) { wait(5); }
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:condition_coordinate",
    )!;
    expect(condition["cond_op"]).toBe("eq");
    expect(condition["axis_options"]).toEqual({ axes: 0b111 });
  });

  it("compares a single component on the named axis", () => {
    const result = okV3(`
      coord p = <1, 2, 3>;
      coord q = <4, 5, 6>;
      if (p.y >= q.y) { wait(5); }
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:condition_coordinate",
    )!;
    expect(condition["axis_options"]).toEqual({ axes: 0b010 });
  });

  it("spends no widget on a comparison of two constants", () => {
    const result = ok(`
      if (2 > 1) { wait(5); } else { wait(99); }
    `);
    expect(types(result)).toEqual(["start", "wait", "text"]);
    const text = result.placed!.find((p) => p.type === "text")!;
    expect(text.fields["string"]).toBe("5");
  });

  it("measures a sensor into a variable when used as a value", () => {
    const result = okV3(`
      int n;
      n = drone.pressure();
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:drone_condition_pressure",
    )!;
    expect((condition["drone_cond"] as Record<string, unknown>)["measure_var"]).toBe("n");
  });
});

describe("loops", () => {
  it("compiles a while loop", () => {
    const result = ok(`
      while (drone.pressure() >= 1) {
        wait(20);
      }
    `);
    expect(types(result)).toContain("label");
    expect(types(result)).toContain("drone_condition_pressure");
  });

  it("compiles a top-level infinite loop with no jump at all", () => {
    // A drone that runs off the end of its program starts again at the start
    // widget, so the loop needs no jump widget and no label.
    const result = ok(`
      while (true) {
        wait(20);
      }
    `);
    expect(types(result)).toEqual(["start", "wait", "text"]);
    expect(result.pieces).toBe(3);
  });

  it("compiles a counted for loop", () => {
    const result = ok(`
      for (int i = 0; i <= 5; i++) {
        wait(1);
      }
    `);
    expect(types(result)).toContain("condition_coordinate");
    expect(result.issues).toEqual([]);
  });

  it("compiles break and continue", () => {
    const result = ok(`
      while (true) {
        if (drone.pressure() <= 1) { break; }
        if (drone.items() >= 64) { continue; }
        wait(5);
      }
    `);
    expect(result.issues).toEqual([]);
  });

  it("compiles foreach over an area to the iteration widget", () => {
    const result = ok(`
      const quarry = area(<0, 60, 0>, <8, 64, 8>);
      foreach (spot in quarry) {
        goto(spot);
        dig(spot);
      }
    `);
    expect(types(result)).toContain("for_each_coordinate");
    expect(result.issues).toEqual([]);
  });
});

describe("functions", () => {
  it("inlines a function called once, which is always cheaper", () => {
    // A subroutine costs a label, its text, a jump_sub and its text — four
    // widgets that a single call site does not need.
    const result = ok(`
      void park() {
        goto(area(<0, 64, 0>));
      }
      park();
    `);
    expect(types(result)).toEqual(["start", "goto", "area"]);
  });

  it("keeps a function called more than once as a subroutine", () => {
    const result = ok(`
      void park() {
        goto(area(<0, 64, 0>));
      }
      park();
      wait(20);
      park();
    `);
    expect(types(result)).toContain("jump_sub");
    expect(types(result)).toContain("label");
    // One shared body, reached from both call sites.
    expect(result.placed!.filter((p) => p.type === "goto")).toHaveLength(1);
    expect(result.placed!.filter((p) => p.type === "jump_sub")).toHaveLength(2);
  });

  it("passes arguments through per-function variables", () => {
    const result = ok(`
      void moveTo(coord target) {
        goto(target);
      }
      moveTo(<5, 64, 5>);
    `);
    const setter = result.placed!.find((p) => p.type === "coordinate_operator")!;
    expect(setter.fields["var"]).toBe("__moveTo_a0");
  });

  it("does not emit functions that are never called", () => {
    const result = ok(`
      void unused() { wait(100); }
      wait(1);
    `);
    expect(types(result)).not.toContain("jump_sub");
    expect(result.placed!.filter((p) => p.type === "wait")).toHaveLength(1);
  });

  it("rejects recursion, which a drone cannot do", () => {
    expect(errors(`void f() { f(); } f();`)).toContain("recursion");
  });

  it("rejects mutual recursion", () => {
    expect(errors(`void a() { b(); } void b() { a(); } a();`)).toContain("recursion");
  });
});

describe("diagnostics", () => {
  it("rejects an undeclared variable", () => {
    expect(errors(`x = 1;`)).toContain("undefined-var");
  });

  it("rejects assigning to a built-in variable", () => {
    expect(errors(`$drone_pos = <0, 0, 0>;`)).toContain("assign-special");
  });

  it("rejects an unknown function", () => {
    expect(errors(`nosuchthing();`)).toContain("unknown-function");
  });

  it("rejects an unknown option", () => {
    expect(errors(`dig(area(<0,0,0>), {nonsense: 1});`)).toContain("unknown-option");
  });

  it("rejects break outside a loop", () => {
    expect(errors(`break;`)).toContain("break-outside-loop");
  });

  it("rejects break inside foreach, which the game cannot leave cleanly", () => {
    expect(
      errors(`foreach (c in area(<0,0,0>, <1,1,1>)) { break; }`),
    ).toContain("break-in-foreach");
  });

  it("rejects a sensor used as a statement", () => {
    expect(errors(`drone.pressure();`)).toContain("sensor-as-statement");
  });

  it("explains that a redstone strength must be constant", () => {
    expect(errors(`int n = 5; emitRedstone(n);`)).toContain("bad-text");
  });
});
