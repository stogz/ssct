import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNutritionLabel } from '../js/label-parser.js';

const serving = (r) => [r.servingAmount && Math.round(r.servingAmount * 1000) / 1000, r.servingUnit, r.servingAmount2, r.servingUnit2];

test('standard US label keeps both serving measures', () => {
  const text = `Nutrition Facts
8 servings per container
Serving size 2/3 cup (55g)
Amount per serving
Calories 230
% Daily Value*
Total Fat 8g 10%
Saturated Fat 1g 5%
Trans Fat 0g
Cholesterol 0mg 0%
Sodium 160mg 7%
Total Carbohydrate 37g 13%
Dietary Fiber 4g 14%
Total Sugars 12g
Protein 3g`;
  const r = parseNutritionLabel(text);
  assert.deepEqual([r.calories, r.fat, r.carbs, r.protein], [230, 8, 37, 3]);
  assert.deepEqual([r.fiber, r.sugar, r.sodium], [4, 12, 160]);
  assert.deepEqual(serving(r), [0.667, 'cup', 55, 'g']);
});

test('total sugars, not added sugars; sodium misread as m9', () => {
  const r = parseNutritionLabel('Calories 150\nSodium 480m9 21%\nTotal Carbohydrate 30g\nDietary Fiber 49 14%\nTotal Sugars 14g\nIncludes 10g Added Sugars 20%\nProtein 2g');
  assert.deepEqual([r.sodium, r.fiber, r.sugar], [480, 4, 14]);
});

test('OCR noise: g read as 9, O for zero, calories on next line', () => {
  const text = `Serving Size 1 cup (240mL)
Calories
150
Total Fat 89 12%
Total Carb. 12g 4%
Protein Og`;
  const r = parseNutritionLabel(text);
  assert.deepEqual([r.calories, r.fat, r.carbs, r.protein], [150, 8, 12, 0]);
  // cup and mL are both volume, so only the exact metric one is kept
  assert.deepEqual(serving(r), [240, 'ml', null, null]);
});

test('old-style label with calories from fat', () => {
  const r = parseNutritionLabel(`Serving Size 1 bar
Calories 190 Calories from Fat 70
Total Fat 8g
Total Carbohydrate 25g
Protein 4g`);
  assert.equal(r.calories, 190);
  assert.deepEqual(serving(r), [1, 'bar', null, null]);
});

test('EU label per 100g', () => {
  const r = parseNutritionLabel(`Nutrition per 100g
Energy 1046 kJ / 250 kcal
Fat 9.5 g
of which saturates 2.1 g
Carbohydrate 30,2 g
of which sugars 4 g
Fibre 3.1 g
Protein 11 g
Salt 1.2 g`);
  assert.deepEqual([r.calories, r.fat, r.carbs, r.protein], [250, 9.5, 30.2, 11]);
  assert.deepEqual([r.sugar, r.fiber, r.sodium], [4, 3.1, 480]); // salt 1.2 g = 480 mg sodium
  assert.deepEqual(serving(r), [100, 'g', null, null]);
});

test('EU label with a portion column still uses per-100g (the first column)', () => {
  const r = parseNutritionLabel('Typical values Per 100g Per portion (30g)\nEnergy 1500kJ / 359kcal 108kcal\nProtein 7g 2.1g');
  assert.equal(r.calories, 359);
  assert.deepEqual(serving(r), [100, 'g', null, null]);
});

test('spoon measures with weight', () => {
  const r = parseNutritionLabel('Serving size 2 tbsp (32g)\nCalories 190');
  assert.deepEqual(serving(r), [2, 'tbsp', 32, 'g']);
  assert.deepEqual(serving(parseNutritionLabel('Serving size 1 1/2 tsp (7g)')), [1.5, 'tsp', 7, 'g']);
  assert.deepEqual(serving(parseNutritionLabel('Serving size 1 1/2 tbsp\nCalories 90')), [1.5, 'tbsp', null, null]);
});

test('count measures with weight', () => {
  assert.deepEqual(serving(parseNutritionLabel('Serving Size 1 scoop (31g)')), [1, 'scoop', 31, 'g']);
  assert.deepEqual(serving(parseNutritionLabel('Serving size about 12 chips (28g)')), [12, 'piece', 28, 'g']);
  assert.deepEqual(serving(parseNutritionLabel('Serving size 55g')), [55, 'g', null, null]);
});

test('real OCR output from a rendered label (g misread as 9)', () => {
  const text = 'Nutrition Facts\n8 servings per container\nServing size 2/3 cup (559)\nEE\nAmount per serving\nCalories 230\nTotal Fat 8g\nSaturated Fat 1g\nTrans Fat Og\nSodium 160mg\nJotal Carbohydrate 379\nDietary Fiber 4g\nProtein 3g\n';
  const r = parseNutritionLabel(text);
  assert.deepEqual([r.calories, r.fat, r.carbs, r.protein], [230, 8, 37, 3]);
  assert.deepEqual(serving(r), [0.667, 'cup', 55, 'g']);
});
