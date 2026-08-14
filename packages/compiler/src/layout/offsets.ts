/**
 * Chain-level layout offsets: the safe way to rearrange a placed program.
 *
 * Coordinates ARE the structure — the game relinks purely by adjacency — so the
 * only always-safe move is translating a whole connected component (a chain of
 * fall-through widgets plus every parameter hanging off it). Chains reference
 * each other by label *name*, never by position, so translation cannot change
 * what a program means. Callers still re-verify afterwards, because a translated
 * chain can land adjacent to another one and pick up a connection neither meant.
 */

import type { PlacedWidget } from "../emit/model.js";
import { relink } from "../verify/relink.js";

/** Integer program-unit translations, keyed by `chainKeys` signatures. */
export type ChainOffsets = Readonly<Record<string, { dx: number; dy: number }>>;

/**
 * Connected components of the placed program, each sorted ascending and the
 * component list ordered by its smallest widget index. Uses the same relink
 * pass the verifier uses, so "component" means what the game means by it.
 */
export function chainComponents(placed: readonly PlacedWidget[]): number[][] {
  const parent = Array.from({ length: placed.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  const { widgets } = relink(placed);
  for (const w of widgets) {
    if (w.next >= 0) union(w.index, w.next);
    if (w.parent >= 0) union(w.index, w.parent);
    for (const slot of w.parameters) {
      if (slot >= 0) union(w.index, slot);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < placed.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}

/**
 * A position-independent signature per component, stable across recompiles for
 * as long as the chain keeps its shape: the member widget types in placement
 * order plus the first string field found (a label name, jump target, or
 * comment — what most distinguishes one chain from another). Identical chains
 * get `#n` occurrence suffixes; if the compiler reorders two byte-identical
 * unlabeled chains across an edit their offsets swap, which session-only state
 * can tolerate.
 */
export function chainKeys(
  placed: readonly PlacedWidget[],
  components: readonly (readonly number[])[],
): string[] {
  const bases = components.map((members) => {
    const types = members.map((i) => placed[i]!.type).join(">");
    let label = "";
    for (const i of members) {
      const s = placed[i]!.fields["string"];
      if (typeof s === "string" && s) {
        label = s;
        break;
      }
    }
    return `${types}|${label}`;
  });

  const seen = new Map<string, number>();
  return bases.map((base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

export interface AppliedOffsets {
  readonly placed: PlacedWidget[];
  /** The offset keys that matched a current chain; the rest are stale. */
  readonly applied: string[];
}

/**
 * Translate every component whose key appears in `offsets`. Returns a new
 * array (inputs untouched) plus the keys that matched, so callers can prune
 * offsets for chains that no longer exist.
 */
export function applyChainOffsets(
  placed: readonly PlacedWidget[],
  offsets: ChainOffsets,
): AppliedOffsets {
  const out = [...placed];
  const components = chainComponents(placed);
  const keys = chainKeys(placed, components);
  const applied: string[] = [];

  components.forEach((members, c) => {
    const offset = offsets[keys[c]!];
    if (!offset) return;
    applied.push(keys[c]!);
    const dx = Math.trunc(offset.dx);
    const dy = Math.trunc(offset.dy);
    if (dx === 0 && dy === 0) return;
    for (const i of members) {
      const w = out[i]!;
      out[i] = { ...w, x: w.x + dx, y: w.y + dy };
    }
  });

  return { placed: out, applied };
}
