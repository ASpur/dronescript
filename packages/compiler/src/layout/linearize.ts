/**
 * Turn the CFG into chains of widgets.
 *
 * The governing constraint is that a label widget has no step input: control
 * can never fall into it from above. So any block reachable by more than one
 * path must start its own chain behind a label, and every edge into it must be
 * made explicit — either a jump widget (2 widgets) or, far cheaper, a target
 * written into a condition widget's text parameter (1 widget).
 *
 * Fall-through is therefore the thing worth maximising, and trace formation is
 * what does it: a block with a single predecessor is appended to that
 * predecessor's chain and needs no label at all.
 */

import type { Block, BlockId, IrProgram, Routine, Terminator } from "../ir/ir.js";
import { successors } from "../ir/ir.js";
import type { Chain, Program, WidgetNode } from "../emit/model.js";
import { text, widget } from "../emit/model.js";
import { getWidget } from "../spec/widgets.js";

interface RoutineLayout {
  readonly routine: Routine;
  readonly labels: Map<BlockId, string>;
}

export function linearize(ir: IrProgram): Program {
  const chains: Chain[] = [];
  let labelCounter = 0;
  const nextLabel = () => `L${labelCounter++}`;

  for (const routine of [ir.main, ...ir.routines]) {
    chains.push(...linearizeRoutine(routine, nextLabel, routine === ir.main));
  }
  return { chains };
}

function linearizeRoutine(
  routine: Routine,
  nextLabel: () => string,
  isMain: boolean,
): Chain[] {
  simplifyTerminators(routine, collectReachable(routine), isMain);
  const reachable = collectReachable(routine);
  const resolve = buildJumpThreading(routine, reachable);
  const predecessors = countPredecessors(routine, reachable, resolve);
  const endsChain = (id: BlockId) => isEndBlock(routine, resolve(id));

  // Trace formation: follow fall-through as far as it goes.
  const placed = new Set<BlockId>();
  const traces: BlockId[][] = [];
  const worklist: BlockId[] = [routine.entry];

  while (worklist.length > 0) {
    const head = worklist.shift()!;
    if (placed.has(head) || !reachable.has(head)) continue;

    const trace: BlockId[] = [];
    let at: BlockId | undefined = head;
    while (at !== undefined && !placed.has(at)) {
      placed.add(at);
      trace.push(at);
      const block: Block = routine.blocks.get(at)!;
      for (const s of successors(block.terminator)) worklist.push(resolve(s));

      // At most one real predecessor means no other path needs to reach this
      // block, so it needs no label and can simply sit below. A count of zero
      // happens when the only way in is through collapsed empty blocks.
      at = fallThroughCandidates(block.terminator, resolve, endsChain).find(
        (candidate) =>
          !placed.has(candidate) &&
          candidate !== routine.entry &&
          (predecessors.get(candidate) ?? 0) <= 1,
      );
    }
    traces.push(trace);
  }

  // Every trace after the first needs a label, since nothing can fall into it.
  const labels = new Map<BlockId, string>();
  traces.forEach((trace, index) => {
    const head = trace[0]!;
    if (index === 0 && routine.entryLabel) labels.set(head, routine.entryLabel);
    else if (index > 0) labels.set(head, nextLabel());
  });

  // A start widget cannot be a jump target, and a label cannot be fallen into,
  // so if anything jumps back to the entry block the start widget needs its own
  // chain that jumps to a labelled copy of the entry.
  const entryIsTarget = isMain && (predecessors.get(routine.entry) ?? 0) > 0;
  if (entryIsTarget && !labels.has(routine.entry)) {
    labels.set(routine.entry, nextLabel());
  }

  const layout: RoutineLayout = { routine, labels };
  const chains = traces
    .map((trace, index) =>
      emitTrace(layout, trace, resolve, endsChain, isMain && index === 0 && !entryIsTarget),
    )
    // A trace that reduces to nothing but a label is one nothing jumps to any
    // more, since ending a chain says what jumping to it used to say.
    .filter((chain) => !isLabelOnly(chain));

  if (entryIsTarget) {
    chains.unshift({
      widgets: [widget("start"), jumpTo(labels.get(routine.entry)!)],
      name: "start",
    });
  }
  return chains;
}

/** A block that does nothing but finish the routine. */
function isEndBlock(routine: Routine, id: BlockId): boolean {
  const block = routine.blocks.get(id);
  return block !== undefined && block.ops.length === 0 && block.terminator.kind === "end";
}

/**
 * Rewrite jumps that lead only to the end of the routine.
 *
 * Running off the end of a chain already means "return to the caller", or
 * "restart at the start widget" in the main program — exactly what jumping to
 * an empty terminal block means. So the jump, and the label it needs, are both
 * pure cost.
 */
