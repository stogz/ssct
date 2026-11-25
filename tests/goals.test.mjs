import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, EXTRAS, goalsFromCalories, caloriesFromMacros, customGoals, macroSplit, normalizeGoals, normalizeExtras } from '../js/goals.js';

test('Balanced turns calories into grams: 30% protein, 50% carbs, 20% fat', () => {
  assert.deepEqual(goalsFromCalories(2000, 'balanced'), { mode: 'balanced', calories: 2000, protein: 150, carbs: 250, fat: 44 });
  assert.deepEqual(goalsFromCalories(1800, 'balanced'), { mode: 'balanced', calories: 1800, protein: 135, carbs: 225, fat: 40 });
  assert.deepEqual(Object.keys(PRESETS), ['balanced']);
});

test('custom grams turn into calories', () => {
  assert.equal(caloriesFromMacros({ protein: 150, carbs: 200, fat: 67 }), 2003);
  assert.deepEqual(customGoals({ protein: 200, carbs: '25', fat: 100 }), { mode: 'custom', protein: 200, carbs: 25, fat: 100, calories: 1800 });
  assert.deepEqual(macroSplit({ protein: 250, carbs: 25, fat: 100 }), { protein: 50, carbs: 5, fat: 45 });
  assert.equal(macroSplit({ protein: 0, carbs: 0, fat: 0 }), null);
});

test('bad input becomes zero', () => {
  assert.deepEqual(goalsFromCalories('', 'balanced'), { mode: 'balanced', calories: 0, protein: 0, carbs: 0, fat: 0 });
  assert.equal(caloriesFromMacros({ protein: -5, carbs: 'abc', fat: 10 }), 90);
  assert.throws(() => goalsFromCalories(2000, 'nope'));
});

test('stored goals, including the first version format', () => {
  assert.deepEqual(normalizeGoals({ goal: 1800, proteinGoal: 120 }), { mode: 'balanced', calories: 1800, protein: 135, carbs: 225, fat: 40 });
  assert.deepEqual(normalizeGoals({}), { mode: 'balanced', calories: 0, protein: 0, carbs: 0, fat: 0 });
  // High protein and Keto were removed: their calories carry over to Balanced.
  assert.deepEqual(normalizeGoals({ goals: { mode: 'keto', calories: 1500 } }), goalsFromCalories(1500, 'balanced'));
  assert.equal(normalizeGoals({ goals: { mode: 'highProtein', calories: 2200 } }).mode, 'balanced');
  assert.equal(normalizeGoals({ goals: { mode: 'custom', protein: 100, carbs: 100, fat: 50 } }).calories, 1250);
});

test('fiber, sugar and sodium settings', () => {
  assert.deepEqual(EXTRAS.map((x) => x.key), ['sodium', 'sugar', 'fiber']);
  assert.deepEqual(normalizeExtras({}), {
    sodium: { show: false, goal: 2300 }, sugar: { show: false, goal: 50 }, fiber: { show: false, goal: 28 },
  });
  const set = normalizeExtras({ extras: { fiber: { show: true, goal: 35 }, sodium: { show: true, goal: '1500' } } });
  assert.deepEqual(set.fiber, { show: true, goal: 35 });
  assert.deepEqual(set.sodium, { show: true, goal: 1500 });
  assert.deepEqual(set.sugar, { show: false, goal: 50 });
  assert.equal(normalizeExtras({ extras: { sugar: { goal: -3 } } }).sugar.goal, 50); // nonsense falls back
});
