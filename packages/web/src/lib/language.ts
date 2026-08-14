/**
 * Monaco language support for DroneScript.
 *
 * Completions and hover text come from the compiler's own builtin table, so the
 * editor can never advertise a function or option the compiler does not accept.
 */

// The editor core only: none of Monaco's bundled languages are wanted here, and
// importing the default entry point pulls in every one of them.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { BUILTINS, KEYWORDS } from "@dronescript/compiler";
import {
  docMarkdown,
  documentationFor,
  findFunctionDoc,
  PSEUDO_FUNCTIONS,
  signatureLayout,
  signatureOf,
  SPECIAL_VARIABLE_DOCS,
} from "./reference.js";
import type { FunctionDoc, SpecialVariableDoc } from "./reference.js";

export const LANGUAGE_ID = "dronescript";

const SPECIAL_VARIABLES = SPECIAL_VARIABLE_DOCS.filter((d) => !d.legacy && !d.prefix).map(
  (d) => d.name,
);

/** Keyed on the bare sigil name, so `$player_pos=Steve` finds `$player_pos=name`. */
const SPECIALS_BY_NAME = new Map<string, SpecialVariableDoc>(
  SPECIAL_VARIABLE_DOCS.map((d) => [d.prefix ? d.name.split("=")[0]! : d.name, d]),
);

/** Names that have a reference-sheet entry to Ctrl+click through to. */
const LINKABLE = new Set([
  ...BUILTINS.map((b) => b.name),
  ...PSEUDO_FUNCTIONS.map((p) => p.name),
]);

let referenceOpener: ((name: string) => void) | undefined;

/** Wire Ctrl+click on a function name to the reference sheet. */
export function setReferenceOpener(open: (name: string) => void): void {
  referenceOpener = open;
}

export function registerLanguage(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === LANGUAGE_ID)) return;

  monaco.languages.register({ id: LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    keywords: [...KEYWORDS],
    builtins: BUILTINS.map((b) => b.name.split(".").pop()!),
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/[#%$][A-Za-z_]\w*/, "variable.predefined"],
        [/\d+/, "number"],
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@builtins": "type.identifier",
              "@default": "identifier",
            },
          },
        ],
        [/[{}()[\]]/, "@brackets"],
        [/[<>!=]=|&&|\|\||[+\-*/<>=!]/, "operator"],
      ],
      comment: [
        [/[^*/]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    // Sigils belong to the word: without this, hovering `$drone_pos` asks about
    // `drone_pos`, and completing it would leave the `$` behind.
    wordPattern: /[#%$]?[A-Za-z_]\w*/,
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];

      for (const builtin of BUILTINS) {
        suggestions.push({
          label: builtin.name,
          kind: builtin.condition
            ? monaco.languages.CompletionItemKind.Property
            : monaco.languages.CompletionItemKind.Function,
          detail: signatureOf(builtin),
          documentation: { value: documentationFor(builtin) },
          insertText: `${builtin.name.split(".").pop()!}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      for (const keyword of KEYWORDS) {
        suggestions.push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        });
      }

      for (const name of SPECIAL_VARIABLES) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Constant,
          detail: "built-in coordinate, read-only",
          insertText: name,
          range,
        });
      }

      for (const doc of PSEUDO_FUNCTIONS) {
        suggestions.push({
          label: doc.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: doc.signature,
          documentation: { value: docMarkdown(doc) },
          insertText: `${doc.name}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      return { suggestions };
    },
  });

  // Function names become links, so Ctrl+click (the "go to definition" gesture)
  // jumps to the function's entry in the reference sheet.
  monaco.languages.registerLinkProvider(LANGUAGE_ID, {
    provideLinks(model) {
      const links: monaco.languages.ILink[] = [];
      const pattern = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?(?=\s*\()/g;
      model.getLinesContent().forEach((line, i) => {
        for (const match of line.matchAll(pattern)) {
          const name = match[0];
          if (!LINKABLE.has(name)) continue;
          links.push({
            range: new monaco.Range(i + 1, match.index + 1, i + 1, match.index + 1 + name.length),
            url: monaco.Uri.from({ scheme: "dronescript", path: `/reference/${name}` }),
            tooltip: "Show in reference",
          });
        }
      });
      return { links };
    },
  });

  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme !== "dronescript") return false;
      const name = resource.path.split("/").pop();
      if (name) referenceOpener?.(decodeURIComponent(name));
      return true;
    },
  });

  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(model, position) {
      const hover = hoverAt(model, position);
      if (!hover) return null;
      return {
        range: hover.range,
        contents: [
          { value: `\`\`\`dronescript\n${hover.signature}\n\`\`\`` },
          { value: hover.markdown },
        ],
      };
    },
  });

  // The VS Code parameter hint: while the caret sits inside a call's parens, show
  // the inputs it takes and underline the one being typed.
  monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ["(", ",", "{"],
    signatureHelpRetriggerCharacters: [")", "}"],
    provideSignatureHelp(model, position) {
      const call = callAt(model, position);
      if (!call) return null;
      const layout = signatureLayout(call.doc);
      return {
        value: {
          signatures: [
            {
              label: layout.label,
              documentation: { value: call.doc.summary },
              parameters: layout.parameters.map((p) => ({
                label: p.label,
                documentation: { value: p.documentation },
              })),
            },
          ],
          activeSignature: 0,
          activeParameter: Math.min(call.activeParameter, layout.parameters.length - 1),
        },
        dispose() {},
      };
    },
  });
}

