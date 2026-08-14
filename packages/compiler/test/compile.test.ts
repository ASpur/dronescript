import { describe, expect, it } from "vitest";

import { compile } from "../src/api.js";
import type { CompileResult } from "../src/api.js";
import { getWidget } from "../src/spec/widgets.js";
import type { Target } from "../src/spec/targets.js";
import { relink } from "../src/verify/relink.js";

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

interface Branches {
  /** Label named on the true side, or undefined when that side is empty. */
  readonly onTrue?: string;
  readonly onFalse?: string;
  /** Type of the widget the condition falls through to, if any. */
  readonly below?: string;
}

/** What the game reads off a condition: its two branch targets and its step. */
function branchesAt(result: CompileResult, index: number): Branches {
  const placed = result.placed!;
  const linked = relink(placed);
  const w = linked.widgets[index]!;
  const rows = getWidget(placed[index]!.type).params.length;
  const labelAt = (slot: number | undefined): string | undefined => {
    if (slot === undefined || slot < 0) return undefined;
    const s = placed[slot]!.fields["string"];
    return typeof s === "string" ? s : undefined;
  };
  return {
    onTrue: labelAt(w.parameters[rows - 1]),
    onFalse: labelAt(w.parameters[2 * rows - 1]),
    below: w.next >= 0 ? placed[w.next]!.type : undefined,
  };
}

function branchesOf(result: CompileResult, type: string): Branches {
  return branchesAt(result, result.placed!.findIndex((p) => p.type === type));
}

