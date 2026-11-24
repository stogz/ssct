import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNutritionLabel } from '../js/label-parser.js';

test('standard US label', () => {
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
  assert.deepEqual(parseNutritionLabel(text), {
    calories: 230, fat: 8, carbs: 37, protein: 3, servingAmount: 55, servingUnit: 'g',
  });
});

test('OCR noise: g read as 9, O for zero, calories on next line', () => {
  const text = `Serving Size 1 cup (240mL)
Calories
150
Total Fat 89 12%
Total Carb. 12g 4%
Protein Og`;
  const r = parseNutritionLabel(text);
  assert.equal(r.calories, 150);
  assert.equal(r.fat, 8);
  assert.equal(r.carbs, 12);
  assert.equal(r.protein, 0);
  assert.equal(r.servingAmount, 240);
  assert.equal(r.servingUnit, 'ml');
});

test('old-style label with calories from fat', () => {
  const text = `Serving Size 1 bar
Calories 190 Calories from Fat 70
Total Fat 8g
Total Carbohydrate 25g
Protein 4g`;
  const r = parseNutritionLabel(text);
  assert.equal(r.calories, 190);
  assert.equal(r.servingAmount, 1);
  assert.equal(r.servingUnit, 'piece');
});

test('EU label per 100g', () => {
  const text = `Nutrition per 100g
Energy 1046 kJ / 250 kcal
Fat 9.5 g
of which saturates 2.1 g
Carbohydrate 30,2 g
of which sugars 4 g
Protein 11 g`;
  assert.deepEqual(parseNutritionLabel(text), {
    calories: 250, fat: 9.5, carbs: 30.2, protein: 11, servingAmount: 100, servingUnit: 'g',
  });
});

test('fractional serving with no metric', () => {
  const r = parseNutritionLabel('Serving size 1 1/2 tbsp\nCalories 90');
  assert.equal(r.servingAmount, 1.5);
  assert.equal(r.servingUnit, 'tbsp');
  assert.equal(r.fat, null);
});

test('real OCR output from a rendered label (g misread as 9)', () => {
  const text = 'Nutrition Facts\n8 servings per container\nServing size 2/3 cup (559)\nEE\nAmount per serving\nCalories 230\nTotal Fat 8g\nSaturated Fat 1g\nTrans Fat Og\nSodium 160mg\nJotal Carbohydrate 379\nDietary Fiber 4g\nProtein 3g\n';
  assert.deepEqual(parseNutritionLabel(text), {
    calories: 230, fat: 8, carbs: 37, protein: 3, servingAmount: 55, servingUnit: 'g',
  });
});
