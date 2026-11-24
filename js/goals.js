// Daily goal math. Pure functions, no DOM.
export const MACROS = ['protein', 'carbs', 'fat'];
export const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 };

// Percent of daily calories from each macro.
export const PRESETS = {
  balanced:    { label: 'Balanced',     protein: 30, carbs: 40, fat: 30 },
  highProtein: { label: 'High protein', protein: 50, carbs: 35, fat: 15 },
  keto:        { label: 'Keto',         protein: 50, carbs: 5,  fat: 45 },
};

const clean = (n) => {
  n = Number(n);
  return isFinite(n) && n > 0 ? n : 0;
};

// Preset: you pick the calories, the grams are worked out from the preset's split.
export function goalsFromCalories(calories, presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown preset: ${presetKey}`);
  const kcal = Math.round(clean(calories));
  const grams = (m) => Math.round((kcal * preset[m]) / 100 / KCAL_PER_GRAM[m]);
  return { mode: presetKey, calories: kcal, protein: grams('protein'), carbs: grams('carbs'), fat: grams('fat') };
}

// Protein and carbs are 4 kcal per gram, fat is 9.
export function caloriesFromMacros(g) {
  return Math.round(MACROS.reduce((sum, m) => sum + clean(g[m]) * KCAL_PER_GRAM[m], 0));
}

// Custom: you pick the grams, the calories are worked out from them.
export function customGoals(g) {
  const goals = { mode: 'custom', protein: clean(g.protein), carbs: clean(g.carbs), fat: clean(g.fat) };
  goals.calories = caloriesFromMacros(goals);
  return goals;
}

// Share of calories each macro provides, in whole percents (null when there are no grams).
export function macroSplit(g) {
  const total = MACROS.reduce((sum, m) => sum + clean(g[m]) * KCAL_PER_GRAM[m], 0);
  if (!total) return null;
  return Object.fromEntries(MACROS.map((m) => [m, Math.round((clean(g[m]) * KCAL_PER_GRAM[m] * 100) / total)]));
}

// Stored goals, upgrading the first version's settings ({ goal, proteinGoal }).
export function normalizeGoals(settings) {
  const g = settings?.goals;
  if (g?.mode === 'custom') return customGoals(g);
  if (g && PRESETS[g.mode]) return goalsFromCalories(g.calories, g.mode);
  if (settings?.goal > 0) return goalsFromCalories(settings.goal, 'balanced');
  return { mode: 'balanced', calories: 0, protein: 0, carbs: 0, fat: 0 };
}
