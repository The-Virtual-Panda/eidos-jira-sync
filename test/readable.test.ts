// The sync review's reading of a section: markdown shown as the task shows it, line for line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEmptyText, readInline, readLines } from '../src/readable.ts';

const words = (text: string): string => readInline(text).map((span) => span.text).join('');

test('the sync review: bold, italic, code, and a link read as their words, with the marks they carry', () => {
  assert.deepEqual(readInline('Ask @ingrid about the **dock firmware** timeout.'), [
    { text: 'Ask @ingrid about the ' },
    { text: 'dock firmware', strong: true },
    { text: ' timeout.' },
  ]);
  assert.deepEqual(readInline('*soon* and `npm test`'), [{ text: 'soon', em: true }, { text: ' and ' }, { text: 'npm test', code: true }]);
  assert.equal(words('See [the dock spec](https://example.com/docks) first'), 'See the dock spec first');
  assert.equal(words('~~old~~ new'), 'old new');
  assert.deepEqual(readInline('***both***'), [{ text: 'both', strong: true, em: true }]);
});

test('the sync review: what only looks like a mark stays as written', () => {
  assert.equal(words('dock_firmware_version'), 'dock_firmware_version', 'an underscore inside a word');
  assert.equal(words('2 * 3 * 4'), '2 * 3 * 4', 'a lone star with space around it');
  assert.equal(words('\\*not bold\\*'), '*not bold*', 'an escaped mark');
  assert.deepEqual(readInline('`**raw**`'), [{ text: '**raw**', code: true }], 'marks inside code');
});

test('the sync review: each line keeps its place, read as a bullet, a box, a heading, a number, or a quote', () => {
  const lines = readLines(['## Done when', '- Works in portrait', '  - even upside down', '- [ ] Haptic tap', '- [x] Flashlight', '1. Scan', '> Rider note', '', '---', '| Dock | State |', '|---|---|', '| 12 | offline |']);
  assert.equal(lines.length, 12, 'one for one, so the marks of a diff still line up');
  assert.deepEqual(
    lines.map((line) => [line.kind, line.depth, line.lead]),
    [
      ['heading', 0, ''],
      ['bullet', 0, '•'],
      ['bullet', 1, '•'],
      ['task', 0, '☐'],
      ['task', 0, '☑'],
      ['number', 0, '1.'],
      ['quote', 0, '│'],
      ['blank', 0, ''],
      ['rule', 0, ''],
      ['text', 0, ''],
      ['rule', 0, ''],
      ['text', 0, ''],
    ],
  );
  assert.equal(lines[0]!.spans[0]!.text, 'Done when');
  assert.equal(lines[0]!.spans[0]!.strong, true, 'a heading reads in bold');
  assert.equal(lines.at(-1)!.spans.map((span) => span.text).join(''), '12  ·  offline', 'a table row reads as its cells');
});

test('the sync review: a code fence holds its lines as written', () => {
  const lines = readLines(['```', '- not a bullet', '**not bold**', '```', '- a bullet']);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['blank', 'code', 'code', 'blank', 'bullet'],
  );
  assert.deepEqual(lines[2]!.spans, [{ text: '**not bold**', code: true }]);
});

test('the sync review: a side with only space in it is empty', () => {
  assert.equal(isEmptyText(''), true);
  assert.equal(isEmptyText('  \n\n'), true);
  assert.equal(isEmptyText('- one'), false);
});
