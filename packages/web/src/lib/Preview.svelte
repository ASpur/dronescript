<script lang="ts">
  import {
    chainComponents,
    chainKeys,
    getWidget,
    relink,
    verify,
    widgetHeight,
    widgetWidth,
  } from "@dronescript/compiler";
  import type { IntentNode, PlacedWidget } from "@dronescript/compiler";
  import { textureFor, textureUnits } from "./textures.js";

  interface Props {
    placed: readonly PlacedWidget[];
    intent: readonly IntentNode[];
    hasOffsets: boolean;
    onMoveChain: (key: string, dx: number, dy: number) => void;
    onResetLayout: () => void;
  }

  let { placed, intent, hasOffsets, onMoveChain, onResetLayout }: Props = $props();

  /** Pixels per program unit. A widget is 15 units wide and 11 units per row. */
  const SCALE = 4;
  const PADDING = 24;

  let zoom = $state(1);
  let tx = $state(PADDING);
  let ty = $state(PADDING);
  let showLabels = $state(true);
  let hovered: number | undefined = $state();
  let container: HTMLDivElement | undefined = $state();

  let panning = $state(false);
  /** A live chain drag: the component, its key, and the snapped delta so far. */
  let drag:
    | {
        component: number;
        key: string;
        startX: number;
        startY: number;
        dx: number;
        dy: number;
        valid: boolean;
      }
    | undefined = $state();
  /**
   * A drop whose recompile is still in flight. The shift stays painted until
   * the moved layout arrives, so the chain never flashes back to its old spot.
   * The anchor is the chain head's pre-move position: while it still matches,
   * `placed` is the old layout and the shift applies; once it stops matching,
   * the new layout is in and the shift must not (that would double it).
   */
  let settled:
    | { key: string; dx: number; dy: number; anchorX: number; anchorY: number }
    | undefined = $state();

  // The links the game will actually make, derived the same way it derives them.
  const linked = $derived(placed.length > 0 ? relink(placed) : undefined);

  // Chains — connected components — are the draggable unit: internal links are
  // adjacency (translation-proof) and chains reference each other only by
  // label name, so moving one cannot change what the program means.
  const components = $derived(placed.length > 0 ? chainComponents(placed) : []);
  const keys = $derived(chainKeys(placed, components));
  const componentOf = $derived.by(() => {
    const map = new Map<number, number>();
    components.forEach((members, c) => {
      for (const i of members) map.set(i, c);
    });
    return map;
  });

  // What "no new problems" means for a drop: the issue count the layout came
  // with. tolerateIssues means this is not guaranteed to be zero.
  const baselineIssues = $derived(
    placed.length > 0 && intent.length === placed.length
      ? verify(placed, intent).issues.length
      : 0,
  );

  const bounds = $derived.by(() => {
    if (placed.length === 0) return { minX: 0, minY: 0, width: 100, height: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of placed) {
      const spec = getWidget(w.type);
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      // +5 units covers the parameter tab baked into the art's right edge.
      maxX = Math.max(maxX, w.x + widgetWidth(spec) + 5);
      maxY = Math.max(maxY, w.y + widgetHeight(spec) + 5);
    }
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  });

  interface Box {
    readonly index: number;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly texture: string | undefined;
    readonly textureSize: number;
    readonly label: string;
    readonly detail: string;
    readonly category: string;
  }

  const boxes = $derived.by((): Box[] =>
    placed.map((widget, index) => {
      const spec = getWidget(widget.type);
      return {
        index,
        x: widget.x * SCALE,
        y: widget.y * SCALE,
        w: widgetWidth(spec) * SCALE,
        h: widgetHeight(spec) * SCALE,
        texture: textureFor(widget),
        textureSize: textureUnits(spec) * SCALE,
        label: widget.type,
        detail: detailOf(widget),
        category: spec.category,
      };
    }),
  );

  const anyFallback = $derived(boxes.some((b) => !b.texture));

  /** Arrows from each jump or branch to the label it targets. */
  const jumps = $derived.by(() => {
    if (!linked) return [];
    const labels = new Map<string, number>();
    placed.forEach((w, i) => {
      if (w.type !== "label") return;
      const slot = linked.widgets[i]?.parameters[0];
      if (slot === undefined || slot < 0) return;
      const name = placed[slot]?.fields["string"];
      if (typeof name === "string") labels.set(name, i);
    });

    const arrows: { from: number; to: number; kind: string }[] = [];
    placed.forEach((w, i) => {
      if (w.type !== "text") return;
      const target = w.fields["string"];
      if (typeof target !== "string") return;
      const to = labels.get(target);
      if (to === undefined || to === i) return;
      // Attribute the arrow to whatever this text is attached to.
      const parent = linked.widgets[i]?.parent ?? -1;
      if (parent < 0) return;
      arrows.push({ from: parent, to, kind: placed[parent]!.type });
    });
    return arrows;
  });

  function detailOf(widget: PlacedWidget): string {
    const fields = widget.fields;
    if (typeof fields["string"] === "string") return `"${fields["string"]}"`;
    if (typeof fields["var"] === "string" && fields["var"]) return fields["var"] as string;
    if (Array.isArray(fields["coord"])) return `<${(fields["coord"] as number[]).join(",")}>`;
    if (Array.isArray(fields["pos1"])) return `<${(fields["pos1"] as number[]).join(",")}>`;
    if (typeof fields["var1"] === "string" && fields["var1"]) return fields["var1"] as string;
    const item = fields["chk_item"] as { id?: string } | undefined;
    if (item?.id) return item.id.replace("minecraft:", "");
    return "";
  }

  /** The live drag (or in-flight drop) translation for a component, in px. */
  function dragShift(component: number): { x: number; y: number } {
    if (drag?.component === component) return { x: drag.dx * SCALE, y: drag.dy * SCALE };
    if (settled && keys[component] === settled.key) {
      const head = components[component]?.[0];
      const w = head !== undefined ? placed[head] : undefined;
      if (w && w.x === settled.anchorX && w.y === settled.anchorY) {
        return { x: settled.dx * SCALE, y: settled.dy * SCALE };
      }
    }
    return { x: 0, y: 0 };
  }

  // Once any layout arrives where the anchor no longer matches — the drop's
  // own recompile, an edit, a reset — the carried shift has served its turn.
  $effect(() => {
    if (!settled) return;
    const component = keys.indexOf(settled.key);
    const head = component >= 0 ? components[component]?.[0] : undefined;
    const w = head !== undefined ? placed[head] : undefined;
    if (!w || w.x !== settled.anchorX || w.y !== settled.anchorY) settled = undefined;
  });

  function centreOf(index: number): { x: number; y: number } {
    const box = boxes[index]!;
    const shift = dragShift(componentOf.get(index) ?? -1);
    return { x: box.x + box.w / 2 + shift.x, y: box.y + box.h / 2 + shift.y };
  }

  /** Would the moved chain still verify clean? Runs per snapped grid cell. */
  function dropIsValid(component: number, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return true;
    if (intent.length !== placed.length) return true;
    const members = new Set(components[component]);
    const tentative = placed.map((w, i) =>
      members.has(i) ? { ...w, x: w.x + dx, y: w.y + dy } : w,
    );
    return verify(tentative, intent).issues.length <= baselineIssues;
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const next = Math.min(4, Math.max(0.3, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    tx = px - (px - tx) * (next / zoom);
    ty = py - (py - ty) * (next / zoom);
    zoom = next;
  }

  function onPointerDown(event: PointerEvent): void {
    const piece = (event.target as Element).closest<SVGElement>("[data-widget]");
    if (event.button === 0 && piece) {
      const index = Number(piece.dataset["widget"]);
      const component = componentOf.get(index);
      if (component === undefined) return;
      drag = {
        component,
        key: keys[component]!,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        valid: true,
      };
    } else if (event.button === 0 || event.button === 1) {
      panning = true;
    } else {
      return;
    }
    // Capture keeps the drag alive outside the pane; losing it is survivable.
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (panning) {
      tx += event.movementX;
      ty += event.movementY;
      return;
    }
    if (!drag) return;
    const dx = Math.round((event.clientX - drag.startX) / (SCALE * zoom));
    const dy = Math.round((event.clientY - drag.startY) / (SCALE * zoom));
    if (dx === drag.dx && dy === drag.dy) return;
    drag = { ...drag, dx, dy, valid: dropIsValid(drag.component, dx, dy) };
  }

  function onPointerUp(): void {
    panning = false;
    if (!drag) return;
    const { component, key, dx, dy, valid } = drag;
    drag = undefined;
    // An invalid spot would forge or break connections — spring back instead.
    if (valid && (dx !== 0 || dy !== 0)) {
      const head = placed[components[component]?.[0] ?? -1];
      if (head) settled = { key, dx, dy, anchorX: head.x, anchorY: head.y };
      onMoveChain(key, dx, dy);
    }
  }

  function resetView(): void {
    zoom = 1;
    tx = PADDING - bounds.minX * SCALE;
    ty = PADDING - bounds.minY * SCALE;
  }

  // Frame the program once it first exists; after that the view is the user's.
  let framed = false;
  $effect(() => {
    if (placed.length === 0) {
      framed = false;
    } else if (!framed) {
      framed = true;
      resetView();
    }
  });
</script>

<div class="preview">
  <div class="controls">
    <span class="hint">drag a piece to move its chain · drag the background to pan · scroll to zoom</span>
    <label class="labels-toggle">
      <input type="checkbox" bind:checked={showLabels} />
      labels
    </label>
    <button onclick={onResetLayout} disabled={!hasOffsets}>Reset layout</button>
    <button onclick={resetView}>Reset view</button>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="canvas"
    class:panning
    bind:this={container}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    {#if placed.length === 0}
      <p class="empty">Nothing to show yet.</p>
    {:else}
      <svg width="100%" height="100%">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-muted)" />
          </marker>
        </defs>

        <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
          {#each jumps as jump (jump.from + ":" + jump.to)}
            {@const from = centreOf(jump.from)}
            {@const to = centreOf(jump.to)}
            <path
              d={`M ${from.x} ${from.y} C ${from.x + 60} ${from.y}, ${to.x + 60} ${to.y}, ${to.x} ${to.y}`}
              class="jump"
              marker-end="url(#arrow)"
            />
          {/each}

          {#each components as members, component (keys[component])}
            {@const shift = dragShift(component)}
            {@const invalid = drag?.component === component && !drag.valid}
            <g transform={`translate(${shift.x} ${shift.y})`} class:lifted={drag?.component === component}>
              {#each members as index (index)}
                {@const box = boxes[index]!}
                <g
                  data-widget={index}
                  role="listitem"
                  onpointerenter={() => (hovered = index)}
                  onpointerleave={() => (hovered = undefined)}
                >
                  {#if box.texture}
                    <!-- The art is anchored top-left in a transparent square,
                         so the whole file draws at the widget origin. -->
                    <image
                      href={box.texture}
                      x={box.x}
                      y={box.y}
                      width={box.textureSize}
                      height={box.textureSize}
                      preserveAspectRatio="xMinYMin"
                      class="piece"
                    />
                  {:else}
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.w - 2}
                      height={box.h - 2}
                      class="widget {box.category}"
                    />
                    <path
                      class="lit"
                      d={`M ${box.x + 1} ${box.y + box.h - 3} L ${box.x + 1} ${box.y + 1} L ${box.x + box.w - 3} ${box.y + 1}`}
                    />
                    <path
                      class="shade"
                      d={`M ${box.x + box.w - 3} ${box.y + 1} L ${box.x + box.w - 3} ${box.y + box.h - 3} L ${box.x + 1} ${box.y + box.h - 3}`}
                    />
                    <text x={box.x + 5} y={box.y + 12} class="name">{box.label}</text>
                  {/if}
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.w}
                    height={box.h}
                    class="hit"
                    class:hovered={hovered === index && !drag}
                    class:invalid
                  />
                </g>
              {/each}

              <!-- The mod draws info as black text on a translucent white
                   plate, centred on the piece; same idea here. -->
              {#if showLabels}
                {#each members as index (index)}
                  {@const box = boxes[index]!}
                  {#if box.detail && box.texture}
                    {@const width = box.detail.length * 4.4 + 8}
                    <g class="plate" transform={`translate(${box.x + box.w / 2} ${box.y + box.h / 2})`}>
                      <rect x={-width / 2} y={-6} {width} height={12} />
                      <text y={3}>{box.detail}</text>
                    </g>
                  {/if}
                {/each}
              {/if}
            </g>
          {/each}
        </g>
      </svg>
    {/if}
  </div>

  {#if anyFallback}
    <div class="legend">
      {#each ["flow", "action", "condition", "parameter"] as category}
        <span class="key"><i class={category}></i>{category}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-sunken);
  }

  .controls button {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
  }

  .hint {
    flex: 1;
    color: var(--fg-muted);
    font-size: 11px;
  }

  .labels-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-muted);
    font-size: 11px;
    user-select: none;
  }

  /* The dotted grid the program floats on, matching the planner's node canvas. */
  .canvas {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    background-color: var(--canvas);
    background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size: 20px 20px;
  }

  .canvas.panning {
    cursor: grabbing;
  }

  .canvas :global([data-widget]) {
    cursor: move;
  }

  .canvas svg {
    display: block;
  }

  .empty {
    color: var(--fg-muted);
    padding: 24px;
    font-size: 12px;
  }

  /* The game's textures are pixel art; let them stay that way at any zoom. */
  .piece {
    image-rendering: pixelated;
  }

  .lifted {
    opacity: 0.9;
  }

  .hit {
    fill: transparent;
    stroke: none;
  }

  .hit.hovered {
    stroke: var(--glow);
    stroke-width: 2;
  }

  /* The mod outlines a problem widget in red; an invalid drop reads the same. */
  .hit.invalid {
    stroke: var(--bad);
    stroke-width: 2;
    fill: rgb(255 0 0 / 0.15);
  }

  .plate {
    pointer-events: none;
  }

  .plate rect {
    fill: rgb(255 255 255 / 0.75);
    stroke: rgb(192 192 192);
    stroke-width: 1;
  }

  .plate text {
    font-size: 8px;
    fill: #000;
    text-anchor: middle;
  }

  .widget {
    stroke: var(--mc-15);
    stroke-width: 2;
  }

  .lit,
  .shade {
    fill: none;
    stroke-width: 2;
    pointer-events: none;
  }

  .lit {
    stroke: rgb(255 255 255 / 0.3);
  }

  .shade {
    stroke: rgb(0 0 0 / 0.28);
  }

  .widget.flow {
    fill: var(--flow);
  }
  .widget.action {
    fill: var(--action);
  }
  .widget.condition {
    fill: var(--condition);
  }
  .widget.parameter {
    fill: var(--parameter);
  }
  .widget.meta {
    fill: var(--meta);
  }

  .name {
    font-size: 9px;
    fill: var(--mc-15);
    font-weight: 700;
    pointer-events: none;
  }

  .jump {
    fill: none;
    stroke: var(--fg-muted);
    stroke-width: 1;
    stroke-dasharray: 4 3;
    opacity: 0.7;
  }

  .legend {
    display: flex;
    gap: 12px;
    padding: 5px 8px;
    border-top: 1px solid var(--line);
    background: var(--surface-sunken);
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  /* Square swatches with the same hard border the widgets get. */
  .key i {
    width: 9px;
    height: 9px;
    border: 1px solid var(--mc-15);
    display: inline-block;
  }

  .key i.flow {
    background: var(--flow);
  }
  .key i.action {
    background: var(--action);
  }
  .key i.condition {
    background: var(--condition);
  }
  .key i.parameter {
    background: var(--parameter);
  }
</style>
