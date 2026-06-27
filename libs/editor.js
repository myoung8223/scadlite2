// editor.js — SCADLite custom CodeMirror 6 bundle
// Exposes window.scadCM with newEditor / setErrorLine / clearErrors / toggleLineNumbers.

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, dropCursor,
         rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap,
         indentMore, indentLess } from "@codemirror/commands";
import { StreamLanguage, indentUnit, syntaxHighlighting, HighlightStyle,
         bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap,
         autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { tags } from "@lezer/highlight";

// ---- Indent settings: real TAB characters in the file, displayed 2 columns wide ----
const TAB_WIDTH = 2;

// ---- OpenSCAD vocabulary ----
const KEYWORDS = new Set([
  "module","function","if","else","for","intersection_for","let","each",
  "return","use","include","echo","assert"
]);
const BUILTINS = new Set([
  "translate","rotate","scale","resize","mirror","multmatrix","color","offset",
  "hull","minkowski","render","union","difference","intersection",
  "cube","sphere","cylinder","polyhedron","circle","square","polygon","text",
  "linear_extrude","rotate_extrude","surface","projection","import","children",
  "abs","sin","cos","tan","acos","asin","atan","atan2","sqrt","exp","ln","log",
  "pow","floor","ceil","round","sign","min","max","len","concat","norm","cross",
  "lookup","str","chr","ord","search","rands","is_undef","is_list","is_num",
  "is_string","is_bool","is_function","version","version_num","parent_module"
]);
const ATOMS = new Set(["true","false","undef","PI"]);

// ---- Tokenizer ----
function tokenBase(stream, state) {
  if (stream.eatSpace()) return null;

  if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
  if (stream.match("/*")) { state.tokenize = tokenComment; return tokenComment(stream, state); }
  if (stream.peek() === '"') { stream.next(); state.tokenize = tokenString; return tokenString(stream, state); }

  if (stream.match(/^\d*\.?\d+([eE][+-]?\d+)?/)) return "number";
  if (stream.match(/^\$[A-Za-z_]\w*/)) return "special";

  if (stream.match(/^[A-Za-z_]\w*/)) {
    const w = stream.current();
    if (KEYWORDS.has(w)) return "keyword";
    if (BUILTINS.has(w)) return "builtin";
    if (ATOMS.has(w))    return "atom";
    return null;
  }

  const ch = stream.peek();
  if (ch === "{") { stream.next(); state.depth++; return null; }
  if (ch === "}") { stream.next(); state.depth = Math.max(0, state.depth - 1); return null; }

  if (stream.match(/^[+\-*/%<>=!&|?:]+/)) return "operator";

  stream.next();
  return null;
}
function tokenComment(stream, state) {
  let ch, prev = "";
  while ((ch = stream.next()) != null) {
    if (prev === "*" && ch === "/") { state.tokenize = tokenBase; break; }
    prev = ch;
  }
  return "comment";
}
function tokenString(stream, state) {
  let ch, escaped = false;
  while ((ch = stream.next()) != null) {
    if (ch === '"' && !escaped) { state.tokenize = tokenBase; break; }
    escaped = !escaped && ch === "\\";
  }
  return "string";
}

const scadLang = StreamLanguage.define({
  name: "openscad",
  startState() { return { tokenize: tokenBase, depth: 0 }; },
  copyState(s) { return { tokenize: s.tokenize, depth: s.depth }; },
  token(stream, state) { return state.tokenize(stream, state); },
  indent(state, textAfter, context) {
    let depth = state.depth || 0;
    if (/^\s*\}/.test(textAfter)) depth = Math.max(0, depth - 1);
    return depth * context.unit;
  },
  tokenTable: {
    keyword:  tags.keyword,
    builtin:  tags.function(tags.variableName),
    atom:     tags.atom,
    special:  tags.special(tags.variableName),
    number:   tags.number,
    string:   tags.string,
    comment:  tags.comment,
    operator: tags.operator,
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } }
});

