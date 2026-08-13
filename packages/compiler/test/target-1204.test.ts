import { describe, expect, it } from "vitest";

import { compile } from "../src/api.js";

/**
 * PneumaticCraft 7.0.x renders NBT as JSON with an explicit type tag on every
 * value. `JsonToNBTConverter` calls `getAsJsonObject()` on each one, so a bare
 * number or string anywhere would make the import fail outright.
 */
function ok(source: string) {
  const result = compile(source, { target: "1.20.4" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(result.issues).toEqual([]);
  return result;
}

function widgets(result: ReturnType<typeof compile>): Record<string, any>[] {
  const root = result.json as Record<string, any>;
  return root["pneumaticcraft:progWidgets"].value;
}

describe("1.20.4 target", () => {
  it("wraps the widget list in the NBT envelope", () => {
    const result = ok(`goto(area(<0, 64, 0>));`);
    const root = result.json as Record<string, any>;
    expect(Object.keys(root)).toEqual(["pneumaticcraft:progWidgets"]);
    // Tag id 9 is a list.
    expect(root["pneumaticcraft:progWidgets"].type).toBe(9);
    expect(result.target).toBe("1.20.4");
  });

  it("tags every value, so the importer's getAsJsonObject never fails", () => {
    const result = ok(`goto(area(<0, 64, 0>));`);
    const check = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(check);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const value of Object.values(node as Record<string, unknown>)) {
        expect(typeof value).toBe("object");
        const tagged = value as { type?: unknown; value?: unknown };
        expect(typeof tagged.type).toBe("number");
        check(tagged.value);
      }
    };
    check(widgets(result));
  });

  it("names widgets without the mod namespace", () => {
    const result = ok(`goto(area(<0, 64, 0>));`);
    const names = widgets(result).map((w) => w["name"].value);
    expect(names).toEqual(["start", "goto", "area"]);
  });

  it("writes positions as plain ints alongside the name", () => {
    const result = ok(`goto(area(<0, 64, 0>));`);
    const [start, target] = widgets(result);
    expect(start!["x"]).toEqual({ type: 3, value: 0 });
    expect(start!["y"]).toEqual({ type: 3, value: 0 });
    // The goto sits one step below the start widget.
    expect(target!["y"]).toEqual({ type: 3, value: 11 });
  });

  it("writes a block position as a compound of X, Y and Z", () => {
    const result = ok(`goto(area(<1, 64, -3>));`);
    const area = widgets(result).find((w) => w["name"].value === "area")!;
    expect(area["pos1"]).toEqual({
      type: 10,
      value: { X: { type: 3, value: 1 }, Y: { type: 3, value: 64 }, Z: { type: 3, value: -3 } },
    });
    expect(area["type"]).toEqual({ type: 8, value: "box" });
  });

  it("names both corners of a one-point area, however it is written", () => {
    // A missing pos2 is not "unset" on this version: readFromNBT runs
    // NbtUtils.readBlockPos(tag.getCompound("pos2")), and the empty compound
    // reads its X/Y/Z back as 0. So an omitted second corner puts the area's far
    // end at the world origin, and the drone dies with "Area too large".
    const area = (source: string) =>
      widgets(ok(source)).find((w) => w["name"].value === "area")!;

    const literal = area(`goto(area(<1, 64, -3>));`);
    expect(literal["pos2"]).toEqual(literal["pos1"]);

    const bare = area(`goto(<1, 64, -3>);`);
    expect(bare["pos2"]).toEqual(bare["pos1"]);

    // Variable corners have the same problem: var2 left empty falls back to pos2.
    const variable = area(`goto($owner_pos);`);
    expect(variable["var1"]).toEqual({ type: 8, value: "$owner_pos" });
    expect(variable["var2"]).toEqual({ type: 8, value: "$owner_pos" });
  });

  it("flattens the grouped fields the newer format nests", () => {
    const result = ok(`
      const chest = area(<0, 64, 0>);
      importItems(chest, {sides: ["up", "down"], count: 32});
    `);
    const importer = widgets(result).find((w) => w["name"].value === "inventory_import")!;
    // Sides become one boolean per direction, not a bitmask.
    expect(importer["UP"]).toEqual({ type: 1, value: 1 });
    expect(importer["DOWN"]).toEqual({ type: 1, value: 1 });
    expect(importer["NORTH"]).toBeUndefined();
    expect(importer["count"]).toEqual({ type: 3, value: 32 });
    expect(importer["useCount"]).toEqual({ type: 1, value: 1 });
    expect(importer["inv"]).toBeUndefined();
  });

  it("stores enums as the ordinals this version uses", () => {
    const result = ok(`dig(area(<0, 0, 0>, <3, 3, 3>), {order: "highToLow"});`);
    const dig = widgets(result).find((w) => w["name"].value === "dig")!;
    // Ordering: CLOSEST, LOW_TO_HIGH, HIGH_TO_LOW
    expect(dig["order"]).toEqual({ type: 3, value: 2 });
  });

  it("stores a condition operator as a byte ordinal and flattens its count", () => {
    const result = ok(`if (drone.pressure() >= 5) { wait(1); }`);
    const cond = widgets(result).find((w) => w["name"].value === "drone_condition_pressure")!;
    // Operator: EQ, GE, LE
    expect(cond["operator"]).toEqual({ type: 1, value: 1 });
    expect(cond["requiredCount"]).toEqual({ type: 3, value: 5 });
    expect(cond["drone_cond"]).toBeUndefined();
  });

  it("writes axis options as three booleans", () => {
    const result = ok(`
      coord p = <1, 2, 3>;
      coord q = <4, 5, 6>;
      if (p.y >= q.y) { wait(5); }
    `);
    const cond = widgets(result).find((w) => w["name"].value === "condition_coordinate")!;
    expect(cond["checkX"]).toEqual({ type: 1, value: 0 });
    expect(cond["checkY"]).toEqual({ type: 1, value: 1 });
    expect(cond["checkZ"]).toEqual({ type: 1, value: 0 });
  });

  it("writes an item filter the way ItemStack.save did", () => {
    const result = ok(`
      const cobble = filter("minecraft:cobblestone");
      dig(area(<0, 0, 0>), {only: cobble});
    `);
    const filter = widgets(result).find((w) => w["name"].value === "item_filter")!;
    expect(filter["id"]).toEqual({ type: 8, value: "minecraft:cobblestone" });
    expect(filter["Count"]).toEqual({ type: 1, value: 1 });
  });

  it("reports a setting this version does not have, rather than dropping it", () => {
    const result = compile(`dig(area(<0, 0, 0>), {digSide: "north"});`, { target: "1.20.4" });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((d) => /7\.0\.x has no support/.test(d.message))).toBe(true);
  });

  it("still emits the codec format for the 1.21 target", () => {
    const result = compile(`goto(area(<0, 64, 0>));`, { target: "1.21" });
    const root = result.json as Record<string, unknown>;
    expect(root["version"]).toBe(3);
    expect(root["widgets"]).toBeDefined();
  });

  it("lays widgets out identically for both targets", () => {
    // Geometry is the same in both versions, so only the encoding should differ.
    const a = compile(`goto(area(<0, 64, 0>));`, { target: "1.20.4" });
    const b = compile(`goto(area(<0, 64, 0>));`, { target: "1.21" });
    expect(a.placed?.map((p) => [p.type, p.x, p.y])).toEqual(
      b.placed?.map((p) => [p.type, p.x, p.y]),
    );
  });
});
