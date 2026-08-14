<script lang="ts">
  import { tick } from "svelte";

  import { DEFAULT_TARGET, TARGETS } from "@dronescript/compiler";
  import type { CompileResult, Target } from "@dronescript/compiler";

  import Editor from "./lib/Editor.svelte";
  import Preview from "./lib/Preview.svelte";
  import Reference from "./lib/Reference.svelte";
  import ReferenceModal from "./lib/ReferenceModal.svelte";
  import { setReferenceOpener } from "./lib/language.js";
  import CompileWorker from "./lib/compile.worker.ts?worker";
  import type { CompileRequest, CompileResponse } from "./lib/compile.worker.js";
  import { EXAMPLES } from "./lib/examples.js";

  // ?? not ||: an emptied editor should stay empty across a refresh.
  const INITIAL_SOURCE = localStorage.getItem("ds.source") ?? EXAMPLES[0]!.source;

  // ------------------------------------------------------------------
  // Undo history: snapshots taken at typing pauses, replayed into Monaco's
  // undo stack on the next visit so Ctrl+Z reaches back across refreshes.
  // Bounded from the front so storage stays far under quota.
  // ------------------------------------------------------------------
  const HISTORY_MAX_STEPS = 100;
  const HISTORY_MAX_CHARS = 400_000;

  function storedHistory(): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("ds.history") ?? "[]");
      if (Array.isArray(parsed) && parsed.every((step) => typeof step === "string")) {
        // The stack must end at what the editor will show, or the first
        // undo after a refresh would jump to some unrelated older text.
        if (parsed.at(-1) !== INITIAL_SOURCE) parsed.push(INITIAL_SOURCE);
        return parsed;
      }
    } catch {
      // Corrupt storage reads as no history.
    }
    return [INITIAL_SOURCE];
  }

  const INITIAL_HISTORY = storedHistory();
  const history = [...INITIAL_HISTORY];

  function recordSnapshot(snapshot: string): void {
    if (history.at(-1) === snapshot) return;
    history.push(snapshot);
    while (
      history.length > HISTORY_MAX_STEPS ||
      (history.length > 1 && history.reduce((n, step) => n + step.length, 0) > HISTORY_MAX_CHARS)
    ) {
      history.shift();
    }
    try {
      localStorage.setItem("ds.history", JSON.stringify(history));
    } catch {
      // Out of quota: losing history beats breaking typing.
    }
  }

  function storedTarget(): Target {
    const stored = localStorage.getItem("ds.target");
    return TARGETS.some((t) => t.id === stored) ? (stored as Target) : DEFAULT_TARGET;
  }

  let source = $state(INITIAL_SOURCE);
  let result: CompileResult | undefined = $state();
  let tab: "preview" | "json" | "reference" = $state("preview");
  let referenceExpanded = $state(false);
  let reference: Reference | undefined = $state();

  // Ctrl+click on a function name in the editor lands on its reference entry.
  setReferenceOpener(async (name) => {
    tab = "reference";
    await tick();
    reference?.scrollToFunction(name);
  });
  let copied = $state(false);
  let editor: Editor | undefined = $state();
  let target: Target = $state(storedTarget());
  // Programmable Controller mode: same program, stricter set of pieces.
  let controller = $state(localStorage.getItem("ds.controller") === "1");

  // ------------------------------------------------------------------
  // Side panel: resizable via the splitter, collapsible to a rail, both
  // remembered across visits. Under 900px the stacked layout takes over.
  // ------------------------------------------------------------------
  const PANEL_MIN = 320;
  const EDITOR_MIN = 360;
  const SPLITTER = 6;
  const RAIL = 30;

  function storedPanelWidth(): number {
    const stored = Number(localStorage.getItem("ds.panel.width"));
    return Number.isFinite(stored) && stored >= PANEL_MIN
      ? stored
      : Math.round(window.innerWidth / 2);
  }

  let panelWidth = $state(storedPanelWidth());
  let collapsed = $state(localStorage.getItem("ds.panel.collapsed") === "1");
  let splitting = $state(false);
  let mainEl: HTMLElement | undefined = $state();

  const narrowQuery = window.matchMedia("(max-width: 900px)");
  let narrow = $state(narrowQuery.matches);
  narrowQuery.addEventListener("change", (e) => (narrow = e.matches));

  function clampPanel(width: number): number {
    const room = (mainEl?.clientWidth ?? window.innerWidth) - EDITOR_MIN - SPLITTER;
    return Math.round(Math.min(Math.max(width, PANEL_MIN), Math.max(PANEL_MIN, room)));
  }

  // Inline style beats the stylesheet, so it is only set in the wide layout;
  // when narrow, the 900px media query's stacked rows stay in charge.
  const mainStyle = $derived(
    narrow
      ? collapsed
        ? "grid-template-rows: minmax(0, 1fr) auto;"
        : ""
      : `grid-template-columns: minmax(0, 1fr) ${
          collapsed ? `0px ${RAIL}px` : `${SPLITTER}px ${clampPanel(panelWidth)}px`
        };`,
  );

  function startSplit(event: PointerEvent): void {
    if (event.button !== 0) return;
    splitting = true;
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events have no active pointer to capture.
    }
  }

  function moveSplit(event: PointerEvent): void {
    if (!splitting || !mainEl) return;
    panelWidth = clampPanel(mainEl.getBoundingClientRect().right - event.clientX - SPLITTER / 2);
  }

  function endSplit(): void {
    if (!splitting) return;
    splitting = false;
    localStorage.setItem("ds.panel.width", String(panelWidth));
  }

  function resetSplit(): void {
    panelWidth = clampPanel(Math.round((mainEl?.clientWidth ?? window.innerWidth) / 2));
    localStorage.setItem("ds.panel.width", String(panelWidth));
  }

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    localStorage.setItem("ds.panel.collapsed", collapsed ? "1" : "0");
  }

  // ------------------------------------------------------------------
  // Chain offsets: the user's drags, keyed by chain signature. Session-only
  // on purpose — persisted offsets could silently reshape a future program
  // that happens to produce a chain with the same signature.
  // ------------------------------------------------------------------
  let chainOffsets: Record<string, { dx: number; dy: number }> = $state({});
  const hasOffsets = $derived(Object.keys(chainOffsets).length > 0);

  function moveChain(key: string, dx: number, dy: number): void {
    const prior = chainOffsets[key];
    chainOffsets[key] = { dx: (prior?.dx ?? 0) + dx, dy: (prior?.dy ?? 0) + dy };
    requestCompile(source);
  }

  function resetLayout(): void {
    chainOffsets = {};
    requestCompile(source);
  }

  const worker = new CompileWorker();
  let pending = 0;
  let latest = 0;

  worker.onmessage = (event: MessageEvent<CompileResponse>) => {
    // Out-of-order replies would flicker stale results back into view.
    if (event.data.id < latest) return;
    latest = event.data.id;
    result = event.data.result;
    // Drop offsets for chains that no longer exist, so a stale drag cannot
    // grab an unrelated chain that later reuses the signature. Only the reply
    // to the newest request may prune — an older reply predates offsets that
    // were added while it was in flight.
    if (event.data.applied && event.data.id === pending && hasOffsets) {
      const keep = new Set(event.data.applied);
      for (const key of Object.keys(chainOffsets)) {
        if (!keep.has(key)) delete chainOffsets[key];
      }
    }
  };

  function requestCompile(next: string): void {
    const message: CompileRequest = {
      id: ++pending,
      source: next,
      target,
      controller,
      // Snapshot: a $state proxy cannot survive structured clone.
      offsets: hasOffsets ? $state.snapshot(chainOffsets) : undefined,
    };
    worker.postMessage(message);
  }

  function changeTarget(event: Event): void {
    target = (event.currentTarget as HTMLSelectElement).value as Target;
    localStorage.setItem("ds.target", target);
    // The two versions serialize differently, so recompile rather than reuse.
    requestCompile(source);
  }

  function changeController(event: Event): void {
    controller = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem("ds.controller", controller ? "1" : "0");
    requestCompile(source);
  }

  // Compile as the program is typed, on a short debounce. The save is not
  // debounced with it — a refresh inside the debounce window must not lose
  // the last keystrokes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Snapshots wait for a longer pause than compiles do, so one undo step
  // covers a burst of typing rather than every few keystrokes.
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  function onchange(next: string): void {
    source = next;
    localStorage.setItem("ds.source", next);
    clearTimeout(timer);
    timer = setTimeout(() => requestCompile(next), 150);
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => recordSnapshot(next), 500);
  }

  // Compile once at startup; every later compile comes from onchange.
  requestCompile(INITIAL_SOURCE);

  const errors = $derived((result?.diagnostics ?? []).filter((d) => d.severity === "error"));
  const warnings = $derived((result?.diagnostics ?? []).filter((d) => d.severity === "warning"));
  const issues = $derived(result?.issues ?? []);
  const canExport = $derived(errors.length === 0 && issues.length === 0 && !!result?.text);
  const targetNote = $derived(TARGETS.find((t) => t.id === target)?.note ?? "");

  async function copyJson(): Promise<void> {
    if (!result?.text) return;
    await navigator.clipboard.writeText(result.text);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

  function downloadSource(): void {
    const url = URL.createObjectURL(new Blob([source], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "program.drn";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function loadExample(event: Event): void {
    const name = (event.currentTarget as HTMLSelectElement).value;
    const example = EXAMPLES.find((e) => e.name === name);
    if (!example) return;
    editor?.setValue(example.source);
  }
</script>

<div class="app">
  <header>
    <h1 class="title">
      DroneScript
      <span class="sub">a compiler for PneumaticCraft: Repressurized drones</span>
    </h1>
    <div class="actions">
      <select onchange={changeTarget} aria-label="Mod version" title={targetNote}>
        {#each TARGETS as option (option.id)}
          <option value={option.id} selected={option.id === target}>
            MC {option.minecraft}
          </option>
        {/each}
      </select>
      <label
        class="toggle"
        class:on={controller}
        title="Compile for a Programmable Controller: it refuses a program containing any of seven pieces, and a few others mean something else in a block."
      >
        <input type="checkbox" checked={controller} onchange={changeController} />
        Controller
      </label>
      <select onchange={loadExample} aria-label="Load an example">
        <option value="">Examples…</option>
        {#each EXAMPLES as example (example.name)}
          <option value={example.name}>{example.name}</option>
        {/each}
      </select>
      <button onclick={downloadSource} title="Save the source as a .drn file">
        Download .drn
      </button>
      <button class="primary" onclick={copyJson} disabled={!canExport}>
        {copied ? "Copied" : "Copy program JSON"}
      </button>
    </div>
  </header>

  <main bind:this={mainEl} style={mainStyle} class:splitting>
    <section class="pane editor-pane">
      <div class="pane-head">
        <span class="eyebrow">Source</span>
      </div>
      <Editor
        bind:this={editor}
        bind:value={source}
        history={INITIAL_HISTORY}
        diagnostics={result?.diagnostics ?? []}
        {onchange}
      />
    </section>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="splitter"
      class:hidden={collapsed}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the output panel"
      onpointerdown={startSplit}
      onpointermove={moveSplit}
      onpointerup={endSplit}
      onpointercancel={endSplit}
      ondblclick={resetSplit}
    ></div>

    <section class="pane output-pane" class:collapsed>
      {#if collapsed}
        <button
          class="rail"
          onclick={toggleCollapsed}
          title="Expand the output panel"
          aria-label="Expand the output panel"
        >
          {narrow ? "▴" : "◂"}
        </button>
      {:else}
        <nav class="pane-head tabs">
          <button class:active={tab === "preview"} onclick={() => (tab = "preview")}>
            Puzzle layout
          </button>
          <button class:active={tab === "json"} onclick={() => (tab = "json")}>JSON</button>
          <button class:active={tab === "reference"} onclick={() => (tab = "reference")}>
            Reference
          </button>
          <span class="spacer"></span>
          {#if tab === "reference"}
            <button class="expand" onclick={() => (referenceExpanded = true)}>Expand</button>
          {:else if result?.pieces !== undefined && errors.length === 0}
            <span class="pieces">{result.pieces} pieces</span>
          {/if}
          <button
            class="collapse"
            onclick={toggleCollapsed}
            title="Collapse the output panel"
            aria-label="Collapse the output panel"
          >
            {narrow ? "▾" : "▸"}
          </button>
        </nav>

        <div class="output">
          {#if tab === "preview"}
            <Preview
              placed={result?.placed ?? []}
              intent={result?.intent ?? []}
              {hasOffsets}
              onMoveChain={moveChain}
              onResetLayout={resetLayout}
            />
          {:else if tab === "reference"}
            <Reference bind:this={reference} />
          {:else}
            <pre class="json">{result?.text ? formatJson(result.text) : ""}</pre>
          {/if}
        </div>
      {/if}
    </section>
  </main>

  <footer
    class:bad={errors.length > 0 || issues.length > 0}
    class:warn={errors.length === 0 && issues.length === 0 && warnings.length > 0}
  >
    <span class="status eyebrow">
      {#if errors.length > 0}
        {errors.length} error{errors.length === 1 ? "" : "s"}
      {:else if issues.length > 0}
        Bad output
      {:else if warnings.length > 0}
        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
      {:else}
        OK
      {/if}
    </span>
    {#if errors.length > 0}
      <ul class="messages">
        {#each errors.slice(0, 8) as diagnostic (diagnostic.span.start + diagnostic.code)}
          <li>
            <span class="where">line {diagnostic.span.line}</span>
            {diagnostic.message}
          </li>
        {/each}
      </ul>
    {:else if issues.length > 0}
      <ul class="messages">
        <li class="where">
          The emitted program does not match its intended structure — please report this:
        </li>
        {#each issues.slice(0, 5) as issue (issue.message)}
          <li>{issue.message}</li>
        {/each}
      </ul>
    {:else if warnings.length > 0}
      <!-- The program is exportable; these say what it will do once imported. -->
      <ul class="messages">
        {#each warnings.slice(0, 8) as diagnostic (diagnostic.span.start + diagnostic.code)}
          <li>
            <span class="where">line {diagnostic.span.line}</span>
            {diagnostic.message}
          </li>
        {/each}
      </ul>
    {:else}
      <span class="ok">
        Compiled cleanly. Copy the JSON, then in game open the Programmer, click the pastebin
        button, and choose “Load code from clipboard”.
      </span>
    {/if}
  </footer>

  {#if referenceExpanded}
    <ReferenceModal onclose={() => (referenceExpanded = false)} />
  {/if}
</div>

<script module lang="ts">
  function formatJson(text: string): string {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
</script>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    flex-wrap: wrap;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.025em;
  }

  .sub {
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
  }

  /* Monocraft is a wide face, so the controls need somewhere to go on a phone. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* Sits in the same row as the selects, so it carries their height and box.
     Checked, it takes the accent wash — the mode is worth seeing at a glance. */
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    background: var(--surface);
    color: var(--fg-subtle);
    cursor: pointer;
    user-select: none;
  }

  .toggle:hover {
    background: var(--surface-raised);
    color: var(--fg);
  }

  .toggle.on {
    color: var(--info);
    border-color: color-mix(in srgb, var(--info) 45%, transparent);
    background: color-mix(in srgb, var(--info) 12%, var(--surface));
  }

  .toggle input {
    accent-color: var(--info);
    margin: 0;
    cursor: pointer;
  }

  /* The one call to action on the page, tinted the way the accent is used
     elsewhere: a wash of the accent rather than a solid fill. */
  .primary:not(:disabled) {
    color: var(--info);
    border-color: color-mix(in srgb, var(--info) 45%, transparent);
    background: color-mix(in srgb, var(--info) 12%, var(--surface));
  }

  .primary:not(:disabled):hover {
    color: var(--fg);
    background: color-mix(in srgb, var(--info) 22%, var(--surface));
  }

  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 6px minmax(0, 1fr);
  }

  /* A live splitter drag must not select text or fight the iframe-ish panes. */
  main.splitting {
    user-select: none;
    cursor: col-resize;
  }

  .splitter {
    cursor: col-resize;
    background: var(--surface);
    border-left: 1px solid var(--line);
    touch-action: none;
  }

  .splitter:hover,
  main.splitting .splitter {
    background: var(--line-strong);
  }

  .splitter.hidden {
    display: none;
  }

  .output-pane.collapsed {
    overflow: hidden;
  }

  /* The collapsed panel is nothing but this strip. */
  .rail {
    flex: 1;
    border: none;
    border-radius: 0;
    background: var(--surface);
    color: var(--fg-muted);
    font-size: 12px;
  }

  .rail:hover {
    color: var(--fg);
    background: var(--surface-raised);
  }

  .collapse {
    height: 22px;
    padding: 0 6px;
    font-size: 11px;
    color: var(--fg-muted);
    background: transparent;
    border-color: transparent;
  }

  .collapse:hover {
    color: var(--fg);
    border-color: var(--line-strong);
  }

  @media (max-width: 900px) {
    main {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }

    .splitter {
      display: none;
    }

    /* Stacked layout: collapsing leaves just the rail as a bottom strip. */
    .output-pane.collapsed {
      min-height: 30px;
    }

    .rail {
      min-height: 30px;
    }
  }

  .pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--background);
  }

  .output-pane {
    border-left: 1px solid var(--line);
  }

  /* Both panes carry the same 28px strip so their content lines up. */
  .pane-head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 8px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  .tabs button {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    background: transparent;
    border-color: transparent;
  }

  .tabs button.active {
    color: var(--fg);
    background: var(--surface-raised);
    border-color: var(--line-strong);
  }

  .spacer {
    flex: 1;
  }

  .pieces {
    color: var(--fg-muted);
    font-size: 11px;
  }

  .output {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .json {
    margin: 0;
    padding: 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-subtle);
    white-space: pre;
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 10px;
    border-top: 1px solid var(--line);
    background: var(--surface);
    padding: 6px 12px;
    max-height: 160px;
    overflow: auto;
    font-size: 12px;
    color: var(--fg-muted);
  }

  footer.bad {
    border-top-color: var(--bad);
  }

  /* Square status pill, so the state reads before the message does. */
  .status {
    flex: none;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--good) 45%, transparent);
    background: color-mix(in srgb, var(--good) 14%, transparent);
    color: var(--good);
    border-radius: 4px;
  }

  footer.bad .status {
    border-color: color-mix(in srgb, var(--bad) 45%, transparent);
    background: color-mix(in srgb, var(--bad) 14%, transparent);
    color: var(--bad);
  }

  /* Warnings still export, so they get their own colour rather than the
     red that means "this will not load". */
  footer.warn .status {
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
  }

  .messages {
    margin: 0;
    padding-left: 16px;
    color: var(--bad);
  }

  footer.warn .messages {
    color: var(--warn);
  }

  .where {
    color: var(--fg-muted);
    margin-right: 6px;
  }
</style>
