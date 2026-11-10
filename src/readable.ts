// A section's markdown read the way the task shows it, one line at a time, for the sync review and the merge: a list
// item with its bullet, a checklist line with its box, a heading in bold, and bold, italic, code, and a link's words
// in place of the marks that make them. Kept line by line so the lines one side alone holds can still be marked.

export interface Span {
  text: string;
  strong?: boolean;
  em?: boolean;
  code?: boolean;
  strike?: boolean;
}

export interface ReadableLine {
  // blank: nothing to read; rule: a horizontal rule or a table's divider row
  kind: 'text' | 'heading' | 'bullet' | 'number' | 'task' | 'quote' | 'code' | 'rule' | 'blank';
  // how deep a list item sits, two spaces a level
  depth: number;
  // what leads the line: a bullet, an item's number, or a checklist box
  lead: string;
  spans: Span[];
}

const BULLET = '•';
const BOX = '☐';
const TICKED = '☑';

// Bold, italic, struck, code, and a link or image read as its words; a backslash keeps the mark after it as text.
export function readInline(text: string): Span[] {
  const out: Span[] = [];
  const push = (span: Span): void => {
    if (span.text === '') return;
    const last = out[out.length - 1];
    if (last && !last.code && !span.code && last.strong === span.strong && last.em === span.em && last.strike === span.strike) last.text += span.text;
    else out.push(span);
  };
  const walk = (source: string, marks: Omit<Span, 'text'>): void => {
    let plain = '';
    const flush = (): void => {
      push({ text: plain, ...marks });
      plain = '';
    };
    let i = 0;
    while (i < source.length) {
      const rest = source.slice(i);
      if (rest[0] === '\\' && rest.length > 1 && /[\\`*_~[\]()#>!|-]/.test(rest[1]!)) {
        plain += rest[1];
        i += 2;
        continue;
      }
      const code = /^(`+)([\s\S]+?)\1(?!`)/.exec(rest);
      if (code) {
        flush();
        push({ text: code[2]!.trim() === '' ? code[2]! : code[2]!.replace(/^ (.*) $/s, '$1'), ...marks, code: true });
        i += code[0].length;
        continue;
      }
      const link = /^!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link) {
        flush();
        walk(link[1]! === '' ? link[2]! : link[1]!, marks);
        i += link[0].length;
        continue;
      }
      const both = /^\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/.exec(rest);
      if (both) {
        flush();
        walk(both[1]!, { ...marks, strong: true, em: true });
        i += both[0].length;
        continue;
      }
      const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
      if (strong && (strong[1] === '**' || !/\w/.test(source[i - 1] ?? ''))) {
        flush();
        walk(strong[2]!, { ...marks, strong: true });
        i += strong[0].length;
        continue;
      }
      const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (strike) {
        flush();
        walk(strike[1]!, { ...marks, strike: true });
        i += strike[0].length;
        continue;
      }
      // an underscore inside a word (snake_case) is the word's, never italic
      const em = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest);
      if (em && (em[1] === '*' || (!/\w/.test(source[i - 1] ?? '') && !/\w/.test(source[i + em[0].length] ?? '')))) {
        flush();
        walk(em[2]!, { ...marks, em: true });
        i += em[0].length;
        continue;
      }
      plain += rest[0];
      i += 1;
    }
    flush();
  };
  walk(text, {});
  return out;
}

const depthOf = (indent: string): number => Math.floor(indent.replace(/\t/g, '  ').length / 2);

// One line out of its fence; `fenced` says whether a code fence held it open.
function readLine(line: string, fenced: boolean): ReadableLine {
  if (fenced) return { kind: 'code', depth: 0, lead: '', spans: line === '' ? [] : [{ text: line, code: true }] };
  if (line.trim() === '') return { kind: 'blank', depth: 0, lead: '', spans: [] };
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line) || /^ *\|?( *:?-+:? *\|)+ *(:?-+:?)? *\|? *$/.test(line)) return { kind: 'rule', depth: 0, lead: '', spans: [] };
  const heading = /^ {0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line);
  if (heading) return { kind: 'heading', depth: 0, lead: '', spans: readInline(heading[1]!).map((span) => ({ ...span, strong: true })) };
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) return { kind: 'task', depth: depthOf(task[1]!), lead: task[2] === ' ' ? BOX : TICKED, spans: readInline(task[3]!) };
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { kind: 'bullet', depth: depthOf(bullet[1]!), lead: BULLET, spans: readInline(bullet[2]!) };
  const number = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (number) return { kind: 'number', depth: depthOf(number[1]!), lead: `${number[2]}.`, spans: readInline(number[3]!) };
  const quote = /^ {0,3}>\s?(.*)$/.exec(line);
  if (quote) return { kind: 'quote', depth: 0, lead: '│', spans: readInline(quote[1]!) };
  // a table row reads as its cells, set apart
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
    const spans: Span[] = [];
    cells.forEach((cell, index) => {
      if (index > 0) spans.push({ text: '  ·  ' });
      spans.push(...readInline(cell));
    });
    return { kind: 'text', depth: 0, lead: '', spans };
  }
  return { kind: 'text', depth: 0, lead: '', spans: readInline(line.trim()) };
}

// Every line of a text, in order and one for one, so a line's place in the text is its place here.
export function readLines(lines: string[]): ReadableLine[] {
  let fenced = false;
  return lines.map((line) => {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      return { kind: 'blank', depth: 0, lead: '', spans: [] };
    }
    return readLine(line, fenced);
  });
}

// Whether a side holds no text at all, so the review says so rather than drawing an empty line.
export const isEmptyText = (text: string): boolean => text.trim() === '';
