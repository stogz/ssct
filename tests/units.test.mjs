import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toServings, nutritionFor, compatibleUnits, sumNutrition, shiftDate, normalizeUnit } from '../js/units.js';

const oats = { servingAmount: 40, servingUnit: 'g', calories: 150, protein: 5, carbs: 27, fat: 3 };

test('servings from grams and ounces', () => {
  assert.equal(toServings(80, 'g', 40, 'g'), 2);
  assert.ok(Math.abs(toServings(1, 'oz', 28.349523125, 'g') - 1) < 1e-9);
  assert.equal(toServings(1.5, 'serving', 40, 'g'), 1.5);
});

test('nutrition scales with portion', () => {
  assert.deepEqual(nutritionFor(oats, 60, 'g'), { calories: 225, protein: 7.5, carbs: 40.5, fat: 4.5 });
  assert.deepEqual(nutritionFor(oats, 2, 'serving'), { calories: 300, protein: 10, carbs: 54, fat: 6 });
});

test('volume conversion', () => {
  const milk = { servingAmount: 1, servingUnit: 'cup', calories: 120, protein: 8, carbs: 12, fat: 5 };
  assert.equal(nutritionFor(milk, 16, 'tbsp').calories, 120);
  assert.equal(nutritionFor(milk, 473.176473, 'ml').calories, 240);
});

test('mass/volume mismatch throws', () => {
  assert.throws(() => toServings(1, 'cup', 40, 'g'));
});

test('compatible units', () => {
  assert.deepEqual(compatibleUnits('g'), ['serving', 'g', 'oz', 'lb', 'kg']);
  assert.deepEqual(compatibleUnits('piece'), ['serving', 'piece']);
  assert.ok(compatibleUnits('cup').includes('ml'));
});

test('sum and dates', () => {
  assert.deepEqual(sumNutrition([{ calories: 100, protein: 1.25, carbs: 2, fat: 0 }, { calories: 50, protein: 1.1, carbs: 0, fat: 3 }]),
    { calories: 150, protein: 2.4, carbs: 2, fat: 3 });
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(normalizeUnit('Tbsp.'), 'tbsp');
  assert.equal(normalizeUnit('grams'), 'g');
});