function simplifyTerminators(
  routine: Routine,
  reachable: Set<BlockId>,
  isMain: boolean,
): void {
  /** Follow empty blocks that only jump onwards. */
  const thread = (id: BlockId): BlockId => {
    const seen = new Set<BlockId>();
    let at = id;
    for (;;) {
      if (seen.has(at)) return at;
      seen.add(at);
      const block = routine.blocks.get(at);
      if (!block || block.ops.length > 0 || block.terminator.kind !== "jump") return at;
      at = block.terminator.to;
    }
  };

  const leadsToEnd = (id: BlockId): boolean => {
    const target = thread(id);
    const block = routine.blocks.get(target);
    return block !== undefined && block.ops.length === 0 && block.terminator.kind === "end";
  };

  // Restarting the main program means starting again at the start widget, which
  // is exactly where an empty run of blocks from the entry leads. So a jump back
  // to that point can simply end the chain — which is what a top-level
  // `while (true)` is. This holds only because `thread` refuses to cross a block
  // that executes anything: otherwise restarting would re-run initialisers.
  //
  // The blocks on that path from the entry are excluded: rewriting one of them
  // would sever the program from its own start widget rather than loop it.
  const prologue = new Set<BlockId>();
  let restartPoint: BlockId | undefined;
  if (isMain) {
    let at = routine.entry;
    for (;;) {
      const block = routine.blocks.get(at);
      // Only the blocks that collapse away belong to the prologue; the first
      // block that actually does something is ordinary code, and a jump back to
      // it is exactly the loop we want to turn into a restart.
      if (!block || block.ops.length > 0 || block.terminator.kind !== "jump") break;
      if (prologue.has(at)) break;
      prologue.add(at);
      at = block.terminator.to;
    }
    restartPoint = thread(routine.entry);
  }

  for (const id of reachable) {
    if (prologue.has(id)) continue;
    const block = routine.blocks.get(id)!;
    if (block.terminator.kind !== "jump") continue;
    const target = thread(block.terminator.to);
    if (target === restartPoint || leadsToEnd(block.terminator.to)) {
      block.terminator = { kind: "end" };
    }
  }
}

function isLabelOnly(chain: Chain): boolean {
  return chain.widgets.length === 1 && chain.widgets[0]?.type === "label";
}

function collectReachable(routine: Routine): Set<BlockId> {
  const seen = new Set<BlockId>();
  const stack = [routine.entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const block = routine.blocks.get(id);
    if (!block) continue;
    seen.add(id);
    stack.push(...successors(block.terminator));
  }
  return seen;
}

/**
 * Collapse chains of empty blocks that only jump onwards. Lowering produces
 * plenty of these — the join block of every `if`, for one — and each would
 * otherwise cost a jump plus a label.
 */
function buildJumpThreading(
  routine: Routine,
  reachable: Set<BlockId>,
): (id: BlockId) => BlockId {
  const target = new Map<BlockId, BlockId>();
  const resolve = (id: BlockId): BlockId => {
    const seen = new Set<BlockId>();
    let at = id;
    for (;;) {
      if (seen.has(at)) return at; // an empty infinite loop; leave it alone
      seen.add(at);
      const block = routine.blocks.get(at);
      if (!block || block.ops.length > 0 || block.terminator.kind !== "jump") return at;
      at = block.terminator.to;
    }
  };
  for (const id of reachable) target.set(id, resolve(id));
  return (id) => target.get(id) ?? resolve(id);
}