/** The type of the widget under the chain `label` names, if any. */
function chainUnder(result: CompileResult, label: string): string | undefined {
  const placed = result.placed!;
  const linked = relink(placed);
  for (const w of linked.widgets) {
    if (w.placed.type !== "label") continue;
    const slot = w.parameters[0];
    if (slot === undefined || slot < 0) continue;
    if (placed[slot]!.fields["string"] !== label) continue;
    return w.next >= 0 ? placed[w.next]!.type : undefined;
  }
  return undefined;
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

  it("names a side on every widget that has them, however it is called", () => {
    // Everything below ProgWidgetInventoryBase refuses to run with no side
    // active — the world-subject sensors included, not just import/export.
    // The builtin has to offer the option, or nothing writes the mask at all.
    const sensors = [
      `if (pressure(area(<1,2,3>)) >= 3) { wait(1); }`,
      `if (rf(area(<1,2,3>)) >= 3) { wait(1); }`,
      `if (light(area(<1,2,3>)) >= 3) { wait(1); }`,
      `if (entities(area(<1,2,3>)) >= 1) { wait(1); }`,
      `if (blocks(area(<1,2,3>)) >= 1) { wait(1); }`,
      `if (redstone(area(<1,2,3>)) >= 1) { wait(1); }`,
      `if (items(area(<1,2,3>)) >= 1) { wait(1); }`,
      `if (liquid(area(<1,2,3>)) >= 1) { wait(1); }`,
      `importItems(area(<1,2,3>));`,
      `exportLiquid(area(<1,2,3>));`,
      `dropItems(area(<1,2,3>));`,
      `emitRedstone(15);`,
    ];
    for (const source of sensors) {
      // `ok()` already fails on the verifier's report; this states the property.
      const result = ok(source);
      for (const placed of result.placed!) {
        const spec = getWidget(placed.type);
        const sided = spec.fields.filter((f) => f.kind === "sides");
        const grouped = spec.fields.filter((f) => f.kind === "group");
        for (const field of sided) {
          expect(placed.fields[field.json], `${source} — ${placed.type}`).toBeGreaterThan(0);
        }
        for (const group of grouped) {
          for (const sub of (group.fields ?? []).filter((f) => f.kind === "sides")) {
            const value = (placed.fields[group.json] as Record<string, unknown> | undefined)?.[sub.json];
            expect(value, `${source} — ${placed.type}.${group.json}.${sub.json}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("rejects an empty side selection, which the game errors on", () => {
    // ProgWidgetInventoryBase and ProgWidgetEmitRedstone both refuse to run
    // with "no side active"; an explicit empty list can never be meant.
    expect(errors(`exportItems(area(<0, 64, 0>), {sides: []});`)).toContain("no-side");
    expect(errors(`emitRedstone(3, {sides: []});`)).toContain("no-side");
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

describe("list constants", () => {
  it("lets foreach walk a const list of points as one union", () => {
    const result = okV3(`
      const fuelSpots = [<100, 100, 100>, <100, 101, 100>];
      foreach (b in fuelSpots) {
        goto(b);
      }
    `);
    // The chain of areas on the for-each row is the union the game iterates.
    const areas = v3Widgets(result).filter((w) => w["type"] === "pneumaticcraft:area");
    const positions = areas.map((a) => a["pos1"]);
    expect(positions).toContainEqual([100, 100, 100]);
    expect(positions).toContainEqual([100, 101, 100]);

    const loop = result.placed!.find((p) => p.type === "for_each_coordinate")!;
    const chained = result.placed!.filter(
      (p) => p.type === "area" && p.y === loop.y && p.x > loop.x,
    );
    expect(chained).toHaveLength(2);
  });

  it("verifies a union chain of more than two areas", () => {
    // Chains of length ≥ 3 once tripped the verifier: each chain member's
    // intent held only its immediate neighbour, but the game (and the
    // relinker) read the whole remaining suffix from any member.
    const result = ok(`
      const stops = [<1, 64, 1>, <2, 64, 2>, <3, 64, 3>, <4, 64, 4>, <5, 64, 5>, <6, 64, 6>];
      foreach (b in stops) {
        goto(b);
      }
    `);
    const loop = result.placed!.find((p) => p.type === "for_each_coordinate")!;
    const chained = result.placed!.filter(
      (p) => p.type === "area" && p.y === loop.y && p.x > loop.x,
    );
    expect(chained).toHaveLength(6);
  });

  it("verifies a blacklist chain of more than two filters", () => {
    const result = ok(`
      const pit = area(<0, 60, 0>, <4, 64, 4>);
      dig(pit, {except: [filter("minecraft:stone"), filter("minecraft:dirt"), filter("minecraft:gravel")]});
    `);
    expect(types(result).filter((t) => t === "item_filter")).toHaveLength(3);
  });

  it("mixes coordinates and area constants in one list", () => {
    const result = ok(`
      const pit = area(<0, 60, 0>, <4, 64, 4>);
      const stops = [pit, <9, 64, 9>];
      goto(stops);
    `);
    expect(types(result).filter((t) => t === "area")).toHaveLength(2);
  });

  it("re-emits a list constant at each use site", () => {
    const result = ok(`
      const spots = [<1, 64, 1>, <2, 64, 2>];
      goto(spots);
      goto(spots);
    `);
    expect(types(result).filter((t) => t === "area")).toHaveLength(4);
  });

  it("folds a const list of filters into one filter chain", () => {
    const result = ok(`
      const junk = [filter("minecraft:cobblestone"), filter("minecraft:dirt")];
      dig(area(<0, 0, 0>, <4, 4, 4>), {except: junk});
    `);
    const dig = result.placed!.find((p) => p.type === "dig")!;
    const blacklisted = result.placed!.filter((p) => p.type === "item_filter" && p.x < dig.x);
    expect(blacklisted).toHaveLength(2);
  });

  it("rejects a mixed list as not constant", () => {
    expect(errors(`const bad = [1, <1, 2, 3>];`)).toContain("not-constant");
  });

  it("rejects a list naming a runtime variable as not constant", () => {
    expect(errors(`coord c; const bad = [c];`)).toContain("not-constant");
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

  it("accepts inline arithmetic where a widget wants a position", () => {
    const result = ok(`
      coord refuelTarget = <10, 64, 10>;
      goto(refuelTarget + <0, 1, 0>);
    `);
    // The temp computation lands before the goto that reads it…
    const sequence = types(result);
    expect(sequence.lastIndexOf("coordinate_operator")).toBeLessThan(sequence.indexOf("goto"));
    // …and costs exactly what the two-statement spelling would.
    const spelledOut = ok(`
      coord refuelTarget = <10, 64, 10>;
      coord above = refuelTarget + <0, 1, 0>;
      goto(above);
    `);
    expect(result.pieces).toBe(spelledOut.pieces);
    // Both corners of the temp's one-block area are written; see the 1.20.4
    // missing-corner trap on area() in emit/model.ts.
    const area = result.placed!.filter((p) => p.type === "area").at(-1)!;
    expect(area.fields["var1"]).toBe(area.fields["var2"]);
  });

  it("folds constant coordinate arithmetic to a plain constant", () => {
    const result = ok(`
      const home = <10, 64, 10>;
      goto(home + <0, 1, 0>);
    `);
    // No operator widget at all: the sum is a compile-time coordinate.
    expect(types(result)).not.toContain("coordinate_operator");
    const area = result.placed!.find((p) => p.type === "area")!;
    expect(area.fields["pos1"]).toEqual([10, 65, 10]);
    // An int operand behaves as <n, 0, 0>, matching the runtime widget.
    const mixed = ok(`
      const n = 3;
      goto(<10, 64, 10> + n);
    `);
    const mixedArea = mixed.placed!.find((p) => p.type === "area")!;
    expect(mixedArea.fields["pos1"]).toEqual([13, 64, 10]);
  });

  it("splits mixed precedence into one widget per operator class", () => {
    const result = ok(`
      coord a = <1, 1, 1>;
      coord b = <2, 2, 2>;
      coord c = a + b * <3, 3, 3>;
      goto(c);
    `);
    const ops = result.placed!.filter((p) => p.type === "coordinate_operator");
    // a, b, the b*<3,3,3> temp, and c itself.
    expect(ops.map((o) => o.fields["coord_op"])).toEqual([
      "plus_minus",
      "plus_minus",
      "multiply_divide",
      "plus_minus",
    ]);
  });

  it("still rejects a sensor inside inline arithmetic", () => {
    expect(
      errors(`
        coord x = <1, 2, 3>;
        goto(x + items(drone));
      `),
    ).toContain("bad-area");
  });
});

describe("conditions", () => {
  it("rewrites > as <= with the branches swapped", () => {
    const result = okV3(`
      const chest = area(<0, 64, 0>);
      const cobble = filter("minecraft:cobblestone");
      if (items(chest, {only: cobble}) > 10) { wait(20); }
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:condition_item_inventory",
    )!;
    // ">" has no widget, so the compiler emits "<=" and swaps the targets.
    expect((condition["cond"] as Record<string, unknown>)["cond_op"]).toBe("le");
  });

  it("keeps >= as-is", () => {
    const result = okV3(`if (pressure(drone) >= 5) { wait(1); }`);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:drone_condition_pressure",
    )!;
    expect((condition["drone_cond"] as Record<string, unknown>)["cond_op"]).toBeUndefined();
    expect((condition["drone_cond"] as Record<string, unknown>)["required_count"]).toBe(5);
  });

  it("spends no jump widgets on a chain of &&", () => {
    const result = ok(`
      if (pressure(drone) >= 3 && rf(drone) >= 10 && items(drone) >= 1) {
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
      if (pressure(drone) >= 5) { wait(10); } else { wait(20); }
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
      n = pressure(drone);
    `);
    const condition = v3Widgets(result).find(
      (w) => w["type"] === "pneumaticcraft:drone_condition_pressure",
    )!;
    expect((condition["drone_cond"] as Record<string, unknown>)["measure_var"]).toBe("n");
  });

  it("names a target on an if whose other outcome ends the routine", () => {
    // An empty branch is not "stop here": ProgWidgetJump.jumpToLabel falls back
    // to the widget below, so a condition with neither side named would run its
    // own body whatever the answer was. The skip side gets a bare stop label.
    const result = ok(`
      const spots = [<1, 64, 1>, <2, 64, 2>];
      while (true) {
        foreach (spot in spots) {
          if (liquid(spot) < 5000) {
            goto(spot);
            exportLiquid(spot);
          }
        }
        standby();
      }
    `);
    const branch = branchesOf(result, "condition_liquid_inventory");
    // Nothing may sit below: the "already full" side names no label, and an
    // unnamed side runs whatever is underneath. So the body moves into its own
    // chain, named by the side that should run it…
    expect(branch.below).toBeUndefined();
    expect(branch.onTrue).toBeUndefined();
    expect(branch.onFalse).toBeTypeOf("string");
    // …and that chain is a label with the body under it, never a bare label:
    // ProgWidget.addErrors rejects a label with no piece connected.
    expect(chainUnder(result, branch.onFalse!)).toBe("goto");
  });

  it("pays for no stop label when the condition ends its own chain", () => {
    // Here the body is its own chain, so the condition already names it on the
    // true side and nothing sits below: the false side costs nothing.
    const result = ok(`
      if (pressure(drone) >= 5) { suicide(); }
    `);
    const branch = branchesOf(result, "drone_condition_pressure");
    expect(branch.below).toBeUndefined();
    expect(branch.onTrue).toBeTypeOf("string");
    expect(branch.onFalse).toBeUndefined();
    expect(types(result)).not.toContain("jump");
  });

  it("never emits a label or start with nothing under it", () => {
    // ProgWidget.addErrors: a widget with no step input but a step output must
    // have a piece connected below. The verifier reports it, so `ok()` would
    // already throw — this pins the shapes where a chain could end up bare.
    const sources = [
      `if (pressure(drone) >= 5) { wait(1); }`,
      `while (true) { foreach (c in area(<0,64,0>, <2,64,2>)) { if (light(c) >= 5) { dig(c); } } }`,
      `void f() { if (pressure(drone) >= 5) { wait(1); } } f(); f();`,
      `while (true) { if (pressure(drone) >= 5) { suicide(); } wait(20); }`,
      `while (true) { if (pressure(drone) >= 5) { } wait(20); }`,
    ];
    for (const source of sources) {
      const result = ok(source);
      const linked = relink(result.placed!);
      for (const w of linked.widgets) {
        const spec = getWidget(w.placed.type);
        if (spec.hasStepInput || !spec.hasStepOutput) continue;
        expect(w.next, `${source} — ${w.placed.type} #${w.index} has nothing under it`)
          .toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("says so plainly when a program folds away to nothing", () => {
    // A lone start widget is "no piece connected" in the Programmer, but the
    // cause is the source, not a layout fault — so it reads as an error on the
    // program rather than as a structural mismatch to report.
    expect(errors(`if (pressure(drone) >= 5) { }`)).toEqual(["empty-program"]);
  });

  it("never emits a condition the game would call flow-controlless", () => {
    // The verifier reports this shape, so `ok()` would already have thrown —
    // this pins the property across the branch shapes that reach the end of a
    // routine, which is where leaving a side empty used to look free.
    const sources = [
      `if (pressure(drone) >= 5) { wait(1); }`,
      `while (true) { if (pressure(drone) >= 5) { wait(1); } }`,
      `void f() { if (pressure(drone) >= 5) { wait(1); } } f(); f();`,
      `foreach (c in area(<0,64,0>, <2,64,2>)) { if (light(c) >= 5) { dig(c); } }`,
      `if (pressure(drone) >= 5) { wait(1); } else { wait(2); }`,
    ];
    for (const source of sources) {
      const result = ok(source);
      for (const [index, placed] of result.placed!.entries()) {
        if (!getWidget(placed.type).isCondition) continue;
        const branch = branchesAt(result, index);
        expect(
          branch.onTrue !== undefined || branch.onFalse !== undefined,
          `${source} — condition #${index} names neither side`,
        ).toBe(true);
      }
    }
  });
});

describe("loops", () => {
  it("compiles a while loop", () => {
    const result = ok(`
      while (pressure(drone) >= 1) {
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
        if (pressure(drone) <= 1) { break; }
        if (items(drone) >= 64) { continue; }
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

  it("compiles foreach over the drone's items", () => {
    const result = ok(`
      const ores = filter("minecraft:iron_ore");
      const porch = area(<0, 64, 0>);
      foreach (it in items(drone, {only: ores})) {
        dropItems(porch, {only: filter({var: "it"})});
      }
    `);
    expect(types(result)).toContain("for_each_item");
    expect(result.issues).toEqual([]);
  });

  it("rejects foreach items without the drone subject", () => {
    expect(
      errors(`const f = filter("minecraft:dirt"); foreach (it in items(f)) { wait(1); }`),
    ).toContain("foreach-iterable");
  });
});

describe("sensor subjects", () => {
  it("selects the widget by the subject argument", () => {
    const both = ok(`
      const machines = area(<0, 64, 0>, <2, 64, 2>);
      if (pressure(drone) >= 5) { wait(1); }
      if (pressure(machines) >= 5) { wait(1); }
    `);
    expect(types(both)).toContain("drone_condition_pressure");
    expect(types(both)).toContain("condition_pressure");
  });

  it("rejects a drone subject on an area-only sensor", () => {
    expect(errors(`if (light(drone) >= 5) { wait(1); }`)).toContain("wrong-subject");
  });

  it("rejects an area subject on a drone-only sensor", () => {
    expect(errors(`if (upgrades(area(<0,0,0>)) >= 1) { wait(1); }`)).toContain("wrong-subject");
  });

  it("rejects a sensor with no subject at all", () => {
    expect(errors(`if (pressure() >= 5) { wait(1); }`)).toContain("missing-subject");
  });

  it("points the old drone.sensor() spelling at the new one", () => {
    expect(errors(`if (drone.pressure() >= 5) { wait(1); }`)).toContain("unknown-function");
  });

  it("rejects extra positional arguments after the drone subject", () => {
    expect(errors(`if (items(drone, area(<0,0,0>)) >= 1) { wait(1); }`)).toContain("arity");
  });
});

describe("suicide", () => {
  it("compiles to the suicide widget and ends the chain", () => {
    const result = ok(`
      wait(10);
      suicide();
    `);
    expect(types(result)).toContain("suicide");
  });

  it("takes no arguments", () => {
    expect(errors(`suicide(1);`)).toContain("arity");
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
    expect(errors(`pressure(drone);`)).toContain("sensor-as-statement");
  });

  it("explains that a redstone strength must be constant", () => {
    expect(errors(`int n = 5; emitRedstone(n);`)).toContain("bad-text");
  });
});

describe("programmable controller mode", () => {
  /** Diagnostics of one severity, as codes, when compiled for a controller. */
  function forController(
    source: string,
    severity: "error" | "warning",
    target?: Target,
  ): string[] {
    return compile(source, { controller: true, ...(target ? { target } : {}) })
      .diagnostics.filter((d) => d.severity === severity)
      .map((d) => d.code);
  }

  // The mod's check is all-or-nothing: ProgrammableControllerBlockEntity's
  // isItemValid runs every widget past isProgramApplicable, so one excluded
  // piece keeps the whole program out of the slot.
  const excluded: [string, string, Target?][] = [
    ["standby", `standby();`],
    ["teleport", `teleport(area(<0,64,0>));`],
    ["attack", `attack(area(<0,64,0>));`],
    ["importEntities", `importEntities(area(<0,64,0>));`],
    ["exportEntities", `exportEntities(area(<0,64,0>));`],
    // The computer piece only exists on the newer target.
    ["computerControl", `computerControl(area(<0,64,0>));`, "1.21"],
    ["entities(drone)", `if (entities(drone) >= 1) { wait(1); }`],
  ];

  for (const [name, source, target] of excluded) {
    it(`rejects ${name}, which the controller refuses outright`, () => {
      expect(forController(source, "error", target)).toContain("controller-excluded");
      // Only in controller mode: the same program is fine for a drone.
      expect(ok(source, target).pieces).toBeGreaterThan(0);
    });
  }

  it("still accepts entities(area), which is not on the excluded list", () => {
    const source = `if (entities(area(<0,64,0>, <4,64,4>)) >= 1) { wait(1); }`;
    expect(forController(source, "error")).toEqual([]);
    expect(forController(source, "warning")).toEqual([]);
  });

  it("rejects rename, which restarts the program on a controller", () => {
    expect(forController(`rename("Vinnie D"); wait(1);`, "error")).toContain("controller-rename");
    expect(errors(`rename("Vinnie D"); wait(1);`)).toEqual([]);
  });

  it("warns about pieces that load but mean something else", () => {
    expect(forController(`suicide();`, "warning")).toContain("controller-suicide");
    expect(forController(`goto(<1,64,1>);`, "warning")).toContain("controller-goto");
    expect(
      forController(`if (pressure(drone) <= 1) { wait(1); }`, "warning"),
    ).toContain("controller-pressure");
  });

  it("keeps emitting a program when the only findings are warnings", () => {
    const result = compile(`goto(<1,64,1>);`, { controller: true });
    expect(result.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    expect(result.pieces).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
  });

  it("says nothing about a program the controller runs like a drone", () => {
    const source = `
      while (true) {
        if (liquid(drone) <= 1000) { importLiquid(area(<1,64,1>), {count: 15000}); }
        exportLiquid(area(<2,64,2>), {count: 1000});
      }
    `;
    expect(compile(source, { controller: true }).diagnostics).toEqual([]);
  });

  it("checks nothing unless the mode is on", () => {
    expect(compile(`standby(); teleport(area(<0,64,0>));`).diagnostics).toEqual([]);
  });
});
