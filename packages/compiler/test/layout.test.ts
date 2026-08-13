import { describe, expect, it } from "vitest";

import { build } from "../src/pipeline.js";
import { area, coordinate, param, text, widget } from "../src/emit/model.js";
import type { Program } from "../src/emit/model.js";
import { layout } from "../src/layout/place.js";
import { verify } from "../src/verify/graphcheck.js";
import { relink } from "../src/verify/relink.js";

const box = { type: "box" };

describe("geometry", () => {
  it("steps down by 11 per parameter row", () => {
    // start has no parameters (height 11); dig has two (height 22).
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("dig", { dig_place: { order: "closest" } }, {
              params: [[area([0, 64, 0], [4, 64, 4], box)]],
            }),
            widget("wait", {}, { params: [[text("20")]] }),
          ],
        },
      ],
    };
    const { placed } = layout(program);
    const byType = Object.fromEntries(placed.map((p) => [p.type, p]));
    expect(byType["start"]).toMatchObject({ x: 0, y: 0 });
    expect(byType["dig"]).toMatchObject({ x: 0, y: 11 });
    expect(byType["area"]).toMatchObject({ x: 15, y: 11 });
    expect(byType["wait"]).toMatchObject({ x: 0, y: 33 });
    expect(byType["text"]).toMatchObject({ x: 15, y: 33 });
  });

  it("places whitelist chains rightward at 15-unit steps", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("goto", {}, {
              params: [[area([0, 64, 0], undefined, box), area([9, 64, 9], undefined, box)]],
            }),
          ],
        },
      ],
    };
    const { placed, intent } = layout(program);
    const areas = placed.filter((p) => p.type === "area");
    expect(areas.map((a) => a.x)).toEqual([15, 30]);
    expect(areas.every((a) => a.y === 11)).toBe(true);
    // The links within a chain are connections too, and must be accounted for.
    expect(verify(placed, intent).issues).toEqual([]);
  });

  it("places blacklist chains leftward, root first", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("dig", { dig_place: { order: "closest" } }, {
              params: [[area([0, 64, 0], [9, 64, 9], box)]],
              blacklist: [[area([1, 64, 1], undefined, box), area([2, 64, 2], undefined, box)]],
            }),
          ],
        },
      ],
    };
    const { placed, intent } = layout(program);
    const dig = placed.findIndex((p) => p.type === "dig");
    // Two blacklist links occupy x-30 and x-15; the root (logical element 0)
    // is the leftmost, which is what the mod resolves the slot to.
    const xs = intent[dig]!.blacklist[0]!.map((i) => placed[i]!.x);
    expect(xs).toEqual([-30, -15]);
    expect(verify(placed, intent).issues).toEqual([]);
  });
});

describe("relink", () => {
  it("reconstructs the same graph the layout intended", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("inventory_import", {}, {
              params: [[area([100, 64, 200], undefined, box)], [param("item_filter", {
                chk_item: { id: "minecraft:cobblestone" },
              })]],
            }),
            widget("jump", {}, { params: [[text("loop")]] }),
          ],
        },
        {
          name: "loop",
          widgets: [
            widget("label", {}, { params: [[text("loop")]] }),
            widget("wait", {}, { params: [[text("20")]] }),
          ],
        },
      ],
    };
    const { placed, intent } = layout(program);
    const linked = relink(placed);

    const idx = (type: string) => placed.findIndex((p) => p.type === type);
    const start = linked.widgets[idx("start")]!;
    expect(placed[start.next]!.type).toBe("inventory_import");

    const importer = linked.widgets[idx("inventory_import")]!;
    expect(placed[importer.parameters[0]!]!.type).toBe("area");
    expect(placed[importer.parameters[1]!]!.type).toBe("item_filter");
    expect(placed[importer.next]!.type).toBe("jump");

    // A jump has no step output, so nothing may follow it.
    expect(linked.widgets[idx("jump")]!.next).toBe(-1);
    expect(verify(placed, intent).issues).toEqual([]);
  });

  it("never falls through into a label", () => {
    // Two chains stacked in one column: the second starts with a label, which
    // has no step input, so the chains stay independent.
    const program: Program = {
      chains: [
        { widgets: [widget("start"), widget("suicide")] },
        {
          widgets: [
            widget("label", {}, { params: [[text("a")]] }),
            widget("wait", {}, { params: [[text("5")]] }),
          ],
        },
      ],
    };
    const { placed, intent } = layout(program);
    expect(verify(placed, intent).issues).toEqual([]);
  });
});

