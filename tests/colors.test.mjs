import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHex, toHex, mix, contrast, ensureContrast, accentVars, ACCENTS, ACCENT_VARS } from '../js/colors.js';

const close = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('hex parsing and mixing', () => {
  assert.deepEqual(parseHex('#16a34a'), [22, 163, 74]);
  assert.equal(parseHex('green'), null);
  assert.equal(toHex([22, 163, 74]), '#16a34a');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('WCAG contrast', () => {
  close(contrast('#000000', '#ffffff'), 21);
  close(contrast('#ffffff', '#ffffff'), 1);
  close(contrast('#16a34a', '#ffffff'), 3.3, 0.05);
});

test('ensureContrast moves only as far as needed', () => {
  assert.equal(ensureContrast('#000000', '#ffffff', 4.5, '#000000'), '#000000');
  const darker = ensureContrast('#16a34a', '#f6f7f5', 4.5, '#000000');
  assert.ok(contrast(darker, '#f6f7f5') >= 4.5);
  assert.ok(contrast(darker, '#f6f7f5') < 5.5); // not much darker than needed
});

test('every accent (presets and odd custom colors) is readable in both modes', () => {
  const choices = [...ACCENTS.map((a) => accentVars(a.light, a.dark, a.chartDark)), accentVars('#ffff00'), accentVars('#111111'), accentVars('#ff69b4')];
  for (const v of choices) {
    assert.deepEqual(Object.keys(v).sort(), [...ACCENT_VARS].sort());
    assert.ok(contrast(v['accent-fg-l'], '#f6f7f5') >= 4.5, `fg light ${v['accent-l']}`);
    assert.ok(contrast(v['accent-fg-d'], '#1a201c') >= 4.5, `fg dark ${v['accent-d']}`);
    assert.ok(contrast(v['chart-line-l'], '#ffffff') >= 3, `chart light ${v['accent-l']}`);
    assert.ok(contrast(v['chart-line-d'], '#1a201c') >= 3, `chart dark ${v['accent-d']}`);
    assert.ok(contrast(v['accent-ink-l'], v['accent-l']) >= 3, `ink light ${v['accent-l']}`);
    assert.ok(contrast(v['accent-ink-d'], v['accent-d']) >= 3, `ink dark ${v['accent-d']}`);
  }
});

test('default green keeps its look', () => {
  const g = ACCENTS[0];
  const v = accentVars(g.light, g.dark, g.chartDark);
  assert.equal(v['accent-l'], '#16a34a');
  assert.equal(v['accent-ink-l'], '#ffffff'); // white text on green buttons, as before
  assert.equal(v['chart-line-l'], '#16a34a');
  assert.equal(v['accent-d'], '#22c55e');
  assert.equal(v['chart-line-d'], '#1eaf52');
  assert.equal(v['accent-fg-d'], '#22c55e');
});
