import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalsFromCalories, caloriesFromMacros, customGoals, macroSplit, normalizeGoals } from '../js/goals.js';

test('presets turn calories into grams', () => {
  // Balanced: 30% protein, 40% carbs, 30% fat
  assert.deepEqual(goalsFromCalories(2000, 'balanced'), { mode: 'balanced', calories: 2000, protein: 150, carbs: 200, fat: 67 });
  // High protein: 50% protein, 35% carbs, 15% fat
  assert.deepEqual(goalsFromCalories(2000, 'highProtein'), { mode: 'highProtein', calories: 2000, protein: 250, carbs: 175, fat: 33 });
  // Keto: 50% protein, 5% carbs, 45% fat
  assert.deepEqual(goalsFromCalories(2000, 'keto'), { mode: 'keto', calories: 2000, protein: 250, carbs: 25, fat: 100 });
});

test('custom grams turn into calories', () => {
  assert.equal(caloriesFromMacros({ protein: 150, carbs: 200, fat: 67 }), 2003);
  assert.deepEqual(customGoals({ protein: 200, carbs: '25', fat: 100 }), { mode: 'custom', protein: 200, carbs: 25, fat: 100, calories: 1800 });
  assert.deepEqual(macroSplit({ protein: 250, carbs: 25, fat: 100 }), { protein: 50, carbs: 5, fat: 45 });
  assert.equal(macroSplit({ protein: 0, carbs: 0, fat: 0 }), null);
});

test('bad input becomes zero', () => {
  assert.deepEqual(goalsFromCalories('', 'keto'), { mode: 'keto', calories: 0, protein: 0, carbs: 0, fat: 0 });
  assert.equal(caloriesFromMacros({ protein: -5, carbs: 'abc', fat: 10 }), 90);
  assert.throws(() => goalsFromCalories(2000, 'nope'));
});

test('stored goals, including the first version format', () => {
  assert.deepEqual(normalizeGoals({ goal: 1800, proteinGoal: 120 }), { mode: 'balanced', calories: 1800, protein: 135, carbs: 180, fat: 60 });
  assert.deepEqual(normalizeGoals({}), { mode: 'balanced', calories: 0, protein: 0, carbs: 0, fat: 0 });
  assert.equal(normalizeGoals({ goals: { mode: 'keto', calories: 1500 } }).fat, 75);
  assert.equal(normalizeGoals({ goals: { mode: 'custom', protein: 100, carbs: 100, fat: 50 } }).calories, 1250);
});
