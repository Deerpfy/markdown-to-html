/* Markdown to HTML converter.
   Classic script, window globals only. No imports, no exports, no network.

   A self-contained Markdown parser (a pragmatic CommonMark subset) lives in the
   first IIFE and is exposed as window.markdownToHtml. It is pure string
   processing: it never touches the DOM or the network, and never throws on user
   input. The second IIFE wires it to the page. The two are independent so the
   parser can be unit-tested on its own.

   Placeholder sentinel: NUL (\x00). Any NUL in the input is swapped for U+FFFD
   up front, so NUL is free to mark already-rendered inline fragments. */

/* ===================================================================
   1. Parser  ->  window.markdownToHtml(markdownString)
   =================================================================== */
(function () {
  "use strict";

  var NUL = "\x00";

  /* ----------------------------------------------------- text + url escaping */

  /* Escape the four HTML specials so user text can never break into markup.
     Applied to every run of plain text and verbatim to code spans/blocks. */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* Keep clickable/loadable output safe even though this runs locally: drop
     script-ish URL schemes. data: is allowed only for image sources. */
  function sanitizeUrl(url, isImage) {
    var u = String(url).replace(/[\x00-\x1F\x7F]/g, "").trim();
    var m = u.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
    if (m) {
      var scheme = m[1].toLowerCase();
      if (scheme === "javascript" || scheme === "vbscript") { return ""; }
      if (scheme === "data") { return (isImage && /^data:image\//i.test(u)) ? u : ""; }
    }
    return u;
  }

  /* --------------------------------------------------------------- helpers */
  function repeat(s, n) { var o = ""; while (n-- > 0) { o += s; } return o; }
  function spaces(n) { return repeat(" ", n); }
  function unescapePunct(s) { return s.replace(/\\([!-\/:-@\[-`{-~])/g, "$1"); }

  /* Expand only the LEADING run of tabs to spaces (tab stop = 4). Tabs inside
     content are left untouched. After this, block indentation is pure spaces. */
  function expandLeadingTabs(line) {
    var i = 0, col = 0, out = "";
    while (i < line.length) {
      var ch = line.charAt(i);
      if (ch === " ") { out += " "; col += 1; i += 1; }
      else if (ch === "\t") { var adv = 4 - (col % 4); out += spaces(adv); col += adv; i += 1; }
      else { break; }
    }
    return out + line.slice(i);
  }

  function isBlank(line) { return /^[ ]*$/.test(line); }
  function indentWidth(line) { var m = line.match(/^ */); return m ? m[0].length : 0; }
  function stripIndent(line, n) {
    var i = 0;
    while (i < n && line.charAt(i) === " ") { i += 1; }
    return line.slice(i);
  }
  function colWidth(str, startCol) {
    var col = startCol;
    for (var i = 0; i < str.length; i++) {
      if (str.charAt(i) === "\t") { col += 4 - (col % 4); } else { col += 1; }
    }
    return col - startCol;
  }

  /* ------------------------------------------------------- block detectors */
  function openFence(line) {
    var m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!m) { return null; }
    var ch = m[2].charAt(0);
    var info = m[3];
    if (ch === "`" && info.indexOf("`") !== -1) { return null; }
    return { indent: m[1].length, ch: ch, len: m[2].length, info: info.trim() };
  }
  function closeFence(line, f) {
    var m = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
    return !!m && m[2].charAt(0) === f.ch && m[2].length >= f.len;
  }

  function atxHeading(line) {
    var m = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/);
    if (!m) { return null; }
    var text = (m[2] || "").replace(/[ \t]+#+[ \t]*$/, "");
    return { level: m[1].length, text: text };
  }

  function isHr(line) {
    return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
  }

  /* Recognise a list-item marker and the column where its content starts. */
  function matchItem(line) {
    var u = line.match(/^( {0,3})([-+*])(?:([ \t]+)(.*)|[ \t]*$)/);
    if (u) { return buildItem(u[1].length, 1, u[3], u[4], false, u[2], null, 1); }
    var o = line.match(/^( {0,3})(\d{1,9})([.)])(?:([ \t]+)(.*)|[ \t]*$)/);
    if (o) { return buildItem(o[1].length, o[2].length + 1, o[4], o[5], true, null, o[3], parseInt(o[2], 10)); }
    return null;
  }
  function buildItem(indent, markerWidth, ws, text, ordered, bullet, delim, startNum) {
    var markerEnd = indent + markerWidth;
    var after = ws ? colWidth(ws, markerEnd) : 0;
    var firstText, contentIndent;
    if (text === undefined || (text === "" && after === 0)) {
      contentIndent = markerEnd + 1; firstText = "";
    } else if (after >= 1 && after <= 4) {
      contentIndent = markerEnd + after; firstText = text;
    } else {
      contentIndent = markerEnd + 1; firstText = spaces(after - 1) + text;
    }
    return {
      indent: indent, ordered: ordered, bullet: bullet, delim: delim,
      startNum: isFinite(startNum) ? startNum : 1,
      contentIndent: contentIndent, firstText: firstText
    };
  }

  function isBlockStart(l) {
    if (isBlank(l)) { return false; }
    return !!openFence(l) || !!atxHeading(l) || isHr(l) || /^ {0,3}>/.test(l) || !!matchItem(l);
  }

  /* A new block can interrupt an open paragraph only in these cases. Indented
     code deliberately cannot, so 4-space lines continue a paragraph lazily. */
  function interruptsParagraph(l) {
    if (openFence(l) || atxHeading(l) || isHr(l) || /^ {0,3}>/.test(l)) { return true; }
    var m = matchItem(l);
    if (m) {
      if (m.firstText.trim() === "") { return false; }
      if (m.ordered && m.startNum !== 1) { return false; }
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------- block parser */
  /* lines: array of (tab-expanded) source lines for this context.
     tight:  when true, top-level paragraphs are emitted inline (no <p>), as in
             the items of a tight list. */
  function parseBlocks(lines, tight) {
    var out = [];
    var i = 0, n = lines.length;

    while (i < n) {
      var line = lines[i];

      if (isBlank(line)) { i += 1; continue; }

      /* fenced code block */
      var f = openFence(line);
      if (f) {
        var buf = [];
        i += 1;
        while (i < n && !closeFence(lines[i], f)) { buf.push(stripIndent(lines[i], f.indent)); i += 1; }
        if (i < n) { i += 1; }
        out.push(renderFence(f, buf));
        continue;
      }

      /* ATX heading */
      var h = atxHeading(line);
      if (h) { out.push("<h" + h.level + ">" + parseInline(h.text) + "</h" + h.level + ">"); i += 1; continue; }

      /* thematic break (before lists so "* * *" is a rule, not a list) */
      if (isHr(line)) { out.push("<hr>"); i += 1; continue; }

      /* blockquote */
      if (/^ {0,3}>/.test(line)) {
        var inner = [];
        var prevBlank = false;
        while (i < n) {
          var bl = lines[i];
          if (/^ {0,3}>/.test(bl)) {
            var stripped = bl.replace(/^ {0,3}>[ \t]?/, "");
            inner.push(stripped);
            prevBlank = isBlank(stripped);
            i += 1;
          } else if (!isBlank(bl) && !isBlockStart(bl) && !prevBlank) {
            inner.push(bl); i += 1;       /* lazy paragraph continuation */
          } else { break; }
        }
        out.push("<blockquote>\n" + parseBlocks(inner, false) + "\n</blockquote>");
        continue;
      }

      /* list */
      if (matchItem(line)) {
        var res = parseList(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      /* indented code block (only reachable at a fresh block position) */
      if (indentWidth(line) >= 4) {
        var code = [];
        while (i < n) {
          var cl = lines[i];
          if (indentWidth(cl) >= 4) { code.push(stripIndent(cl, 4)); i += 1; }
          else if (isBlank(cl)) { code.push(""); i += 1; }
          else { break; }
        }
        while (code.length && code[code.length - 1] === "") { code.pop(); }
        out.push("<pre><code>" + escapeHtml(code.join("\n")) + "\n</code></pre>");
        continue;
      }

      /* paragraph */
      var para = [line.replace(/^ +/, "")];
      i += 1;
      while (i < n) {
        var pl = lines[i];
        if (isBlank(pl) || interruptsParagraph(pl)) { break; }
        para.push(pl.replace(/^ +/, ""));
        i += 1;
      }
      var text = para.join("\n").replace(/[ \t]+$/, "");
      var rendered = parseInline(text);
      out.push(tight ? rendered : "<p>" + rendered + "</p>");
    }

    return out.join("\n");
  }

  function renderFence(f, buf) {
    var lang = f.info ? f.info.split(/\s+/)[0].replace(/[^\w+#.\-]/g, "") : "";
    var cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : "";
    var content = buf.join("\n");
    return "<pre><code" + cls + ">" + (content.length ? escapeHtml(content) + "\n" : "") + "</code></pre>";
  }

  function trimBlankEdges(arr) {
    var a = arr.slice();
    while (a.length && a[0] === "") { a.shift(); }
    while (a.length && a[a.length - 1] === "") { a.pop(); }
    return a;
  }

  /* ------------------------------------------------------------- lists */
  function parseList(lines, start) {
    var first = matchItem(lines[start]);
    var ordered = first.ordered;
    var listIndent = first.indent;
    var bullet = first.bullet;
    var delim = first.delim;
    var startNum = first.startNum;
    var items = [];
    var loose = false;
    var i = start;

    while (i < lines.length) {
      var m = matchItem(lines[i]);
      if (!m || m.ordered !== ordered || m.indent !== listIndent) { break; }
      if (ordered ? (m.delim !== delim) : (m.bullet !== bullet)) { break; }

      var contentIndent = m.contentIndent;
      var itemLines = [m.firstText];
      i += 1;
      var pendingBlanks = 0;
      var sawInteriorBlank = false;

      while (i < lines.length) {
        var l = lines[i];
        if (isBlank(l)) { pendingBlanks += 1; i += 1; continue; }
        if (indentWidth(l) >= contentIndent) {
          for (var b = 0; b < pendingBlanks; b++) { itemLines.push(""); }
          if (pendingBlanks > 0) { sawInteriorBlank = true; }
          pendingBlanks = 0;
          itemLines.push(stripIndent(l, contentIndent));
          i += 1;
          continue;
        }
        if (pendingBlanks > 0) { break; }                 /* blank then outdent: item ends */
        if (matchItem(l) || isBlockStart(l)) { break; }   /* sibling or new block: item ends */
        itemLines.push(l.replace(/^ +/, ""));             /* lazy continuation */
        i += 1;
      }

      if (sawInteriorBlank) { loose = true; }
      if (pendingBlanks > 0 && i < lines.length) {
        var peek = matchItem(lines[i]);
        if (peek && peek.ordered === ordered && peek.indent === listIndent &&
            (ordered ? peek.delim === delim : peek.bullet === bullet)) {
          loose = true;
        }
      }
      items.push(itemLines);
    }

    var li = [];
    for (var k = 0; k < items.length; k++) {
      li.push("<li>" + parseBlocks(trimBlankEdges(items[k]), !loose) + "</li>");
    }
    var tag = ordered ? "ol" : "ul";
    var attr = (ordered && startNum !== 1) ? ' start="' + startNum + '"' : "";
    return {
      html: "<" + tag + attr + ">\n" + li.join("\n") + "\n</" + tag + ">",
      next: i
    };
  }

  /* ====================================================== inline parsing */

  function makePlaceholder(store) {
    return function (html) { store.push(html); return NUL + (store.length - 1) + NUL; };
  }

  /* Code spans take precedence over everything else; matched spans are escaped
     and stored so no later pass alters them. */
  function replaceCodeSpans(s, ph) {
    var out = "", i = 0, n = s.length;
    while (i < n) {
      if (s.charAt(i) !== "`") { out += s.charAt(i); i += 1; continue; }
      var j = i; while (j < n && s.charAt(j) === "`") { j += 1; }
      var run = j - i;
      var k = j, found = -1;
      while (k < n) {
        if (s.charAt(k) === "`") {
          var p = k; while (p < n && s.charAt(p) === "`") { p += 1; }
          if (p - k === run) { found = k; break; }
          k = p;
        } else { k += 1; }
      }
      if (found === -1) { out += s.slice(i, j); i = j; continue; }
      var content = s.slice(j, found).replace(/\n/g, " ");
      if (content.length >= 2 && content.charAt(0) === " " &&
          content.charAt(content.length - 1) === " " && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      out += ph("<code>" + escapeHtml(content) + "</code>");
      i = found + run;
    }
    return out;
  }

  /* Parse a link/image whose "[" is at p. For images the caller already saw the
     leading "!". Returns { html, end } or null. Link text is processed with the
     shared store so nested code spans/images resolve at the final restore. */
  function parseLinkAt(s, p, isImage, store) {
    var n = s.length, i = p + 1, depth = 1;
    while (i < n && depth > 0) {
      var c = s.charAt(i);
      if (c === "\\") { i += 2; continue; }
      if (c === "[") { depth += 1; }
      else if (c === "]") { depth -= 1; if (depth === 0) { break; } }
      i += 1;
    }
    if (depth !== 0) { return null; }
    var label = s.slice(p + 1, i);
    var j = i + 1;
    if (s.charAt(j) !== "(") { return null; }
    j += 1;

    while (j < n && /\s/.test(s.charAt(j))) { j += 1; }
    var dest = "";
    if (s.charAt(j) === "<") {
      j += 1; var d0 = j;
      while (j < n && s.charAt(j) !== ">" && s.charAt(j) !== "\n") { j += 1; }
      if (s.charAt(j) !== ">") { return null; }
      dest = s.slice(d0, j); j += 1;
    } else {
      var pd = 0, d1 = j;
      while (j < n) {
        var ch = s.charAt(j);
        if (ch === "\\") { j += 2; continue; }
        if (/\s/.test(ch)) { break; }
        if (ch === "(") { pd += 1; j += 1; continue; }
        if (ch === ")") { if (pd === 0) { break; } pd -= 1; j += 1; continue; }
        j += 1;
      }
      dest = s.slice(d1, j);
    }

    while (j < n && /\s/.test(s.charAt(j))) { j += 1; }
    var title = null, tc = s.charAt(j);
    if (tc === '"' || tc === "'" || tc === "(") {
      var close = tc === "(" ? ")" : tc;
      j += 1; var t0 = j;
      while (j < n && s.charAt(j) !== close) { if (s.charAt(j) === "\\") { j += 2; } else { j += 1; } }
      if (s.charAt(j) !== close) { return null; }
      title = s.slice(t0, j); j += 1;
    }
    while (j < n && /\s/.test(s.charAt(j))) { j += 1; }
    if (s.charAt(j) !== ")") { return null; }
    j += 1;

    var safe = sanitizeUrl(unescapePunct(dest), isImage);
    var titleAttr = title != null ? ' title="' + escapeAttr(unescapePunct(title)) + '"' : "";
    if (isImage) {
      var alt = escapeHtml(stripMarks(label));
      return { html: '<img src="' + escapeAttr(safe) + '" alt="' + alt + '"' + titleAttr + '>', end: j };
    }
    return { html: '<a href="' + escapeAttr(safe) + '"' + titleAttr + '>' + inlineExpand(label, false, store) + "</a>", end: j };
  }

  function replaceImages(s, ph, store) {
    var out = "", i = 0, n = s.length;
    while (i < n) {
      if (s.charAt(i) === "!" && s.charAt(i + 1) === "[") {
        var r = parseLinkAt(s, i + 1, true, store);
        if (r) { out += ph(r.html); i = r.end; continue; }
      }
      out += s.charAt(i); i += 1;
    }
    return out;
  }

  function replaceLinks(s, ph, store) {
    var out = "", i = 0, n = s.length;
    while (i < n) {
      if (s.charAt(i) === "[") {
        var r = parseLinkAt(s, i, false, store);
        if (r) { out += ph(r.html); i = r.end; continue; }
      }
      out += s.charAt(i); i += 1;
    }
    return out;
  }

  /* Reduce a link/image label to plain text for an alt attribute. */
  function stripMarks(label) {
    return label
      .replace(/\\([!-\/:-@\[-`{-~])/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]+/g, "")
      .replace(new RegExp(NUL + "\\d+" + NUL, "g"), "");
  }

  /* ----------------------------------------------------------- emphasis */
  /* CommonMark-style emphasis: tokenise into text and delimiter runs, then
     match closers to the nearest compatible opener with a stack, honouring the
     flanking rules and the "rule of three". Runs on already-escaped text. */
  function parseEmphasis(input) {
    var isWs = function (c) { return c === "" || /\s/.test(c); };
    var isPunct = function (c) { return c !== "" && /[!-\/:-@\[-`{-~]/.test(c); };

    var nodes = [];
    var i = 0, len = input.length;
    while (i < len) {
      var c = input.charAt(i);
      if (c === "*" || c === "_") {
        var j = i; while (j < len && input.charAt(j) === c) { j += 1; }
        var count = j - i;
        var before = i > 0 ? input.charAt(i - 1) : "";
        var after = j < len ? input.charAt(j) : "";
        var bWs = isWs(before), aWs = isWs(after), bP = isPunct(before), aP = isPunct(after);
        var left = !aWs && (!aP || bWs || bP);
        var right = !bWs && (!bP || aWs || aP);
        var canOpen, canClose;
        if (c === "_") { canOpen = left && (!right || bP); canClose = right && (!left || aP); }
        else { canOpen = left; canClose = right; }
        nodes.push({ type: "d", char: c, num: count, orig: count, canOpen: canOpen, canClose: canClose, text: repeat(c, count), open: "", close: "" });
        i = j;
      } else {
        var k = i; while (k < len && input.charAt(k) !== "*" && input.charAt(k) !== "_") { k += 1; }
        nodes.push({ type: "t", text: input.slice(i, k) });
        i = k;
      }
    }

    var dl = [];
    for (var a = 0; a < nodes.length; a++) { if (nodes[a].type === "d") { dl.push(nodes[a]); } }

    var ci = 0;
    while (ci < dl.length) {
      var closer = dl[ci];
      if (closer.removed || !closer.canClose || closer.num === 0) { ci += 1; continue; }
      var opener = null, oi = -1;
      for (var x = ci - 1; x >= 0; x--) {
        var cand = dl[x];
        if (cand.removed || cand.num === 0 || !cand.canOpen || cand.char !== closer.char) { continue; }
        var odd = (closer.canOpen || cand.canClose) &&
                  (closer.orig + cand.orig) % 3 === 0 &&
                  !(closer.orig % 3 === 0 && cand.orig % 3 === 0);
        if (odd) { continue; }
        opener = cand; oi = x; break;
      }
      if (!opener) { ci += 1; continue; }

      var use = (opener.num >= 2 && closer.num >= 2) ? 2 : 1;
      var tag = use === 2 ? "strong" : "em";
      opener.num -= use; opener.text = repeat(opener.char, opener.num);
      closer.num -= use; closer.text = repeat(closer.char, closer.num);
      opener.open = "<" + tag + ">" + opener.open;
      closer.close = closer.close + "</" + tag + ">";
      for (var r = oi + 1; r < ci; r++) { dl[r].removed = true; }
      if (closer.num === 0) { ci += 1; }
    }

    var result = "";
    for (var z = 0; z < nodes.length; z++) {
      var nd = nodes[z];
      result += nd.type === "t" ? nd.text : (nd.close + nd.text + nd.open);
    }
    return result;
  }

  /* Expand inline text to a string carrying placeholders, fully emphasis-
     processed but NOT yet restored. allowLinks=false (used for link text)
     prevents nested links. */
  function inlineExpand(text, allowLinks, store) {
    var ph = makePlaceholder(store);
    var s = String(text);

    s = s.replace(/\\([!-\/:-@\[-`{-~])/g, function (_, ch) { return ph(escapeHtml(ch)); });
    s = replaceCodeSpans(s, ph);

    if (allowLinks) {
      s = s.replace(/<((?:[a-zA-Z][a-zA-Z0-9+.\-]{1,31}):[^<>\s]*)>/g, function (_, url) {
        return ph('<a href="' + escapeAttr(sanitizeUrl(url, false)) + '">' + escapeHtml(url) + "</a>");
      });
      s = s.replace(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g, function (_, mail) {
        return ph('<a href="mailto:' + escapeAttr(mail) + '">' + escapeHtml(mail) + "</a>");
      });
      s = replaceImages(s, ph, store);
      s = replaceLinks(s, ph, store);
    }

    s = escapeHtml(s);
    s = parseEmphasis(s);
    return s;
  }

  /* Resolve placeholders. A stored fragment may reference earlier (lower-index)
     placeholders, so repeat until none remain (depth is bounded). */
  function restore(s, store) {
    var guard = 0;
    while (s.indexOf(NUL) !== -1 && guard < 60) {
      s = s.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), function (_, idx) {
        var v = store[Number(idx)];
        return v === undefined ? "" : v;
      });
      guard += 1;
    }
    return s;
  }

  /* Full inline pass for block text: expand, apply line breaks, then restore. */
  function parseInline(text) {
    var store = [];
    var s = inlineExpand(text, true, store);
    /* A backslash or two+ spaces before a newline is a hard break; any other
       newline is a soft break (kept as a newline in the markup). */
    s = s.replace(/( {2,}|\\)\n/g, "<br>\n");
    return restore(s, store);
  }

  /* --------------------------------------------------------------- public */
  function markdownToHtml(src) {
    if (src == null) { return ""; }
    src = String(src).replace(/\x00/g, "").replace(/\r\n?/g, "\n");
    if (!src.trim()) { return ""; }
    var lines = src.split("\n");
    for (var i = 0; i < lines.length; i++) { lines[i] = expandLeadingTabs(lines[i]); }
    try {
      return parseBlocks(lines, false);
    } catch (e) {
      return "";   /* final safety net: never throw on input */
    }
  }

  window.markdownToHtml = markdownToHtml;
})();

/* ===================================================================
   2. User interface wiring
   =================================================================== */
(function () {
  "use strict";

  if (typeof document === "undefined") { return; }   /* parser-only environments */

  var els = {};
  var liveTimer = null;
  var statusTimer = null;
  var btnTimers = {};
  var view = "preview";
  var lastHtml = "";

  function byId(id) { return document.getElementById(id); }

  function ready(fn) {
    if (document.readyState !== "loading") { fn(); }
    else { document.addEventListener("DOMContentLoaded", fn); }
  }

  function setStatus(msg) { if (els.status) { els.status.textContent = msg; } }

  function flash(msg) {
    setStatus(msg);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { setStatus("Ready"); }, 1800);
  }

  function flashButton(btn, label) {
    var original = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", original);
    btn.textContent = label;
    btn.classList.add("is-flash");
    clearTimeout(btnTimers[btn.id]);
    btnTimers[btn.id] = setTimeout(function () {
      btn.textContent = btn.getAttribute("data-label") || original;
      btn.classList.remove("is-flash");
    }, 1500);
  }

  function counts(text) {
    if (!text) { return "Empty"; }
    var chars = text.length;
    return chars + (chars === 1 ? " char" : " chars");
  }

  function refreshState() {
    var hasIn = els.input.value.length > 0;
    var hasOut = lastHtml.length > 0;
    els.copyBtn.disabled = !hasOut;
    els.downloadBtn.disabled = !hasOut;
    els.clearBtn.disabled = !(hasIn || hasOut);
  }

  function convert() {
    var html;
    try { html = window.markdownToHtml(els.input.value); }
    catch (e) { html = ""; }
    lastHtml = html;
    els.preview.innerHTML = html;
    els.sourceCode.textContent = html;
    els.outCount.textContent = counts(html);
    els.inCount.textContent = counts(els.input.value);
    refreshState();
  }

  /* --------------------------------------------------------- view toggle */
  function setView(next) {
    view = next;
    var preview = view === "preview";
    els.preview.hidden = !preview;
    els.source.hidden = preview;
    els.viewPreviewBtn.setAttribute("aria-pressed", preview ? "true" : "false");
    els.viewSourceBtn.setAttribute("aria-pressed", preview ? "false" : "true");
  }

  /* ------------------------------------------------------------- actions */
  function copyOutput() {
    if (!lastHtml) { return; }
    var ok = function () { flashButton(els.copyBtn, "Copied"); flash("HTML copied to clipboard"); };
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(lastHtml).then(ok, function () { fallbackCopy(lastHtml, ok); });
    } else {
      fallbackCopy(lastHtml, ok);
    }
  }

  /* The async clipboard API is often unavailable on file://, so fall back to a
     temporary off-screen textarea and the legacy copy command. */
  function fallbackCopy(text, ok) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    var copied = false;
    try {
      ta.focus();
      ta.select();
      if (ta.setSelectionRange) { ta.setSelectionRange(0, ta.value.length); }
      copied = document.execCommand && document.execCommand("copy");
    } catch (e) { copied = false; }
    document.body.removeChild(ta);
    els.input.focus();
    if (copied) { ok(); }
    else { flash("Copy unavailable. Switch to the HTML view and copy manually."); }
  }

  function buildDocument(body) {
    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      "  <title>Converted Markdown</title>",
      "  <style>",
      "    :root { color-scheme: light; }",
      "    body { margin: 0 auto; max-width: 44rem; padding: 2.5rem 1.25rem;",
      "           font: 16px/1.62 -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, Helvetica, Arial, sans-serif;",
      "           color: #1a1a18; background: #faf9f6; overflow-wrap: break-word; }",
      "    h1, h2, h3, h4, h5, h6 { line-height: 1.22; margin: 1.5em 0 0.6em; }",
      "    h2 { padding-bottom: 0.3em; border-bottom: 1px solid #e7e4dc; }",
      "    a { color: #3b43a4; }",
      "    pre { padding: 1rem; background: #f3f1ea; border-radius: 10px; overflow-x: auto; }",
      "    code { font-family: ui-monospace, \"SF Mono\", Menlo, Consolas, monospace; font-size: 0.88em; }",
      "    pre code { font-size: 0.84em; }",
      "    :not(pre) > code { background: #f3f1ea; padding: 0.16em 0.4em; border-radius: 5px; }",
      "    blockquote { margin: 0 0 1em; padding: 0.2em 0 0.2em 1em; border-left: 3px solid #d6d2c7; color: #57564f; }",
      "    hr { border: 0; border-top: 1px solid #d6d2c7; margin: 1.8em 0; }",
      "    img { max-width: 100%; height: auto; }",
      "    table { border-collapse: collapse; } th, td { border: 1px solid #d6d2c7; padding: 0.5em 0.8em; }",
      "  </style>",
      "</head>",
      "<body>",
      body,
      "</body>",
      "</html>",
      ""
    ].join("\n");
  }

  function downloadOutput() {
    if (!lastHtml) { return; }
    try {
      var blob = new Blob([buildDocument(lastHtml)], { type: "text/html;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "converted.html";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      flashButton(els.downloadBtn, "Downloaded");
      flash("Downloaded converted.html");
    } catch (e) {
      flash("Download unavailable in this browser.");
    }
  }

  function clearAll() {
    els.input.value = "";
    lastHtml = "";
    els.preview.innerHTML = "";
    els.sourceCode.textContent = "";
    els.inCount.textContent = counts("");
    els.outCount.textContent = counts("");
    refreshState();
    setStatus("Ready");
    els.input.focus();
  }

  /* Read a local Markdown file into the input pane and convert it. Uses
     FileReader, which works on file:// without any network access. */
  function loadFile(file) {
    if (!file) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      els.input.value = String(reader.result || "");
      els.inCount.textContent = counts(els.input.value);
      clearTimeout(liveTimer);
      convert();
      flash("Loaded " + file.name);
    };
    reader.onerror = function () { flash("Could not read that file."); };
    reader.readAsText(file);
  }

  /* --------------------------------------------------------------- setup */
  ready(function () {
    els.input = byId("mdInput");
    els.preview = byId("preview");
    els.source = byId("source");
    els.sourceCode = byId("sourceCode");
    els.copyBtn = byId("copyBtn");
    els.downloadBtn = byId("downloadBtn");
    els.loadBtn = byId("loadBtn");
    els.fileInput = byId("fileInput");
    els.clearBtn = byId("clearBtn");
    els.viewPreviewBtn = byId("viewPreviewBtn");
    els.viewSourceBtn = byId("viewSourceBtn");
    els.status = byId("status");
    els.inCount = byId("inCount");
    els.outCount = byId("outCount");

    els.input.addEventListener("input", function () {
      els.inCount.textContent = counts(els.input.value);
      clearTimeout(liveTimer);
      liveTimer = setTimeout(convert, 200);   /* debounce keeps large docs responsive */
    });

    els.copyBtn.addEventListener("click", copyOutput);
    els.downloadBtn.addEventListener("click", downloadOutput);
    els.clearBtn.addEventListener("click", clearAll);
    els.loadBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function (e) {
      loadFile(e.target.files && e.target.files[0]);
      els.fileInput.value = "";   /* allow re-loading the same file */
    });
    els.viewPreviewBtn.addEventListener("click", function () { setView("preview"); });
    els.viewSourceBtn.addEventListener("click", function () { setView("source"); });

    setView("preview");
    els.inCount.textContent = counts("");
    els.outCount.textContent = counts("");
    refreshState();
    setStatus("Ready");
  });
})();
