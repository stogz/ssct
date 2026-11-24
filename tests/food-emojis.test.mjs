import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOOD_EMOJIS, sanitizeEmoji, emojiName } from '../js/food-emojis.js';

test('every icon is exactly one emoji, with no duplicates', () => {
  for (const [emoji, name] of FOOD_EMOJIS) {
    assert.match(emoji, /^\p{Extended_Pictographic}️?$/u, `${name} should be a single emoji`);
    assert.ok(name.length > 0);
  }
  assert.equal(new Set(FOOD_EMOJIS.map(([e]) => e)).size, FOOD_EMOJIS.length);
});

test('only food emojis are accepted', () => {
  assert.equal(sanitizeEmoji('🍎'), '🍎');
  assert.equal(sanitizeEmoji('🌶'), '🌶️'); // with or without the emoji variation selector
  for (const notFood of ['😀', '🚗', '❤️', '🍽️', '🍴', '🥄', '🔪', 'apple', '🍎🍎', '', null, undefined]) {
    assert.equal(sanitizeEmoji(notFood), '', String(notFood));
  }
});

test('names for search', () => {
  assert.equal(emojiName('🥜'), 'peanuts');
  assert.equal(emojiName('🚗'), '');
});
