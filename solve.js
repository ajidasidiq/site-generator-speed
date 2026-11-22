// Amba Site Builder — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input, byte for byte, and does it faster: direct Markdown rendering
// with no token objects and first-character block dispatch, inline markup found
// with native indexOf scans and plain runs escaped in one native pass, front
// matter sliced out of the source instead of split-and-rejoined, an ASCII fast
// path for slugs with a per-case memo, an inlined whitespace test for word
// counts, templates parsed once into compact opcode arrays, and memoised
// includes (a template that reads only site/tags/recent renders once per case;
// one that reads those plus a single object renders once per object).
// Every memo cache is created fresh inside each run() call, so nothing carries
// from one case to the next. Dependency-free ES module, Node 22.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The slug of `text`, memoised per case in `memo`. */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  memo.set(text, out);
  return out;
}

function slugifySlow(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether code unit `c` is whitespace in JavaScript's \s sense. */
function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The body is sliced out of the
 * source instead of split-and-rejoined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeIdx = -1; // index of the closing '---' line's first '-'
  const p = text.indexOf('\n---\n', 3);
  if (p !== -1) closeIdx = p + 1;
  else if (text.endsWith('\n---')) closeIdx = text.length - 3;
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeIdx - 1);
  const body = closeIdx + 3 === text.length ? '' : text.slice(closeIdx + 4);
  const data = {};
  if (fmText !== '') {
    const lines = fmText.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${li + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  for (; k < line.length; k++) {
    const ch = line[k];
    if (ch !== ' ' && ch !== '\t') return null;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line[k];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  const c = line[h];
  if (c !== ' ' && c !== '\t') return null;
  let a = h + 1;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (a === b) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line[k];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  return k >= 2 && k < line.length && !isWS(line.charCodeAt(k));
}


const ESCAPABLES = '\\`*_[]()#+-.!>';

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` is a link's href. */
const NEXT_SPECIAL = /[\\`*[]/g;
function inline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    NEXT_SPECIAL.lastIndex = i;
    const mm = NEXT_SPECIAL.exec(s);
    const j = mm === null ? n : mm.index;
    if (j > i) {
      out += esc(s.slice(i, j));
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLES.indexOf(s[i + 1]) !== -1) {
        out += esc(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k2 = s.indexOf('`', i + 1);
      if (k2 > i + 1) {
        out += `<code>${esc(s.slice(i + 1, k2))}</code>`;
        i = k2 + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k2 = findUnescaped(s, '**', i + 2);
        if (k2 > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k2), link)}</strong>`;
          i = k2 + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const k2 = findSingleStar(s, i + 1);
        if (k2 > i + 1) {
          out += `<em>${inline(s.slice(i + 1, k2), link)}</em>`;
          i = k2 + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    // c === '['
    const k2 = findUnescaped(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${esc(link(target))}">${inline(s.slice(i + 1, k2), link)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i++;
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Rendered directly, with no token objects.
 */
function renderMarkdown(src, link, slugMemo) {
  const lines = src.split('\n');
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const first = line[0];
    if (first === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let body = '';
        while (i < L && !isFenceClose(lines[i])) body += `${esc(lines[i])}\n`, i++;
        i++;
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        html += `<pre><code${cls}>${body}</code></pre>\n`;
        continue;
      }
    } else if (first === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugMemo), ids);
        const h = inline(heading.text, link);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    } else if (first === '-' || first === '*') {
      if (isHR(line)) { html += '<hr>\n'; i++; continue; }
      if (line[1] === ' ') {
        const items = [];
        let item = trimST(line.slice(2));
        i++;
        while (i < L) {
          const ln = lines[i];
          if ((ln[0] === '-' || ln[0] === '*') && ln[1] === ' ') {
            items.push(item);
            item = trimST(ln.slice(2));
            i++;
          } else if (isContinued(ln)) {
            item += `\n${trimST(ln)}`;
            i++;
          } else break;
        }
        items.push(item);
        html += `<ul>\n${items.map((it) => `<li>${inline(it, link)}</li>\n`).join('')}</ul>\n`;
        continue;
      }
    } else if (first === '>') {
      let inner = '';
      while (i < L && lines[i][0] === '>') {
        let t = lines[i].slice(1);
        if (t[0] === ' ') t = t.slice(1);
        t = trimST(t);
        if (t !== '') inner += (inner === '' ? '' : '\n') + t;
        i++;
      }
      html += inner === '' ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(inner, link)}</p>\n</blockquote>\n`;
      continue;
    } else if (first >= '0' && first <= '9') {
      const m = /^(\d{1,9})\. (.*)$/.exec(line);
      if (m !== null) {
        const start = Number(m[1]);
        const items = [];
        let item = trimST(m[2]);
        i++;
        while (i < L) {
          const ln = lines[i];
          const m2 = /^(\d{1,9})\. (.*)$/.exec(ln);
          if (m2 !== null) {
            items.push(item);
            item = trimST(m2[2]);
            i++;
          } else if (isContinued(ln)) {
            item += `\n${trimST(ln)}`;
            i++;
          } else break;
        }
        items.push(item);
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        html += `${open}\n${items.map((it) => `<li>${inline(it, link)}</li>\n`).join('')}</ol>\n`;
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break.
    let text = trimST(line);
    i++;
    while (i < L && !endsParagraph(lines[i])) text += `\n${trimST(lines[i++])}`;
    const p = inline(text, link);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

// Opcodes, as compact arrays:
//   [0, text]                 literal text
//   [1, path]                 {{ path }} (escaped)
//   [2, path]                 {{{ path }}} (raw)
//   [3, name, path, body]     {% for name in path %} body {% endfor %}
//   [4, not, path, then, else|null]
//   [5, name]                 {% include "name" %}
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_FOR = 3;
const OP_IF = 4;
const OP_INCLUDE = 5;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into opcode arrays (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const rootBody = [];
  const stack = [{ kind: 'root', node: null, body: rootBody }];
  let body = rootBody;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([OP_TEXT, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? OP_VAR : OP_RAW, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = [OP_FOR, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', node, body: node[3] });
        body = node[3];
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = [OP_IF, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.node[4] ?? parent.node[3]);
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push([OP_INCLUDE, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return rootBody;
}

/**
 * Each template's free root names: the names it reads from its enclosing scope
 * (names bound by its own for loops excluded), including, through its includes,
 * the names the included templates read. Computed to a fixpoint so cyclic
 * includes still converge.
 */
function computeDeps(templates) {
  const deps = new Map();
  for (const name of templates.keys()) deps.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, ops] of templates) {
      const d = deps.get(name);
      const before = d.size;
      collectDeps(ops, d, new Set(), templates, deps);
      if (d.size !== before) changed = true;
    }
  }
  return deps;
}

function collectDeps(ops, out, bound, templates, deps) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === OP_VAR || op[0] === OP_RAW) {
      if (!bound.has(op[1][0])) out.add(op[1][0]);
    } else if (op[0] === OP_FOR) {
      if (!bound.has(op[2][0])) out.add(op[2][0]);
      const b2 = new Set(bound);
      b2.add(op[1]);
      b2.add('loop');
      collectDeps(op[3], out, b2, templates, deps);
    } else if (op[0] === OP_IF) {
      if (!bound.has(op[2][0])) out.add(op[2][0]);
      collectDeps(op[3], out, bound, templates, deps);
      if (op[4] !== null) collectDeps(op[4], out, bound, templates, deps);
    } else if (op[0] === OP_INCLUDE) {
      const sub = deps.get(op[1]);
      if (sub !== undefined) for (const f of sub) if (!bound.has(f)) out.add(f);
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed
 * templates, their free names, and the per-case include memos.
 */
function renderOps(ops, scope, ctx, depth) {
  let out = '';
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === OP_TEXT) out += op[1];
    else if (op[0] === OP_VAR) out += esc(textOf(lookup(scope, op[1])));
    else if (op[0] === OP_RAW) out += textOf(lookup(scope, op[1]));
    else if (op[0] === OP_IF) {
      const v = truthy(lookup(scope, op[2]));
      const branch = v !== op[1] ? op[3] : op[4];
      if (branch !== null) out += renderOps(branch, scope, ctx, depth);
    } else if (op[0] === OP_FOR) {
      const xs = lookup(scope, op[2]);
      if (Array.isArray(xs)) {
        const body = op[3];
        for (let k = 0; k < xs.length; k++) {
          const vars = { [op[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderOps(body, { vars, parent: scope }, ctx, depth);
        }
      }
    } else {
      out += renderInclude(op[1], scope, ctx, depth);
    }
  }
  return out;
}

/**
 * An include, memoised: a template that reads only site/tags/recent renders
 * once per case; one that reads those plus a single object renders once per
 * object (keyed by the resolved value, in the depth it renders at). Anything
 * else renders fresh.
 */
function renderInclude(name, scope, ctx, depth) {
  const ops = ctx.templates.get(name);
  if (ops === undefined || depth >= INCLUDE_DEPTH) return '';
  const free = ctx.deps.get(name);
  let depCount = 0;
  let depVal;
  for (const f of free) {
    if (f === 'site' || f === 'tags' || f === 'recent') continue;
    depCount++;
    if (depCount === 1) depVal = lookup(scope, [f]);
    else break;
  }
  if (depCount === 0) {
    const key = `${name}\n${depth + 1}`;
    let s = ctx.memoG.get(key);
    if (s === undefined) {
      s = renderOps(ops, scope, ctx, depth + 1);
      ctx.memoG.set(key, s);
    }
    return s;
  }
  if (depCount === 1) {
    let byVal = ctx.memoV.get(name);
    if (byVal === undefined) {
      byVal = new Map();
      ctx.memoV.set(name, byVal);
    }
    let byDepth = byVal.get(depVal);
    if (byDepth === undefined) {
      byDepth = new Map();
      byVal.set(depVal, byDepth);
    }
    let s = byDepth.get(depth + 1);
    if (s === undefined) {
      s = renderOps(ops, scope, ctx, depth + 1);
      byDepth.set(depth + 1, s);
    }
    return s;
  }
  return renderOps(ops, scope, ctx, depth + 1);
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s, slugMemo) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s, slugMemo) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, card, slugMemo) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, slugMemo),
    older: linkOf(s.older ?? null, slugMemo),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugMemo = new Map();
  const ctx = { templates: new Map(), deps: new Map(), memoG: new Map(), memoV: new Map() };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      ctx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  ctx.deps = computeDeps(ctx.templates);
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in order: refused, generator-owned, no date,
  // no layout, then draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ctx.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugMemo);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p, slugMemo));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return null;
    return renderOps(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s, slugMemo);
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, card, slugMemo) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
