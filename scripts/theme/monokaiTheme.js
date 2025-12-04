import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const monokaiColors = {
  background: "#272822",
  foreground: "#F8F8F2",
//  selection:  "#ffffff33",
  selection:  "#ff000033",
  lineHighlight: "#202020",
  caret: "#F8F8F0",
  gutterBackground: "#2F3129",
  gutterForeground: "#8F908A",
  gutterLineHighlight: "#272727",
};

const monokaiTheme = EditorView.theme(
  {
    "&": {
      color: monokaiColors.foreground,
      backgroundColor: monokaiColors.background,
    },
    ".cm-content": {
      caretColor: monokaiColors.caret,
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
    //   fontSize: "14px",
    },
    ".cm-scroller": {
      lineHeight: "1.4",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      //backgroundColor: monokaiColors.selection,
    },
    ".cm-gutters": {
      backgroundColor: monokaiColors.gutterBackground,
      color: monokaiColors.gutterForeground,
    //   border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: monokaiColors.lineHighlight,
    },
    ".cm-activeLineGutter": {
      backgroundColor: monokaiColors.gutterLineHighlight,
    },
  },
  { dark: true }
);

const monokaiHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#F92672" },               // if, for, return...
  { tag: [tags.number, tags.bool, tags.null], color: "#AE81FF" },
  { tag: [tags.string, tags.special(tags.string)], color: "#E6DB74" },
  { tag: [tags.comment], color: "#75715E", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName)], color: "#A6E22E" },
  { tag: [tags.typeName, tags.className], color: "#A6E22E" },
  { tag: [tags.propertyName], color: "#66D9EF" },
  { tag: [tags.operator, tags.punctuation], color: "#F8F8F2" },
  { tag: tags.invalid, color: "#F8F8F0", backgroundColor: "#F92672" },
]);

export const monokai = [
  monokaiTheme,
  syntaxHighlighting(monokaiHighlightStyle),
];
