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
  documentationFor,
  PSEUDO_FUNCTIONS,
  signatureOf,
  SPECIAL_VARIABLE_DOCS,
} from "./reference.js";

export const LANGUAGE_ID = "dronescript";

const SPECIAL_VARIABLES = SPECIAL_VARIABLE_DOCS.filter((d) => !d.legacy && !d.prefix).map(
  (d) => d.name,
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

      for (const name of ["area", "filter", "fluid"]) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: "compile-time value",
          insertText: `${name}($0)`,
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
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const builtin =
        BUILTINS.find((b) => b.name === word.word) ??
        BUILTINS.find((b) => b.name.split(".").pop() === word.word);
      if (!builtin) return null;
      return {
        contents: [
          { value: `\`\`\`\n${signatureOf(builtin)}\n\`\`\`` },
          { value: documentationFor(builtin) },
        ],
      };
    },
  });
}