describe("verify", () => {
  it("flags an unintended step connection", () => {
    const program: Program = {
      chains: [{ widgets: [widget("start"), widget("wait", {}, { params: [[text("1")]] })] }],
    };
    const { placed, intent } = layout(program);
    // Drop a second wait exactly where the first one falls through to.
    const wait = placed.find((p) => p.type === "wait")!;
    const sabotaged = [...placed, { type: "wait", x: wait.x, y: wait.y + 11, fields: {} }];
    const sabotagedIntent = [...intent, { next: -1, params: [[]], blacklist: [[]] }];
    const { issues } = verify(sabotaged, sabotagedIntent);
    expect(issues.some((i) => i.kind === "unintended-link")).toBe(true);
  });

  it("flags duplicate label names", () => {
    const program: Program = {
      chains: [
        { widgets: [widget("start"), widget("jump", {}, { params: [[text("dup")]] })] },
        { widgets: [widget("label", {}, { params: [[text("dup")]] }), widget("suicide")] },
        { widgets: [widget("label", {}, { params: [[text("dup")]] }), widget("suicide")] },
      ],
    };
    const { placed, intent } = layout(program);
    const { issues } = verify(placed, intent);
    expect(issues.some((i) => i.kind === "duplicate-label")).toBe(true);
  });

  it("flags a jump to a label that does not exist", () => {
    const program: Program = {
      chains: [{ widgets: [widget("start"), widget("jump", {}, { params: [[text("nowhere")]] })] }],
    };
    const { placed, intent } = layout(program);
    const { issues } = verify(placed, intent);
    expect(issues.some((i) => i.kind === "missing-label")).toBe(true);
  });

  it("flags a condition that branches both ways and also has a widget below", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("drone_condition_pressure", { drone_cond: { cond_op: "ge" } }, {
              params: [[text("high")]],
              blacklist: [[text("low")]],
            }),
            widget("suicide"),
          ],
        },
        { widgets: [widget("label", {}, { params: [[text("high")]] }), widget("suicide")] },
        { widgets: [widget("label", {}, { params: [[text("low")]] }), widget("suicide")] },
      ],
    };
    const { placed, intent } = layout(program);
    const { issues } = verify(placed, intent);
    expect(issues.some((i) => i.kind === "invalid-structure")).toBe(true);
  });

  it("accepts a condition that branches one way and falls through the other", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("drone_condition_pressure", { drone_cond: { cond_op: "ge" } }, {
              params: [[text("refill")]],
            }),
            widget("suicide"),
          ],
        },
        { widgets: [widget("label", {}, { params: [[text("refill")]] }), widget("suicide")] },
      ],
    };
    const { placed, intent } = layout(program);
    expect(verify(placed, intent).issues).toEqual([]);
  });
});

describe("build", () => {
  it("emits importable v3 JSON", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("goto", {}, { params: [[area([10, 64, 10], undefined, box)]] }),
            widget("dig", { dig_place: { order: "closest" } }, {
              params: [[area([10, 60, 10], [20, 64, 20], box)]],
            }),
            widget("jump", {}, { params: [[text("main")]] }),
          ],
        },
        {
          widgets: [
            widget("label", {}, { params: [[text("main")]] }),
            widget("wait", {}, { params: [[text("20")]] }),
          ],
        },
      ],
    };
    const result = build(program, { target: "1.21" });
    expect((result.json as any).version).toBe(3);
    expect(result.issues).toEqual([]);

    const start = (result.json as any).widgets.find((w: Record<string, unknown>) => w["type"] === "pneumaticcraft:start");
    expect(start).toEqual({ type: "pneumaticcraft:start", pos: { x: 0, y: 0 } });

    const dig = (result.json as any).widgets.find((w: Record<string, unknown>) => w["type"] === "pneumaticcraft:dig")!;
    // `dig_place` is a required key in the mod's codec even when otherwise default.
    expect(dig["dig_place"]).toEqual({ order: "closest" });

    const areaWidget = (result.json as any).widgets.find((w: Record<string, unknown>) => w["type"] === "pneumaticcraft:area")!;
    expect(areaWidget["area_type"]).toEqual({ type: "pneumaticcraft:box" });
    expect(areaWidget["pos1"]).toEqual([10, 64, 10]);

    // Every widget except comments costs a Programming Puzzle piece.
    expect(result.pieces).toBe(result.placed.length);
  });

  it("writes required groups even when every setting is default", () => {
    const program: Program = {
      chains: [
        {
          widgets: [
            widget("start"),
            widget("inventory_import", {}, { params: [[area([0, 64, 0], undefined, box)]] }),
          ],
        },
      ],
    };
    const { json } = build(program, { target: "1.21" });
    const importer = (json as any).widgets.find((w: Record<string, unknown>) => w["type"] === "pneumaticcraft:inventory_import")!;
    expect(importer["inv"]).toEqual({});
  });

  it("rejects a field the widget does not have", () => {
    const program: Program = {
      chains: [{ widgets: [widget("start"), widget("wait", { nonsense: 1 }, { params: [[text("1")]] })] }],
    };
    expect(() => build(program, { target: "1.21" })).toThrow(/no field "nonsense"/);
  });

  it("rejects a missing required field", () => {
    const program: Program = {
      chains: [{ widgets: [widget("start"), widget("dig", {}, {})] }],
    };
    expect(() => build(program, { target: "1.21" })).toThrow(/order/);
  });

  it("rejects a parameter of the wrong type", () => {
    const program: Program = {
      chains: [{ widgets: [widget("start"), widget("wait", {}, { params: [[coordinate([0, 0, 0])]] })] }],
    };
    expect(() => build(program, { target: "1.21" })).toThrow(/expects a text parameter/);
  });
});
