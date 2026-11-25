import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toServings, nutritionFor, compatibleUnits, convertible, servingMeasures, sumNutrition, shiftDate,
  normalizeUnit, formatAmount, unitLabel,
} from '../js/units.js';

const oats = { servingAmount: 40, servingUnit: 'g', calories: 150, protein: 5, carbs: 27, fat: 3 };
// Label: "Serving size 2 tbsp (32g)"
const peanutButter = { servingAmount: 2, servingUnit: 'tbsp', servingAmount2: 32, servingUnit2: 'g', calories: 190, protein: 7, carbs: 8, fat: 16 };

test('servings from grams and ounces', () => {
  assert.equal(toServings(80, 'g', oats), 2);
  assert.ok(Math.abs(toServings(1, 'oz', { servingAmount: 28.349523125, servingUnit: 'g' }) - 1) < 1e-9);
  assert.equal(toServings(1.5, 'serving', oats), 1.5);
});

test('nutrition scales with portion', () => {
  const none = { fiber: 0, sugar: 0, sodium: 0 }; // oats was saved without them
  assert.deepEqual(nutritionFor(oats, 60, 'g'), { calories: 225, protein: 7.5, carbs: 40.5, fat: 4.5, ...none });
  assert.deepEqual(nutritionFor(oats, 2, 'serving'), { calories: 300, protein: 10, carbs: 54, fat: 6, ...none });
  const cereal = { servingAmount: 55, servingUnit: 'g', calories: 230, protein: 3, carbs: 37, fat: 8, fiber: 4, sugar: 12, sodium: 160 };
  assert.deepEqual(nutritionFor(cereal, 1.5, 'serving'), { calories: 345, protein: 4.5, carbs: 55.5, fat: 12, fiber: 6, sugar: 18, sodium: 240 });
});

test('volume conversion, including the new pint/quart units', () => {
  const milk = { servingAmount: 1, servingUnit: 'cup', calories: 120, protein: 8, carbs: 12, fat: 5 };
  assert.equal(nutritionFor(milk, 16, 'tbsp').calories, 120);
  assert.equal(nutritionFor(milk, 48, 'tsp').calories, 120);
  assert.equal(nutritionFor(milk, 473.176473, 'ml').calories, 240);
  assert.equal(nutritionFor(milk, 1, 'pint').calories, 240);
  assert.equal(nutritionFor(milk, 1, 'quart').calories, 480);
});

test('weight-only food cannot be logged by volume', () => {
  assert.throws(() => toServings(1, 'cup', oats));
  assert.ok(!compatibleUnits(oats).includes('tbsp'));
});

test('a second measure unlocks both weight and volume', () => {
  assert.equal(nutritionFor(peanutButter, 1, 'tbsp').calories, 95);
  assert.equal(nutritionFor(peanutButter, 3, 'tsp').calories, 95);
  assert.equal(nutritionFor(peanutButter, 16, 'g').calories, 95);
  assert.equal(nutritionFor(peanutButter, 1, 'oz').calories, 168);
  const units = compatibleUnits(peanutButter);
  for (const u of ['serving', 'tsp', 'tbsp', 'cup', 'ml', 'g', 'oz']) assert.ok(units.includes(u), u);
  assert.ok(!units.includes('slice'));
});

test('count units only match themselves, but can pair with a weight', () => {
  assert.ok(!convertible('slice', 'piece'));
  assert.ok(convertible('slice', 'slice'));
  assert.deepEqual(compatibleUnits({ servingAmount: 1, servingUnit: 'scoop' }), ['serving', 'scoop']);
  const bread = { servingAmount: 1, servingUnit: 'slice', servingAmount2: 28, servingUnit2: 'g', calories: 70 };
  assert.deepEqual(compatibleUnits(bread), ['serving', 'slice', 'g', 'oz', 'lb', 'kg']);
  assert.equal(nutritionFor(bread, 2, 'slice').calories, 140);
  assert.equal(nutritionFor(bread, 56, 'g').calories, 140);
});

test('a second measure of the same kind is ignored', () => {
  const food = { servingAmount: 1, servingUnit: 'cup', servingAmount2: 240, servingUnit2: 'ml' };
  assert.deepEqual(servingMeasures(food), [[1, 'cup']]);
});

test('labels and formatting', () => {
  assert.equal(formatAmount(2 / 3, 'cup'), '⅔');
  assert.equal(formatAmount(1.5, 'serving'), '1½');
  assert.equal(formatAmount(55.5, 'g'), '55.5');
  assert.equal(formatAmount(0.125, 'cup'), '0.13');
  assert.equal(unitLabel('cup', 2), 'cups');
  assert.equal(unitLabel('tbsp', 2), 'tbsp');
  assert.equal(unitLabel('serving', 1.5), 'servings');
  assert.equal(unitLabel('serving', 0.5), 'serving');
  assert.equal(unitLabel('cup', 2 / 3), 'cup');
  assert.equal(unitLabel('slice', 1), 'slice');
});

test('sum, dates and unit words', () => {
  assert.deepEqual(sumNutrition([{ calories: 100, protein: 1.25, carbs: 2, fat: 0, sodium: 120.4 }, { calories: 50, protein: 1.1, carbs: 0, fat: 3, fiber: 2.5 }]),
    { calories: 150, protein: 2.4, carbs: 2, fat: 3, fiber: 2.5, sugar: 0, sodium: 120 });
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(normalizeUnit('Tbsp.'), 'tbsp');
  assert.equal(normalizeUnit('grams'), 'g');
  assert.equal(normalizeUnit('qt'), 'quart');
  assert.equal(normalizeUnit('Scoops'), 'scoop');
  assert.equal(normalizeUnit('chips'), null);
});
