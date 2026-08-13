<!--
  The reference sheet, fullscreen. A native dialog: the top layer beats Monaco's
  hover and suggest widgets without a z-index contest, Escape closes for free,
  and focus stays trapped. The parent unmounts this component on close.
-->
<script lang="ts">
  import Reference from "./Reference.svelte";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    dialog?.showModal();
  });
</script>

<dialog
  bind:this={dialog}
  class="bevel"
  oncancel={(event) => {
    // Escape. Route it through the parent's state so that is the one authority
    // on whether the modal exists; unmounting closes the dialog natively.
    event.preventDefault();
    onclose();
  }}
  onclick={(event) => {
    // Only a backdrop click targets the dialog itself; the frame fills it.
    if (event.target === dialog) onclose();
  }}
>
  <div class="frame">
    <header>
      <span class="eyebrow">DroneScript reference</span>
      <button onclick={onclose}>Close</button>
    </header>
    <div class="body">
      <Reference />
    </div>
  </div>
</dialog>

<style>
  dialog {
    width: min(960px, 94vw);
    height: min(90vh, 100%);
    padding: 0;
    /* Keep .bevel's frame, but its --mc-78 fill is too light to read on. */
    background: var(--surface);
    color: var(--fg);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  .frame {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: none;
    padding: 6px 8px 6px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  header button {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--background);
  }
</style>
