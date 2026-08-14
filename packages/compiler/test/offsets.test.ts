import { describe, expect, it } from "vitest";

import { text, widget } from "../src/emit/model.js";
import type { Program } from "../src/emit/model.js";
import { applyChainOffsets, chainComponents, chainKeys } from "../src/layout/offsets.js";
import { layout } from "../src/layout/place.js";
import { verify } from "../src/verify/graphcheck.js";

/** A main chain and a labelled loop chain, the shape most programs take. */
const TWO_CHAINS: Program = {
  chains: [
    {
      widgets: [
        widget("start"),
        widget("jump", {}, { params: [[text("loop")]] }),
      ],
    },
    {
      widgets: [
        widget("label", {}, { params: [[text("loop")]] }),
        widget("wait", {}, { params: [[text("20")]] }),
      ],
    },
  ],
};

describe("chainComponents", () => {
  it("groups each chain and its parameters into one component", () => {
    const { placed } = layout(TWO_CHAINS);
    const components = chainComponents(placed);
    expect(components).toHaveLength(2);
    // Every widget lands in exactly one component.
    expect(components.flat().sort((a, b) => a - b)).toEqual(placed.map((_, i) => i));
    // The jump's target text belongs to the first chain, the label's to the second.
    const first = new Set(components[0]);
    expect(first.has(placed.findIndex((p) => p.type === "jump"))).toBe(true);
    expect(first.has(placed.findIndex((p) => p.type === "label"))).toBe(false);
  });
});

describe("applyChainOffsets", () => {
  it("translates one chain without disturbing links or the original", () => {
    const { placed, intent } = layout(TWO_CHAINS);
    const components = chainComponents(placed);
    const keys = chainKeys(placed, components);
    const loopKey = keys.find((k) => k.includes("label"))!;

    const { placed: adjusted, applied } = applyChainOffsets(placed, {
      [loopKey]: { dx: 7, dy: 5 },
    });

    expect(applied).toEqual([loopKey]);
    expect(verify(adjusted, intent).issues).toEqual([]);
    const moved = new Set(components[keys.indexOf(loopKey)]);
    placed.forEach((before, i) => {
      const after = adjusted[i]!;
      const d = moved.has(i) ? { x: 7, y: 5 } : { x: 0, y: 0 };
      expect(after.x).toBe(before.x + d.x);
      expect(after.y).toBe(before.y + d.y);
      // The input array is untouched.
      expect(placed[i]).toBe(before);
    });
  });

  it("reports unmatched keys as not applied", () => {
    const { placed } = layout(TWO_CHAINS);
    const { placed: adjusted, applied } = applyChainOffsets(placed, {
      "no>such>chain|#0": { dx: 3, dy: 3 },
    });
    expect(applied).toEqual([]);
    expect(adjusted).toEqual(placed);
  });

  it("verify flags a chain translated into step-adjacency with another", () => {
    // The second chain's head is a bare wait — it has a step input, so parking
    // it exactly below the first chain's tail forges a fall-through link.
    const program: Program = {
      chains: [
        { widgets: [widget("start"), widget("wait", {}, { params: [[text("1")]] })] },
        { widgets: [widget("wait", {}, { params: [[text("2")]] })] },
      ],
    };
    const { placed, intent } = layout(program);
    expect(verify(placed, intent).issues).toEqual([]);

    const components = chainComponents(placed);
    const keys = chainKeys(placed, components);
    // Chain gap is 22, so pulling the second chain up 22 lands its head on the
    // exact cell the first chain falls through to.
    const { placed: adjusted } = applyChainOffsets(placed, {
      [keys[1]!]: { dx: 0, dy: -22 },
    });
    const { issues } = verify(adjusted, intent);
    expect(issues.some((i) => i.kind === "unintended-link")).toBe(true);
  });

  it("verify flags a chain translated onto another", () => {
    const { placed, intent } = layout(TWO_CHAINS);
    const components = chainComponents(placed);
    const keys = chainKeys(placed, components);
    const label = placed.findIndex((p) => p.type === "label");
    const start = placed.findIndex((p) => p.type === "start");
    const dy = placed[start]!.y - placed[label]!.y;

    const loopKey = keys.find((k) => k.includes("label"))!;
    const { placed: adjusted } = applyChainOffsets(placed, {
      [loopKey]: { dx: 0, dy },
    });
    const { issues } = verify(adjusted, intent);
    expect(issues.some((i) => i.kind === "duplicate-position")).toBe(true);
  });
});

describe("chainKeys", () => {
  it("is stable under translation and distinguishes identical chains", () => {
    const program: Program = {
      chains: [
        { widgets: [widget("start"), widget("suicide")] },
        { widgets: [widget("wait", {}, { params: [[text("5")]] })] },
        { widgets: [widget("wait", {}, { params: [[text("5")]] })] },
      ],
    };
    const { placed } = layout(program);
    const components = chainComponents(placed);
    const keys = chainKeys(placed, components);
    expect(new Set(keys).size).toBe(keys.length);
    // The two identical wait chains differ only in their occurrence suffix.
    expect(keys[1]!.replace(/#\d+$/, "")).toBe(keys[2]!.replace(/#\d+$/, ""));

    // Moving a chain does not change any key.
    const { placed: adjusted } = applyChainOffsets(placed, {
      [keys[2]!]: { dx: 40, dy: 13 },
    });
    expect(chainKeys(adjusted, chainComponents(adjusted))).toEqual(keys);
  });
});
