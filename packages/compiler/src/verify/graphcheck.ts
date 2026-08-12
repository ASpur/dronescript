/**
 * Hold the relinked program — what the game will actually see — against what
 * layout intended, and flag anything the mod would reject or misread.
 *
 * A silent mismatch here is the worst failure mode we have: the mod imports a
 * malformed program as an empty one, with nothing but a log line to say why.
 */

import { getWidget } from "../spec/widgets.js";
import type { PlacedWidget } from "../emit/model.js";
import type { IntentNode } from "../layout/place.js";
import { relink } from "./relink.js";
import type { LinkedProgram } from "./relink.js";

export interface VerifyIssue {
  readonly kind:
    | "unintended-link"
    | "missing-link"
    | "duplicate-position"
    | "duplicate-label"
    | "missing-label"
    | "start-count"
    | "invalid-structure";
  readonly message: string;
  /** Index into the placed-widget list, when the issue is about one widget. */
  readonly widget?: number;
}

export interface VerifyResult {
  readonly issues: readonly VerifyIssue[];
  readonly linked: LinkedProgram;
}

function describe(placed: PlacedWidget, index: number): string {
  return `#${index} ${placed.type} at (${placed.x}, ${placed.y})`;
}

/** Text attached to a label/jump/jump_sub, i.e. the name it refers to. */
function labelText(
  linked: LinkedProgram,
  index: number,
): string | undefined {
  const w = linked.widgets[index]!;
  const slot = w.parameters[0];
  if (slot === undefined || slot < 0) return undefined;
  const textWidget = linked.widgets[slot]!;
  if (textWidget.placed.type !== "text") return undefined;
  const s = textWidget.placed.fields["string"];
  return typeof s === "string" ? s : undefined;
}

