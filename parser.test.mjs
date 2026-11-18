import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCompendiumSheet } from './parser.mjs';

const style = `<style>
  .ritz .waffle td { text-align: right; background-color: #123456; }
  .ritz .waffle .description { color: #abcdef; }
</style>`;
const heading = '<tr><th>1</th><td>Name</td><td>Description</td></tr>';
const first = '<tr><th>10</th><td rowspan="2">Example</td><td class="description"><b>First</b><br>line</td></tr>';
const second = '<tr><th>11</th><td class="description"><i>Second</i> <a href="https://example.com/">link</a></td></tr>';
const third = '<tr><th>12</th><td>Other</td><td colspan="2">Last</td></tr>';
const table = (rows, className = 'waffle') => `<table class="${className}"><tbody>${rows}</tbody></table>`;
const parse = (html) => parseCompendiumSheet(html, '1662574278', 'Weapon Perks');
const full = `${style}<div class="ritz grid-container">${table(heading + first + second + third)}</div>`;

test('chunked htmlview preserves the complete single-table output byte for byte', () => {
  const chunked = `${style}<div class="ritz grid-container">${table(heading + first)}<div class="grid-chunk">${table(second)}</div><div class="grid-chunk">${table(third)}</div></div>`;
  const expected = parse(full);
  assert.equal(JSON.stringify(parse(chunked)), JSON.stringify(expected));
  assert.equal(expected.rows.length, 2);
  assert.deepEqual(expected.rows[0].anchor, { row: 10, col: 0 });
  assert.equal(expected.grid.find(cell => cell.row === 10 && cell.col === 0).rowSpan, 2);
  assert.equal(expected.grid.find(cell => cell.row === 12 && cell.col === 1).colSpan, 2);
  assert.match(expected.rows[0].cell.plain, /First\nline\nSecond link/);
  assert.ok(expected.rows[0].cell.runs.some(run => run.bold));
  assert.ok(expected.rows[0].cell.runs.some(run => run.italic));
  assert.ok(expected.rows[0].cell.runs.some(run => run.href === 'https://example.com/'));
  const description = expected.grid.find(cell => cell.row === 10 && cell.col === 1).cell;
  assert.equal(description.background, '#123456');
  assert.ok(description.runs.some(run => run.color === '#abcdef'));
  assert.ok(description.runs.some(run => run.textAlign === 'right'));
});

test('only waffle tables in the selected grid are read', () => {
  const unrelated = table('<tr><th>12</th><td>Wrong</td><td>Wrong</td></tr>');
  const html = `${table('<tr><td>Decoration</td></tr>', 'decoration')}${full}<div class="ritz grid-container">${unrelated}</div>`;
  assert.equal(JSON.stringify(parse(html)), JSON.stringify(parse(full)));
});

test('the original plain-table fallback is unchanged', () => {
  const expected = JSON.stringify(parse(table(heading + first + second + third, 'plain')));
  assert.equal(expected,
    JSON.stringify(parse(table(heading + first + second + third, 'plain') + table(third, 'plain'))));
  assert.equal(expected,
    JSON.stringify(parse(`<div class="grid-container">${table(heading + first + second + third, 'plain')}</div>`)));
});