const scadHighlight = HighlightStyle.define([
  { tag: tags.comment,  color: "#6a9955" },
  { tag: tags.keyword,  color: "#569cd6" },
  { tag: tags.function(tags.variableName),    color: "#dcdcaa" },
  { tag: tags.atom,     color: "#569cd6" },
  { tag: tags.special(tags.variableName),     color: "#4fc1ff" },
  { tag: tags.number,   color: "#b5cea8" },
  { tag: tags.string,   color: "#ce9178" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.variableName, color: "#9cdcfe" },
]);

const scadTheme = EditorView.theme({
  "&": { color: "#d4d4d4", backgroundColor: "#1e1e1e", height: "100%" },
  ".cm-content": { caretColor: "#fff", fontFamily: "monospace" },
  ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#858585", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.05)" },

/*
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "rgba(0, 194, 255, 0.30)",
    outline: "1px solid rgba(0, 194, 255, 0.55)",
    borderRadius: "2px"
  },
  ".cm-nonmatchingBracket": {
    backgroundColor: "rgba(255, 70, 70, 0.30)",
    outline: "1px solid rgba(255, 90, 90, 0.55)"
  },
*/

  ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.07)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#264f78" },
  ".cm-cursor": { borderLeftColor: "#fff" },
}, { dark: true });

// ---- Tab: insert a tab at the caret; indent the block when text is selected ----
function scadTab(view) {
  if (view.state.selection.ranges.some(r => !r.empty)) return indentMore(view);
  view.dispatch(view.state.update(view.state.replaceSelection("\t"),
    { scrollIntoView: true, userEvent: "input" }));
  return true;
}
function scadShiftTab(view) { return indentLess(view); }

const lineNumberCompartment = new Compartment();
const bracketMatchCompartment = new Compartment();
const activeLineCompartment = new Compartment();

function newEditor(parent, doc, opts = {}) {
  const onChange = opts.onChange;
  let view;
  const state = EditorState.create({
    doc: doc || "",
    extensions: [
      lineNumberCompartment.of(lineNumbers()),
      activeLineCompartment.of([highlightActiveLine(), highlightActiveLineGutter()]),
      foldGutter(),
      lintGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of("\t"),
      EditorState.tabSize.of(TAB_WIDTH),
      indentOnInput(),
      bracketMatchCompartment.of(bracketMatching()),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      scadLang,
      syntaxHighlighting(scadHighlight),
      scadTheme,
      keymap.of([
        { key: "Tab", run: scadTab, shift: scadShiftTab },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
        ...historyKeymap, ...foldKeymap, ...completionKeymap,
      ]),
      EditorView.updateListener.of(u => { if (u.docChanged && onChange) onChange(view); }),
    ],
  });
  view = new EditorView({ state, parent });
  return view;
}

function setErrorLine(view, lineNumber, message) {
  if (!lineNumber || lineNumber < 1) { clearErrors(view); return; }
  const n = Math.min(lineNumber, view.state.doc.lines);
  const line = view.state.doc.line(n);
  view.dispatch(setDiagnostics(view.state, [{
    from: line.from, to: line.to, severity: "error", message: message || "Error"
  }]));
}
function clearErrors(view) { view.dispatch(setDiagnostics(view.state, [])); }
function toggleLineNumbers(view, show) {
  view.dispatch({ effects: lineNumberCompartment.reconfigure(show ? lineNumbers() : []) });
}
function toggleBracketMatching(view, show) {
  view.dispatch({ effects: bracketMatchCompartment.reconfigure(show ? bracketMatching() : []) });
}
function toggleActiveLine(view, show) {
  view.dispatch({ effects: activeLineCompartment.reconfigure(
    show ? [highlightActiveLine(), highlightActiveLineGutter()] : []) });
}

window.scadCM = { newEditor, setErrorLine, clearErrors,
                  toggleLineNumbers, toggleBracketMatching, toggleActiveLine };