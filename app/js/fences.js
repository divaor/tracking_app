// Fenced code blocks in a model's answer, read the way CommonMark (and marked, which draws the
// answer) reads them: a block opens with a line of three or more backticks or tildes and closes at
// a line of at least as many of the same character with nothing after them, or at the end of the
// text. So a block can hold shorter fences: a README's ``` inside a JSON string never ends a
// ```file-steps block, and a ```` block can hold ``` ones. Before 0.46 the step parsers took the
// first ``` anywhere as the end, and a step that wrote a Markdown file came back as "not valid JSON".
// Pure (no DOM): the assistant's tracker-steps (assistantSteps.js) use it. A copy of Tracker
// Editor's fences.js (its file, Git and other steps): keep them in step.

// Indented more than CommonMark allows (a list item's fence) is still taken: steps in a list are
// steps all the same.
const OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function block(src, open, closeStart, end, closed) {
  let body = src.slice(open.bodyStart, Math.max(open.bodyStart, closeStart));
  if (closed) body = body.replace(/\r?\n$/, '');
  // Left open: a closing run on the last line's end ("]```") is the fence, not the content.
  else body = body.replace(new RegExp(`[ \\t]*\\${open.char}{${open.size},}[ \\t\\r\\n]*$`), '');
  if (open.indent) {
    const lead = new RegExp(`^[ \\t]{0,${open.indent}}`);
    body = body.split('\n').map((line) => line.replace(lead, '')).join('\n');
  }
  return { lang: open.lang, info: open.info, body, start: open.start, end, closed };
}

/**
 * The fenced blocks of `text`, in order: { lang, info, body, start, end, closed }. `lang` is the
 * info string's first word in lower case ('' when none); `text.slice(start, end)` is the block,
 * its fence lines included; `body` is what lies between the fences. A block left open runs to
 * the end of the text (closed: false), as while an answer streams.
 */
export function codeFences(text) {
  const src = String(text ?? '');
  const blocks = [];
  let open = null;
  let at = 0;
  while (at <= src.length) {
    const nl = src.indexOf('\n', at);
    const lineEnd = nl === -1 ? src.length : nl;
    const next = nl === -1 ? src.length + 1 : nl + 1;
    const line = src.slice(at, lineEnd).replace(/\r$/, '');
    if (!open) {
      const m = OPEN.exec(line);
      // A backtick fence's info string holds no backticks (``` foo ``` is inline code).
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        const info = m[3].trim();
        open = { indent: m[1].length, char: m[2][0], size: m[2].length, info, lang: (info.split(/\s+/)[0] ?? '').toLowerCase(), start: at, bodyStart: Math.min(next, src.length) };
      }
    } else {
      const m = CLOSE.exec(line);
      if (m && m[1][0] === open.char && m[1].length >= open.size) {
        blocks.push(block(src, open, at, lineEnd, true));
        open = null;
      }
    }
    at = next;
  }
  if (open) blocks.push(block(src, open, src.length, src.length, false));
  return blocks;
}

/** The words before the first block in one of `langs` (while an answer streams: its steps hidden). */
export function wordsBefore(text, langs) {
  const src = String(text ?? '');
  const first = codeFences(src).find((b) => langs.includes(b.lang));
  return (first ? src.slice(0, first.start) : src).trim();
}

/** `text` without the blocks given (from codeFences), blank lines tidied. */
export function withoutBlocks(text, blocks) {
  const src = String(text ?? '');
  let out = '';
  let at = 0;
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    if (b.start < at) continue;
    out += src.slice(at, b.start);
    at = b.end;
  }
  return (out + src.slice(at)).replace(/\n{3,}/g, '\n\n').trim();
}

/** The first whole JSON value in `s` ('{…}' or '[…]', strings respected), or null. */
function firstValue(s) {
  const from = s.search(/[[{]/);
  if (from === -1) return null;
  const stack = [];
  let inString = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) return null;
      if (!stack.length) return s.slice(from, i + 1);
    }
  }
  return null;
}

/** Raw line breaks and tabs inside strings escaped (a model writing a file's text as it is). */
function escapeRawInStrings(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') inString = false;
      else if (c === '\n') {
        out += '\\n';
        continue;
      } else if (c === '\r') {
        out += '\\r';
        continue;
      } else if (c === '\t') {
        out += '\\t';
        continue;
      }
    } else if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/** Commas before a closing bracket, outside strings, left out. */
function dropTrailingCommas(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',' && /^\s*[\]}]/.test(s.slice(i + 1))) continue;
    out += c;
  }
  return out;
}

/**
 * JSON as a model writes it: JSON.parse first; then with raw line breaks inside strings escaped,
 * text around the value left out (a note after the list) and trailing commas dropped. Throws
 * when none of that gives JSON.
 */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  try {
    return JSON.parse(s);
  } catch (first) {
    const escaped = escapeRawInStrings(s);
    const value = firstValue(escaped);
    for (const attempt of [escaped, value, value && dropTrailingCommas(value)]) {
      if (!attempt) continue;
      try {
        return JSON.parse(attempt);
      } catch {
        // the next way
      }
    }
    throw first;
  }
}

/**
 * The text inside a fence wrapping the whole answer (a model asked for text alone that fenced it
 * anyway), or null. The closing fence is the last line, so the text may hold fences of its own.
 */
export function unwrapFence(text) {
  const m = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(String(text ?? '').trim());
  if (!m || m[4][0] !== m[1][0] || m[4].length < m[1].length) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return m[3];
}
