<!--
  The language reference sheet. Pure content: everything it shows is built in
  reference.ts, mostly from the compiler's own tables. Rendered both inside the
  output pane's Reference tab and inside the fullscreen modal, so it owns no
  scrolling and no ids — the nearest scrollable ancestor does the work.

  The jump bar pins to the top of that ancestor and carries the search box;
  searching hides whatever does not match, jump buttons included.
-->
<script lang="ts">
  import { tick } from "svelte";

  import {
    AREA_SHAPE_DOCS,
    FUNCTION_CATEGORIES,
    KEYWORD_LIST,
    LIMITATIONS,
    PSEUDO_FUNCTIONS,
    SPECIAL_VARIABLE_DOCS,
    SYNTAX_SECTIONS,
  } from "./reference.js";
  import type { FunctionDoc } from "./reference.js";

  const CATEGORIES = FUNCTION_CATEGORIES.filter((c) => c.entries.length > 0);

  let query = $state("");
  let barHeight = $state(0);

  // Every whitespace-separated term must appear somewhere in an entry's text,
  // so "dig order" finds dig by its option and "drone rf" narrows to one entry.
  const terms = $derived(query.toLowerCase().split(/\s+/).filter(Boolean));

  function matches(haystack: string): boolean {
    return terms.every((t) => haystack.includes(t));
  }

  function fnHaystack(doc: FunctionDoc): string {
    return [
      doc.name,
      doc.signature,
      doc.summary,
      ...doc.parameters.flatMap((o) => [o.name, o.type]),
      ...doc.options.flatMap((o) => [o.name, o.type]),
    ]
      .join(" ")
      .toLowerCase();
  }

  const visibleSyntax = $derived(
    SYNTAX_SECTIONS.map((group) => ({
      ...group,
      entries: group.entries.filter((e) =>
        matches(`${group.title} ${e.title} ${e.body} ${e.code ?? ""}`.toLowerCase()),
      ),
    })).filter((group) => group.entries.length > 0),
  );
  const visibleKeywords = $derived(KEYWORD_LIST.filter((k) => matches(k)));
  const visiblePseudo = $derived(PSEUDO_FUNCTIONS.filter((d) => matches(fnHaystack(d))));
  const visibleShapes = $derived(
    AREA_SHAPE_DOCS.filter((s) =>
      matches(
        `area shapes ${s.id} ${s.options.map((o) => `${o.name} ${o.type}`).join(" ")}`.toLowerCase(),
      ),
    ),
  );
  const visibleCategories = $derived(
    CATEGORIES.map((c) => ({
      ...c,
      entries: c.entries.filter((d) => matches(fnHaystack(d))),
    })).filter((c) => c.entries.length > 0),
  );
  const visibleSpecials = $derived(
    SPECIAL_VARIABLE_DOCS.filter((v) => matches(`${v.name} ${v.description}`.toLowerCase())),
  );
  const visibleLimits = $derived(LIMITATIONS.filter((l) => matches(l.toLowerCase())));

  const jumps = $derived([
    ...(visibleSyntax.length > 0 || visibleKeywords.length > 0 ? ["Syntax"] : []),
    ...(visiblePseudo.length > 0 || visibleShapes.length > 0 ? ["Compile-time values"] : []),
    ...visibleCategories.map((c) => c.title),
    ...(visibleSpecials.length > 0 ? ["Special variables"] : []),
    ...(visibleLimits.length > 0 ? ["Limitations"] : []),
  ]);

  const sections: Record<string, HTMLElement | undefined> = {};
  const fnEls: Record<string, HTMLElement | undefined> = {};

  // Clear the pinned bar when jumping; scroll-margin-top on the targets.
  const scrollMargin = $derived(`${barHeight + 4}px`);

  function jump(title: string): void {
    sections[title]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let flashing = $state<string>();

  /** Scroll a function's entry into view, e.g. after a Ctrl+click in the editor. */
  export async function scrollToFunction(name: string): Promise<void> {
    if (!fnEls[name]) {
      // A search filter may be hiding the entry.
      query = "";
      await tick();
    }
    const el = fnEls[name];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    flashing = undefined;
    await tick(); // restart the animation when re-triggered
    flashing = name;
    setTimeout(() => {
      if (flashing === name) flashing = undefined;
    }, 1300);
  }
</script>

{#snippet fn(doc: FunctionDoc)}
  <article
    class="fn"
    class:sensor={doc.sensor}
    class:flash={flashing === doc.name}
    bind:this={fnEls[doc.name]}
    style:scroll-margin-top={scrollMargin}
  >
    <code class="sig">
      <span class="name">{doc.name}</span>{doc.signature.slice(doc.name.length)}
    </code>
    <p class="summary">{doc.summary}</p>
    {#if doc.parameters.length > 0 || doc.options.length > 0}
      <div class="opts">
        {#each [...doc.parameters, ...doc.options] as opt (opt.name)}
          <code>{opt.name}</code>
          <span>{opt.type}</span>
        {/each}
      </div>
    {/if}
  </article>
{/snippet}

<div class="reference">
  <nav class="jumps" bind:clientHeight={barHeight}>
    <input
      type="search"
      placeholder="Search"
      aria-label="Search the reference"
      bind:value={query}
      onkeydown={(event) => {
        // Escape clears an active search; only an idle one closes the modal.
        if (event.key === "Escape" && query !== "") {
          event.preventDefault();
          event.stopPropagation();
          query = "";
        }
      }}
    />
    {#each jumps as title (title)}
      <button onclick={() => jump(title)}>{title}</button>
    {/each}
  </nav>

  {#if jumps.length === 0}
    <p class="none">No matches for “{query}”.</p>
  {/if}

  {#if visibleSyntax.length > 0 || visibleKeywords.length > 0}
    <section bind:this={sections["Syntax"]} style:scroll-margin-top={scrollMargin}>
      {#each visibleSyntax as group (group.title)}
        <h3 class="eyebrow">{group.title}</h3>
        {#each group.entries as entry (entry.title)}
          <article class="entry">
            <h4>{entry.title}</h4>
            <p>{entry.body}</p>
            {#if entry.code}<pre class="code">{entry.code}</pre>{/if}
          </article>
        {/each}
      {/each}
      {#if visibleKeywords.length > 0}
        <article class="entry">
          <h4>Keywords</h4>
          <p class="chips">
            {#each visibleKeywords as keyword (keyword)}
              <code class="chip">{keyword}</code>
            {/each}
          </p>
        </article>
      {/if}
    </section>
  {/if}

  {#if visiblePseudo.length > 0 || visibleShapes.length > 0}
    <section bind:this={sections["Compile-time values"]} style:scroll-margin-top={scrollMargin}>
      <h3 class="eyebrow">Compile-time values</h3>
      <p class="blurb">
        Declared with const and attached as parameter widgets wherever they are used — they never
        exist at runtime.
      </p>
      {#each visiblePseudo as doc (doc.name)}
        {@render fn(doc)}
      {/each}
      {#if visibleShapes.length > 0}
        <article class="entry">
          <h4>Area shapes</h4>
          <div class="opts">
            {#each visibleShapes as shape (shape.id)}
              <code>{shape.id}</code>
              <span>
                {shape.options.length === 0
                  ? "no options"
                  : shape.options
                      .map((o) => `${o.name}: ${o.type}${o.required ? " (required)" : ""}`)
                      .join("; ")}
              </span>
            {/each}
          </div>
        </article>
      {/if}
    </section>
  {/if}

  {#each visibleCategories as category (category.title)}
    <section bind:this={sections[category.title]} style:scroll-margin-top={scrollMargin}>
      <h3 class="eyebrow">{category.title}</h3>
      {#if category.blurb}<p class="blurb">{category.blurb}</p>{/if}
      {#each category.entries as doc (doc.name)}
        {@render fn(doc)}
      {/each}
    </section>
  {/each}

  {#if visibleSpecials.length > 0}
    <section bind:this={sections["Special variables"]} style:scroll-margin-top={scrollMargin}>
      <h3 class="eyebrow">Special variables</h3>
      <p class="blurb">Coordinates the game resolves itself. Read-only.</p>
      <div class="opts">
        {#each visibleSpecials as v (v.name)}
          <code>{v.name}</code>
          <span>{v.description}{v.legacy ? " (legacy)" : ""}</span>
        {/each}
      </div>
    </section>
  {/if}

  {#if visibleLimits.length > 0}
    <section bind:this={sections["Limitations"]} style:scroll-margin-top={scrollMargin}>
      <h3 class="eyebrow">Limitations</h3>
      <ul class="limits">
        {#each visibleLimits as limit (limit)}
          <li>{limit}</li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .reference {
    padding: 0 16px 24px;
    font-size: 12px;
    color: var(--fg-subtle);
  }

  /* The pinned bar spans the pane; the prose column stays a readable width. */
  section,
  .none {
    max-width: 720px;
  }

  /* Pinned to the top of whichever container scrolls the sheet. The negative
     margin bleeds the background across the sheet's padding, so no sliver of
     the content scrolling underneath shows in the gutters. */
  .jumps {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0 -16px;
    padding: 10px 16px 8px;
    background: var(--background);
    border-bottom: 1px solid var(--line);
  }

  .jumps input {
    font: inherit;
    font-size: 12px;
    height: 22px;
    width: 130px;
    padding: 0 6px;
    color: var(--fg);
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: 4px;
  }

  .jumps input:focus-visible {
    outline: 2px solid var(--info);
    outline-offset: 1px;
  }

  .jumps button {
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

  .jumps button:hover {
    color: var(--fg);
    background: var(--surface-raised);
    border-color: var(--line-strong);
  }

  .none {
    padding-top: 16px;
    color: var(--fg-muted);
  }

  section {
    padding-top: 18px;
  }

  h3 {
    margin: 0 0 8px;
  }

  h4 {
    margin: 12px 0 4px;
    font-size: 12px;
    color: var(--fg);
  }

  p {
    margin: 0 0 6px;
    line-height: 1.55;
  }

  .blurb {
    color: var(--fg-muted);
  }

  .code {
    margin: 6px 0 10px;
    padding: 8px 10px;
    font-family: var(--font-ui);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-subtle);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    overflow-x: auto;
    white-space: pre;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .chip {
    padding: 1px 6px;
    background: var(--surface-raised);
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--fg-subtle);
  }

  .fn {
    margin: 0 0 14px;
  }

  .fn.flash {
    animation: flash 1.2s ease-out;
  }

  @keyframes flash {
    0% {
      background: color-mix(in srgb, var(--glow) 22%, transparent);
    }
    100% {
      background: transparent;
    }
  }

  .sig {
    display: block;
    color: var(--fg);
  }

  /* The category tints from the puzzle preview: actions are amber, sensors blue. */
  .name {
    color: var(--action);
    font-weight: 700;
  }

  .sensor .name {
    color: var(--condition);
  }

  .summary {
    margin: 2px 0 4px;
    color: var(--fg-muted);
  }

  .opts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 2px 12px;
    margin: 4px 0 0;
  }

  .opts code {
    color: var(--fg-subtle);
  }

  .opts span {
    color: var(--fg-muted);
    overflow-wrap: break-word;
  }

  .limits {
    margin: 0;
    padding-left: 16px;
    line-height: 1.55;
  }

  .limits li {
    margin-bottom: 6px;
    color: var(--fg-muted);
  }
</style>
