/**
 * Program-space geometry, mirroring `ProgWidget.PositionFields`.
 *
 * The mod's helpers all halve the GUI constants, so one program-space unit is
 * two GUI pixels:
 *
 *   rightParam(w, i) = (w.x + w.getWidth()/2,  w.y + i * PROGWIDGET_HEIGHT/2)
 *   leftParam (w, i) = (w.x - paramWidth/2,    w.y + i * 11)
 *   below     (w)    = (w.x,                   w.y + w.getHeight()/2)
 *
 * Every parameter widget type is `PROGWIDGET_WIDTH` (30) wide, so both parameter
 * offsets are exactly 15, and the row pitch is exactly 11.
 */

import { PARAM_X_STEP, PARAM_Y_STEP, getWidget, widgetHeight } from "../spec/widgets.js";
import type { WidgetSpec } from "../spec/types.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function key(x: number, y: number): string {
  return `${x},${y}`;
}

/** Position of the widget that would fall through from this one. */
export function below(spec: WidgetSpec, x: number, y: number): Point {
  return { x, y: y + widgetHeight(spec) };
}

/** Position of whitelist parameter row `row`, link `depth` along the chain. */
export function rightParam(x: number, y: number, row: number, depth = 0): Point {
  return { x: x + PARAM_X_STEP * (depth + 1), y: y + PARAM_Y_STEP * row };
}

/**
 * Position of blacklist parameter row `row` at `depth` links out.
 *
 * The mod finds the widget at x-15 and then walks `getParent()` to the chain
 * root, so the chain extends leftward and is traversed root-first — i.e. the
 * leftmost widget comes first. `chainLength` lets a caller place a chain so that
 * traversal order matches the logical order it passed in.
 */
export function leftParam(x: number, y: number, row: number, depth = 0): Point {
  return { x: x - PARAM_X_STEP * (depth + 1), y: y + PARAM_Y_STEP * row };
}

/** How far right of its origin a widget's whitelist chains reach. */
export function rightExtent(node: {
  type: string;
  params?: readonly (readonly unknown[] | undefined)[];
}): number {
  let max = 0;
  const rows = node.params ?? [];
  for (const chain of rows) {
    if (chain && chain.length > 0) {
      max = Math.max(max, PARAM_X_STEP * chain.length);
    }
  }
  return max;
}

/** How far left of its origin a widget's blacklist chains reach. */
export function leftExtent(node: {
  type: string;
  blacklist?: readonly (readonly unknown[] | undefined)[];
}): number {
  let max = 0;
  const rows = node.blacklist ?? [];
  for (const chain of rows) {
    if (chain && chain.length > 0) {
      max = Math.max(max, PARAM_X_STEP * chain.length);
    }
  }
  return max;
}

export function heightOf(type: string): number {
  return widgetHeight(getWidget(type));
}
