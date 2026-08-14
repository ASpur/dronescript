/**
 * Control-flow graph IR.
 *
 * Blocks hold widget operations and end in a terminator. Conditional
 * terminators name BOTH successors, because a condition widget can encode both
 * a true target and a false target — richer than a typical single-target
 * branch, and the main lever the optimizer has for avoiding jump widgets.
 */

import type { WidgetNode } from "../emit/model.js";

export type BlockId = number;

/** A widget executed for its effect, with its parameter chains already built. */
export interface Op {
  readonly node: WidgetNode;
}

export type Terminator =
  | { readonly kind: "jump"; readonly to: BlockId }
  /**
   * A condition widget. `ifTrue`/`ifFalse` are both real successors; layout
   * decides which (if either) becomes fall-through and which becomes a label
   * written into the widget's text parameter.
   */
  | {
      readonly kind: "cond";
      readonly node: WidgetNode;
      readonly ifTrue: BlockId;
      readonly ifFalse: BlockId;
    }
  /** Call a subroutine, then continue at `cont` (the widget below jump_sub). */
  | { readonly kind: "call"; readonly target: string; readonly cont: BlockId }
  /**
   * A native iteration widget (`for_each_coordinate` / `for_each_item`). The
   * body runs as its own chain and returns here via the jump-back stack.
   */
  | {
      readonly kind: "foreach";
      readonly node: WidgetNode;
      readonly body: string;
      readonly cont: BlockId;
    }
  /**
   * End of chain. Inside a subroutine this returns to the caller; at top level
   * the drone restarts at the start widget.
   */
  | { readonly kind: "end" }
  /** The suicide widget: nothing follows, and the drone is gone. */
  | { readonly kind: "suicide" };

export interface Block {
  readonly id: BlockId;
  readonly ops: Op[];
  terminator: Terminator;
  /** Label name if this block must be reachable by jump; assigned by layout. */
  label?: string;
}

/** A unit of code with its own entry label: the main program, or a function. */
export interface Routine {
  readonly name: string;
  /** Label the routine is entered by; undefined for the main program. */
  readonly entryLabel?: string;
  readonly entry: BlockId;
  readonly blocks: Map<BlockId, Block>;
}

export interface IrProgram {
  readonly main: Routine;
  readonly routines: Routine[];
}

export class BlockBuilder {
  private nextId = 0;
  readonly blocks = new Map<BlockId, Block>();

  create(): Block {
    const block: Block = { id: this.nextId++, ops: [], terminator: { kind: "end" } };
    this.blocks.set(block.id, block);
    return block;
  }

  get(id: BlockId): Block {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`no such block: ${id}`);
    return block;
  }
}

/** Successor block ids of a terminator, in a stable order. */
export function successors(terminator: Terminator): BlockId[] {
  switch (terminator.kind) {
    case "jump":
      return [terminator.to];
    case "cond":
      return [terminator.ifTrue, terminator.ifFalse];
    case "call":
      return [terminator.cont];
    case "foreach":
      return [terminator.cont];
    case "end":
    case "suicide":
      return [];
  }
}