export function verify(
  placed: readonly PlacedWidget[],
  intent: readonly IntentNode[],
): VerifyResult {
  const issues: VerifyIssue[] = [];
  const linked = relink(placed);

  // Two widgets on the same coordinate: one silently shadows the other in the
  // mod's position index, so connections would be unpredictable.
  const positions = new Map<string, number>();
  placed.forEach((p, i) => {
    const k = `${p.x},${p.y}`;
    const prior = positions.get(k);
    if (prior !== undefined) {
      issues.push({
        kind: "duplicate-position",
        widget: i,
        message: `${describe(p, i)} occupies the same position as ${describe(placed[prior]!, prior)}`,
      });
    } else {
      positions.set(k, i);
    }
  });

  // Compare every connection the game would make against what we meant.
  for (let i = 0; i < placed.length; i++) {
    const w = linked.widgets[i]!;
    const want = intent[i]!;
    const spec = getWidget(placed[i]!.type);

    if (w.next !== want.next) {
      issues.push({
        kind: w.next >= 0 && want.next < 0 ? "unintended-link" : "missing-link",
        widget: i,
        message:
          `${describe(placed[i]!, i)} falls through to ` +
          `${w.next >= 0 ? describe(placed[w.next]!, w.next) : "nothing"}, expected ` +
          `${want.next >= 0 ? describe(placed[want.next]!, want.next) : "nothing"}`,
      });
    }

    const n = spec.params.length;
    for (let row = 0; row < n; row++) {
      checkChain(
        issues,
        linked,
        placed,
        i,
        row,
        w.parameters[row] ?? -1,
        want.params[row] ?? [],
        "whitelist",
      );
      checkChain(
        issues,
        linked,
        placed,
        i,
        row,
        w.parameters[row + n] ?? -1,
        want.blacklist[row] ?? [],
        "blacklist",
      );
    }
  }

  // Exactly one start widget: DroneAIManager scans for it, and the Programmer
  // reports an error when there are several.
  const starts = placed.filter((p) => p.type === "start").length;
  if (starts !== 1) {
    issues.push({
      kind: "start-count",
      message: `program has ${starts} start widgets, expected exactly 1`,
    });
  }

  // Duplicate label names make jumps non-deterministic: the mod collects every
  // matching label and picks one at random.
  const labels = new Map<string, number>();
  for (let i = 0; i < placed.length; i++) {
    if (placed[i]!.type !== "label") continue;
    const name = labelText(linked, i);
    if (name === undefined) {
      issues.push({
        kind: "invalid-structure",
        widget: i,
        message: `${describe(placed[i]!, i)} has no text parameter naming it`,
      });
      continue;
    }
    const prior = labels.get(name);
    if (prior !== undefined) {
      issues.push({
        kind: "duplicate-label",
        widget: i,
        message: `label "${name}" is defined twice (#${prior} and #${i}); jumps to it would be random`,
      });
    } else {
      labels.set(name, i);
    }
  }

  // Every jump target must exist.
  for (let i = 0; i < placed.length; i++) {
    const type = placed[i]!.type;
    if (type !== "jump" && type !== "jump_sub") continue;
    const target = labelText(linked, i);
    if (target === undefined) {
      issues.push({
        kind: "invalid-structure",
        widget: i,
        message: `${describe(placed[i]!, i)} has no text parameter naming its target`,
      });
    } else if (!labels.has(target)) {
      issues.push({
        kind: "missing-label",
        widget: i,
        message: `${describe(placed[i]!, i)} targets label "${target}", which does not exist`,
      });
    }
  }

  // Condition branch targets live in the last parameter row: whitelist side for
  // true, blacklist side for false.
  for (let i = 0; i < placed.length; i++) {
    const spec = getWidget(placed[i]!.type);
    if (!spec.isCondition) continue;
    const n = spec.params.length;
    const w = linked.widgets[i]!;
    const sides: [number, string][] = [
      [w.parameters[n - 1] ?? -1, "true"],
      [w.parameters[2 * n - 1] ?? -1, "false"],
    ];
    let branches = 0;
    for (const [slot, side] of sides) {
      if (slot < 0) continue;
      branches++;
      const s = placed[slot]!.fields["string"];
      if (typeof s !== "string") continue;
      if (!labels.has(s)) {
        issues.push({
          kind: "missing-label",
          widget: i,
          message: `${describe(placed[i]!, i)} jumps to "${s}" when ${side}, but no such label exists`,
        });
      }
    }
    // The mod flags "bad flow control" when both branches are set and something
    // is also connected below.
    if (branches === 2 && w.next >= 0) {
      issues.push({
        kind: "invalid-structure",
        widget: i,
        message: `${describe(placed[i]!, i)} sets both branch targets and also has a widget below it`,
      });
    }
  }

  return { issues, linked };
}

function checkChain(
  issues: VerifyIssue[],
  linked: LinkedProgram,
  placed: readonly PlacedWidget[],
  owner: number,
  row: number,
  head: number,
  want: readonly number[],
  side: "whitelist" | "blacklist",
): void {
  const wantHead = want.length > 0 ? want[0]! : -1;
  if (head !== wantHead) {
    issues.push({
      kind: head >= 0 && wantHead < 0 ? "unintended-link" : "missing-link",
      widget: owner,
      message:
        `${describe(placed[owner]!, owner)} ${side} row ${row} resolved to ` +
        `${head >= 0 ? describe(placed[head]!, head) : "nothing"}, expected ` +
        `${wantHead >= 0 ? describe(placed[wantHead]!, wantHead) : "nothing"}`,
    });
    return;
  }
  if (head < 0) return;

  // Walk the chain the way the mod does, following slot-0 links.
  const actual: number[] = [];
  const seen = new Set<number>();
  let at = head;
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    actual.push(at);
    at = linked.widgets[at]!.parameters[0] ?? -1;
  }

  if (actual.length !== want.length || actual.some((v, i) => v !== want[i])) {
    issues.push({
      kind: "unintended-link",
      widget: owner,
      message:
        `${describe(placed[owner]!, owner)} ${side} row ${row} chain is ` +
        `[${actual.join(", ")}], expected [${want.join(", ")}]`,
    });
  }
}