function countPredecessors(
  routine: Routine,
  reachable: Set<BlockId>,
  resolve: (id: BlockId) => BlockId,
): Map<BlockId, number> {
  const counts = new Map<BlockId, number>();
  for (const id of reachable) counts.set(resolve(id), 0);
  for (const id of reachable) {
    // A block that threads away emits nothing, so its edges are not real: they
    // belong to whatever jumps into it. Counting them too would make every
    // target look like a merge point and force a label onto it.
    if (resolve(id) !== id) continue;
    const block = routine.blocks.get(id)!;
    for (const s of successors(block.terminator)) {
      const resolved = resolve(s);
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Successors we would like to place directly below this block, best first.
 *
 * A condition offers both of its successors: falling through on false keeps the
 * true branch on the widget's whitelist side, which reads the way the source
 * does, but in a chain of `&&` the true side is the continuation — so if false
 * is unavailable, taking true still saves a jump widget.
 *
 * A side is only offered when its *sibling* can be named, though. Whatever is
 * placed below a condition is where an unnamed side goes, so the sibling has to
 * carry a label — and a side that merely ends the routine has nothing to name.
 * Letting such a condition fall through would run the branch either way.
 */
function fallThroughCandidates(
  terminator: Terminator,
  resolve: (id: BlockId) => BlockId,
  endsChain: (id: BlockId) => boolean,
): BlockId[] {
  switch (terminator.kind) {
    case "jump":
      return [resolve(terminator.to)];
    case "cond": {
      const onTrue = resolve(terminator.ifTrue);
      const onFalse = resolve(terminator.ifFalse);
      const candidates: BlockId[] = [];
      if (!endsChain(onTrue) || onTrue === onFalse) candidates.push(onFalse);
      if (!endsChain(onFalse) || onTrue === onFalse) candidates.push(onTrue);
      return candidates;
    }
    case "call":
    case "foreach":
      return [resolve(terminator.cont)];
    case "end":
    case "suicide":
      return [];
  }
}

function emitTrace(
  layout: RoutineLayout,
  trace: readonly BlockId[],
  resolve: (id: BlockId) => BlockId,
  endsChain: (id: BlockId) => boolean,
  isMainEntry: boolean,
): Chain {
  const widgets: WidgetNode[] = [];
  const headLabel = layout.labels.get(trace[0]!);

  if (isMainEntry) widgets.push(widget("start"));
  else if (headLabel) widgets.push(widget("label", {}, { params: [[text(headLabel)]] }));

  trace.forEach((id, index) => {
    const block = layout.routine.blocks.get(id)!;
    for (const op of block.ops) widgets.push(op.node);

    const next = index + 1 < trace.length ? trace[index + 1]! : undefined;
    widgets.push(...emitTerminator(layout, block.terminator, next, resolve, endsChain));
  });

  return { widgets, name: headLabel ?? layout.routine.name };
}

function emitTerminator(
  layout: RoutineLayout,
  terminator: Terminator,
  next: BlockId | undefined,
  resolve: (id: BlockId) => BlockId,
  endsChain: (id: BlockId) => boolean,
): WidgetNode[] {
  switch (terminator.kind) {
    case "end":
      // Running off the end of a chain returns from a subroutine, or restarts
      // the program at the start widget.
      return [];
    case "suicide":
      return [widget("suicide")];
    case "jump": {
      const to = resolve(terminator.to);
      if (to === next) return [];
      return [jumpTo(labelFor(layout, to))];
    }
    case "call": {
      const cont = resolve(terminator.cont);
      const call = widget("jump_sub", {}, { params: [[text(terminator.target)]] });
      if (cont === next) return [call];
      return [call, jumpTo(labelFor(layout, cont))];
    }
    case "foreach": {
      const cont = resolve(terminator.cont);
      if (cont === next) return [terminator.node];
      return [terminator.node, jumpTo(labelFor(layout, cont))];
    }
    case "cond": {
      const onTrue = resolve(terminator.ifTrue);
      const onFalse = resolve(terminator.ifFalse);

      // Outcomes that go to the same place, or that both just end the routine,
      // make the branch decide nothing. Dropping the widget is what the source
      // meant and costs nothing to run; keeping it would leave a condition the
      // game marks as having no flow control.
      if (endsChain(onTrue) && endsChain(onFalse)) return [];
      if (onTrue === onFalse) {
        return onTrue === next ? [] : [jumpTo(labelFor(layout, onTrue))];
      }

      const spec = getWidget(terminator.node.type);
      const branchRow = spec.params.length - 1;

      const params = (terminator.node.params ?? []).map((row) => (row ? [...row] : []));
      const blacklist = (terminator.node.blacklist ?? []).map((row) => (row ? [...row] : []));
      while (params.length <= branchRow) params.push([]);
      while (blacklist.length <= branchRow) blacklist.push([]);

      // Each side that is not the fall-through gets its target written into the
      // widget itself — one text widget, versus two for a jump.
      //
      // An empty side does NOT mean "stop here": ProgWidgetJump.jumpToLabel
      // falls back to the widget *below* the condition when a side names no
      // label, so an empty side runs whatever sits underneath. That is only the
      // right thing when the side ends the routine and nothing is below — which
      // trace formation guarantees, by refusing to place anything below a
      // condition whose other side merely ends (see fallThroughCandidates).
      const targetFor = (target: BlockId): string | undefined =>
        target === next || endsChain(target) ? undefined : labelFor(layout, target);

      const onTrueTarget = targetFor(onTrue);
      const onFalseTarget = targetFor(onFalse);
      if (onTrueTarget !== undefined) params[branchRow] = [text(onTrueTarget)];
      if (onFalseTarget !== undefined) blacklist[branchRow] = [text(onFalseTarget)];

      return [{ ...terminator.node, params, blacklist }];
    }
  }
}

function jumpTo(label: string): WidgetNode {
  return widget("jump", {}, { params: [[text(label)]] });
}

function labelFor(layout: RoutineLayout, id: BlockId): string {
  const label = layout.labels.get(id);
  if (!label) {
    throw new Error(`block ${id} is a jump target but was not given a label`);
  }
  return label;
}
