# Markdown to HTML

A tiny, offline tool that converts Markdown into HTML with a live preview.
Type or paste Markdown on the left, watch it render on the right, switch the
output between the rendered preview and the generated HTML source, then copy the
HTML or download it as a standalone `.html` document.

## How to open it

Double-click `index.html`. It opens in your browser and runs directly from disk
over the `file://` protocol. There is nothing to install, build, or start, and
it never touches the network.

- Type or paste Markdown into the left pane. Conversion runs automatically as
  you type, with a short debounce so large documents stay responsive.
- Use the **Preview / HTML** toggle on the output pane to switch between the
  rendered result and the generated HTML source (shown as readable, escaped
  text).
- **Copy HTML** copies the generated markup to the clipboard.
- **Download HTML** saves the result as a self-contained `converted.html`
  document with a small built-in stylesheet.
- **Load .md** reads a local Markdown file (`.md`, `.markdown`, `.txt`, ...)
  into the input pane and converts it.
- **Clear** empties the input and the output.

Copy and Download stay disabled until there is output to act on.

## What it converts

The converter is a self-contained parser (a pragmatic CommonMark subset) with no
third-party dependencies. It supports:

- ATX headings, `#` through `######`
- Bold and italic emphasis, including `***both***`, with intra-word `_`
  protection so `snake_case_words` stay literal
- Inline code spans with single or multiple backticks
- Fenced code blocks (` ``` ` or `~~~`, with an optional language hint) and
  indented (4-space or tab) code blocks, both preserved verbatim
- Blockquotes, including nested quotes and lazy continuation
- Unordered lists (`-`, `*`, `+`) and ordered lists (`1.` or `1)`, with a
  custom start number), including nested and loose/tight lists
- Links and images, with optional titles, plus `<https://...>` and
  `<name@example.com>` autolinks
- Horizontal rules (`---`, `***`, `___`)
- Hard line breaks (two trailing spaces or a trailing backslash) and soft
  breaks
- Paragraphs

Handling rules:

- HTML special characters (`&`, `<`, `>`, `"`) in text are escaped, so pasted
  markup such as `<div>` is shown as literal text and cannot break the layout.
- Code-block and code-span contents are preserved verbatim, with the same four
  characters escaped.
- Links and image sources are sanitized: `javascript:` and `vbscript:` URLs are
  dropped, and `data:` URLs are allowed only for image sources.
- Edge cases degrade gracefully: empty input yields an empty preview, copying
  empty output does nothing, unbalanced markers and unterminated fences are
  handled, and the parser never throws on input.
- Long lines wrap or scroll inside their pane, so a wide code block never forces
  the whole page to scroll sideways.

## Offline and dependencies

100% client-side and fully offline. No build step, no server, no network
request, no telemetry, and no third-party dependencies. The interface uses your
system fonts, and all logic lives in a single classic script loaded with a plain
`<script>` tag.

## Files

```
index.html            Markup and layout
assets/css/style.css  Visual system (desktop two-pane and mobile stacked)
assets/js/tool.js     Parser (window.markdownToHtml) and UI wiring
README.md             This file
```
