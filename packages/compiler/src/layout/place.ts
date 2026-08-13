/**
 * Layout: assign exact integer coordinates to every widget.
 *
 * The mod rebuilds a program's structure purely from coordinates, with no
 * tolerance — so this stage is where intent becomes semantics. Two widgets that
 * land on connecting coordinates ARE connected, whether or not we meant it.
 * Layout therefore also records what it intended, so `verify/graphcheck.ts` can
 * hold the relinked result against it.
 */

import { PARAM_X_STEP, getWidget, widgetHeight, widgetWidth } from "../spec/widgets.js";
import type { Chain, PlacedWidget, Program, WidgetNode } from "../emit/model.js";
import { leftExtent, rightExtent } from "./geometry.js";

export interface LayoutOptions {
  /** Start a new column once a column grows past this many units tall. */
  readonly columnHeight?: number;
  /** Vertical gap between chains stacked in the same column. */
  readonly chainGap?: number;
  /** Horizontal gap between the extents of adjacent columns. */
  readonly columnGap?: number;
}

/** What layout meant to connect, indexed in step with `placed`. */
export interface IntentNode {
  /** Index of the widget below this one, or -1. */
  next: number;
  /** Whitelist chains per parameter row, as widget indices in logical order. */
  readonly params: number[][];
  /** Blacklist chains per parameter row, in logical order. */
  readonly blacklist: number[][];
}

export interface LayoutResult {
  readonly placed: readonly PlacedWidget[];
  readonly intent: readonly IntentNode[];
}

const DEFAULTS = {
  columnHeight: 2000,
  chainGap: 22,
  columnGap: 30,
} as const;

interface ChainMetrics {
  readonly height: number;
  readonly left: number;
  readonly right: number;
}

function measureChain(chain: Chain): ChainMetrics {
  let height = 0;
  let left = 0;
  let right = 0;
  for (const node of chain.widgets) {
    height += widgetHeight(getWidget(node.type));
    right = Math.max(right, rightExtent(node));
    left = Math.max(left, leftExtent(node));
  }
  return { height, left, right };
}

function rowOffset(row: number): number {
  return 11 * row;
}

class Placer {
  readonly placed: PlacedWidget[] = [];
  readonly intent: IntentNode[] = [];

  /** Emits a widget and everything hanging off it; returns its index. */
  place(node: WidgetNode, x: number, y: number): number {
    const index = this.placed.length;
    this.placed.push({
      type: node.type,
      x,
      y,
      fields: node.fields,
      origin: node.origin,
    });
    const spec = getWidget(node.type);
    const self: IntentNode = {
      next: -1,
      params: spec.params.map(() => []),
      blacklist: spec.params.map(() => []),
    };
    this.intent.push(self);

    const whitelist = node.params ?? [];
    if (whitelist.length > spec.params.length) {
      throw new Error(
        `${node.type} has ${spec.params.length} parameter rows, got ${whitelist.length}`,
      );
    }
    for (let row = 0; row < whitelist.length; row++) {
      const linkChain = whitelist[row];
      if (!linkChain || linkChain.length === 0) continue;
      const rowY = y + rowOffset(row);
      const expected = spec.params[row]!.type;
      const placedIndices: number[] = [];
      for (let depth = 0; depth < linkChain.length; depth++) {
        const child = linkChain[depth]!;
        if (getWidget(child.type).returnType !== expected) {
          throw new Error(
            `${node.type} row ${row} expects a ${expected} parameter, got ${child.type}`,
          );
        }
        // The first hop is the owner's own width; each later link hangs off the
        // previous parameter widget's slot 0, which is always 15 wide.
        placedIndices.push(
          this.place(child, x + widgetWidth(spec) + PARAM_X_STEP * depth, rowY),
        );
      }
      self.params[row]!.push(...placedIndices);
      this.linkChainElements(placedIndices);
    }

    const blacklist = node.blacklist ?? [];
    for (let row = 0; row < blacklist.length; row++) {
      const linkChain = blacklist[row];
      if (!linkChain || linkChain.length === 0) continue;
      if (!spec.params[row]?.blacklist) {
        throw new Error(`${node.type} does not accept a blacklist parameter on row ${row}`);
      }
      const rowY = y + rowOffset(row);
      const expected = spec.params[row]!.type;
      const n = linkChain.length;
      const placedIndices: number[] = [];
      for (let i = 0; i < n; i++) {
        const child = linkChain[i]!;
        if (getWidget(child.type).returnType !== expected) {
          throw new Error(
            `${node.type} blacklist row ${row} expects a ${expected} parameter, got ${child.type}`,
          );
        }
        // The mod walks to the chain root before attaching, so the root — the
        // leftmost widget — is visited first. Placing logical element i at
        // distance (n - i) makes traversal order match the caller's order.
        placedIndices.push(this.place(child, x - PARAM_X_STEP * (n - i), rowY));
      }
      self.blacklist[row]!.push(...placedIndices);
      this.linkChainElements(placedIndices);
    }

    return index;
  }

  /**
   * Record the links that hold a parameter chain together. Each element sits in
   * the previous one's own slot-0 position, so the game links them to each other
   * as well as linking the chain head to its owner.
   */
  private linkChainElements(indices: readonly number[]): void {
    for (let i = 0; i + 1 < indices.length; i++) {
      const link = this.intent[indices[i]!]!;
      if (link.params[0] !== undefined && link.params[0].length > 0) {
        throw new Error(
          `a chained parameter cannot also carry its own row-0 parameter; ` +
            `express the whole chain as one list instead`,
        );
      }
      link.params[0] = [indices[i + 1]!];
    }
  }

  placeChain(chain: Chain, x: number, y: number): number {
    let cursor = y;
    let previous = -1;
    for (const node of chain.widgets) {
      const index = this.place(node, x, cursor);
      if (previous >= 0) this.intent[previous]!.next = index;
      previous = index;
      cursor += widgetHeight(getWidget(node.type));
    }
    return cursor;
  }
}

export function layout(program: Program, options: LayoutOptions = {}): LayoutResult {
  const columnHeight = options.columnHeight ?? DEFAULTS.columnHeight;
  const chainGap = options.chainGap ?? DEFAULTS.chainGap;
  const columnGap = options.columnGap ?? DEFAULTS.columnGap;

  // Group chains into columns first, so each column can be spaced according to
  // the widest parameter chains it actually contains.
  const columns: { chains: Chain[]; left: number; right: number }[] = [];
  let current: { chains: Chain[]; left: number; right: number } | undefined;
  let currentHeight = 0;

  for (const chain of program.chains) {
    const m = measureChain(chain);
    if (!current || (currentHeight > 0 && currentHeight + m.height > columnHeight)) {
      current = { chains: [], left: 0, right: 0 };
      columns.push(current);
      currentHeight = 0;
    }
    current.chains.push(chain);
    current.left = Math.max(current.left, m.left);
    current.right = Math.max(current.right, m.right);
    currentHeight += m.height + chainGap;
  }

  const placer = new Placer();
  let x = 0;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    if (i > 0) {
      x += columns[i - 1]!.right + col.left + columnGap;
    }
    let y = 0;
    for (const chain of col.chains) {
      y = placer.placeChain(chain, x, y) + chainGap;
    }
  }

  return { placed: placer.placed, intent: placer.intent };
}