export interface HoverInfo {
  readonly signature: string;
  readonly markdown: string;
  readonly range: monaco.IRange;
}

/**
 * What to show for the word under the caret: a function's inputs, or a special
 * variable's meaning. Separate from the provider so it can be exercised directly.
 */
export function hoverAt(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): HoverInfo | undefined {
  const word = model.getWordAtPosition(position);
  if (!word) return undefined;
  const range = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );

  const doc = resolveDoc(model, position, word.word);
  if (doc) return { signature: doc.signature, markdown: docMarkdown(doc), range };

  const special = SPECIALS_BY_NAME.get(word.word);
  if (special) {
    return {
      signature: special.name,
      markdown: `${special.description}\n\nA coordinate the game resolves itself — read-only${
        special.legacy ? ", and a legacy spelling" : ""
      }.`,
      range,
    };
  }

  return undefined;
}

/** A qualified name like `drone.rf` is two words to Monaco; rejoin it. */
function resolveDoc(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  word: string,
): FunctionDoc | undefined {
  const before = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const qualifier = /([A-Za-z_]\w*)\.\w*$/.exec(before)?.[1];
  return (
    (qualifier ? findFunctionDoc(`${qualifier}.${word}`) : undefined) ??
    findFunctionDoc(word) ??
    // `pressure` on its own still means `drone.pressure` if nothing else claims it.
    (() => {
      const tail = BUILTINS.filter((b) => b.name.split(".").pop() === word);
      return tail.length === 1 ? findFunctionDoc(tail[0]!.name) : undefined;
    })()
  );
}

/**
 * The call the caret sits inside, and which input it is on. Walks the text once,
 * skipping comments and strings, keeping a frame per open paren: commas only
 * count at the frame's own bracket depth, so an options object or a nested call
 * never shifts the count.
 */
function callAt(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): { doc: FunctionDoc; activeParameter: number } | undefined {
  const text = model.getValue().slice(0, model.getOffsetAt(position));
  const frames: { start: number; commas: number; depth: number }[] = [];

  scan: for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      if (end < 0) return undefined; // the caret is inside a comment
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      // Unterminated means the caret is inside a string argument — still an
      // argument, so keep the frames and stop rather than giving up.
      if (j >= text.length) break scan;
      i = j;
      continue;
    }
    if (c === "<") {
      // `<x, y, z>` is one argument, so its commas must not advance the count.
      // A `<` that does not close on this line is an operator, not a literal.
      const close = text.indexOf(">", i + 1);
      const newline = text.indexOf("\n", i + 1);
      const end = close >= 0 && (newline < 0 || close < newline) ? close : -1;
      const span = text.slice(i + 1, end >= 0 ? end : newline < 0 ? text.length : newline);
      if (span.includes(",")) {
        if (end < 0) break scan; // the caret is inside the literal
        i = end;
        continue;
      }
    }

    const top = frames[frames.length - 1];
    if (c === "(") frames.push({ start: i, commas: 0, depth: 0 });
    else if (c === ")") frames.pop();
    else if (c === "{" || c === "[") {
      if (top) top.depth++;
    } else if (c === "}" || c === "]") {
      if (top && top.depth > 0) top.depth--;
    } else if (c === "," && top && top.depth === 0) top.commas++;
  }

  // Innermost first: a grouping paren has no name, so fall out to the real call.
  for (let f = frames.length - 1; f >= 0; f--) {
    const frame = frames[f]!;
    const name = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/.exec(text.slice(0, frame.start))?.[1];
    const doc = name ? findFunctionDoc(name) : undefined;
    if (doc) return { doc, activeParameter: frame.commas };
  }
  return undefined;
}
