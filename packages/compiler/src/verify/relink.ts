/**
 * A faithful port of `ProgWidgetUtils.updatePuzzleConnections`.
 *
 * This is the compiler's correctness keystone: it reconstructs the program graph
 * from emitted coordinates exactly the way the game will, so we can assert that
 * what the game sees matches what we meant — and, just as importantly, that no
 * two widgets accidentally landed on connecting coordinates.
 */

import {
  PARAM_X_STEP,
  PARAM_Y_STEP,
  getWidget,
  widgetHeight,
  widgetWidth,
} from "../spec/widgets.js";
import type { PlacedWidget } from "../emit/model.js";
import { key } from "../layout/geometry.js";

export interface LinkedWidget {
  readonly index: number;
  readonly placed: PlacedWidget;
  /**
   * Length `2 * params.length`: slots `[0, n)` are whitelist (right side),
   * `[n, 2n)` are blacklist (left side). Values are indices into the widget
   * list, or -1.
   */
  readonly parameters: number[];
  /** Index of the widget this one falls through to, or -1. */
  next: number;
  /** Index of the widget this one is a parameter of, or -1. */
  parent: number;
}

export interface LinkedProgram {
  readonly widgets: readonly LinkedWidget[];
  readonly byPosition: ReadonlyMap<string, number>;
}

/**
 * Rebuild connections from positions. Mirrors the mod's three passes: index by
 * position, then whitelist parameters + step-below, then blacklist parameters
 * resolved to their chain root.
 */
export function relink(placed: readonly PlacedWidget[]): LinkedProgram {
  const widgets: LinkedWidget[] = placed.map((p, index) => {
    const spec = getWidget(p.type);
    return {
      index,
      placed: p,
      parameters: new Array<number>(spec.params.length * 2).fill(-1),
      next: -1,
      parent: -1,
    };
  });

  // Pass 1 — index by exact position. A later widget at a duplicate position
  // overwrites an earlier one, matching HashMap.put.
  const byPosition = new Map<string, number>();
  for (const w of widgets) {
    byPosition.set(key(w.placed.x, w.placed.y), w.index);
  }

  // Pass 2 — whitelist parameters and step connections.
  for (const w of widgets) {
    const spec = getWidget(w.placed.type);
    for (let row = 0; row < spec.params.length; row++) {
      // rightParam uses the *owner's* width, so a wider widget reaches further.
      const at = byPosition.get(
        key(w.placed.x + widgetWidth(spec), w.placed.y + PARAM_Y_STEP * row),
      );
      if (at === undefined) continue;
      const found = widgets[at]!;
      const foundSpec = getWidget(found.placed.type);
      // canSetParameter is always true for whitelist slots on widgets that have
      // parameters; the type must match the slot's declared parameter type.
      if (foundSpec.returnType === spec.params[row]!.type) {
        w.parameters[row] = at;
        found.parent = w.index;
      }
    }

    if (spec.hasStepOutput) {
      const at = byPosition.get(key(w.placed.x, w.placed.y + widgetHeight(spec)));
      if (at !== undefined && getWidget(widgets[at]!.placed.type).hasStepInput) {
        w.next = at;
      }
    }
  }

  // Pass 3 — blacklist parameters, resolved to the root of the parent chain.
  // Only program widgets (returnType null) participate.
  for (const w of widgets) {
    const spec = getWidget(w.placed.type);
    if (spec.returnType !== undefined) continue;
    for (let row = 0; row < spec.params.length; row++) {
      if (!spec.params[row]!.blacklist) continue;
      const at = byPosition.get(
        key(w.placed.x - PARAM_X_STEP, w.placed.y + PARAM_Y_STEP * row),
      );
      if (at === undefined) continue;
      const found = widgets[at]!;
      if (getWidget(found.placed.type).returnType !== spec.params[row]!.type) continue;
      let root = found;
      const guard = new Set<number>([root.index]);
      while (root.parent >= 0) {
        const parent = widgets[root.parent]!;
        if (guard.has(parent.index)) break; // cycles are impossible, but be safe
        guard.add(parent.index);
        root = parent;
      }
      w.parameters[row + spec.params.length] = root.index;
    }
  }

  return { widgets, byPosition };
}

/** Walk a whitelist parameter chain from its head, following slot-0 links. */
export function chainFrom(program: LinkedProgram, start: number): LinkedWidget[] {
  const out: LinkedWidget[] = [];
  const seen = new Set<number>();
  let at = start;
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    const w = program.widgets[at]!;
    out.push(w);
    at = w.parameters[0] ?? -1;
  }
  return out;
}
