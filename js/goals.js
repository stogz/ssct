// Daily goal math. Pure functions, no DOM.
export const MACROS = ['protein', 'carbs', 'fat'];
export const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 };

// Percent of daily calories from each macro.
export const PRESETS = {
  balanced: { label: 'Balanced', protein: 30, carbs: 50, fat: 20 },
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

// Stored goals, upgrading older settings: the first version's { goal, proteinGoal }, and the
// High protein and Keto presets that were removed (their calories carry over to Balanced).
export function normalizeGoals(settings) {
  const g = settings?.goals;
  if (g?.mode === 'custom') return customGoals(g);
  if (g?.mode) return goalsFromCalories(g.calories, PRESETS[g.mode] ? g.mode : 'balanced');
  if (settings?.goal > 0) return goalsFromCalories(settings.goal, 'balanced');
  return { mode: 'balanced', calories: 0, protein: 0, carbs: 0, fat: 0 };
}

// Extra nutrients that can be shown on Today. Fiber is a target to reach; sugar and sodium are limits.
// Ordered so that on Today each sits under a macro of a clearly different color.
// Their goals are worked out for each person (suggestedExtras in plan.js) unless a number is typed in.
export const EXTRAS = [
  { key: 'sodium', label: 'Sodium', unit: 'mg', kind: 'limit' },
  { key: 'sugar', label: 'Sugar', unit: 'g', kind: 'limit' },
  { key: 'fiber', label: 'Fiber', unit: 'g', kind: 'target' },
];

// The previous version saved these as goals whenever a switch was flipped, so they aren't real choices.
const OLD_DEFAULT_GOALS = { sodium: 2300, sugar: 50, fiber: 28 };
const amount = (v) => (v === '' || v == null || !(Number(v) >= 0) ? null : Number(v));

// { sodium: { show, target }, ... }: whether each shows on Today, and the goal you typed (null = use the
// amount suggested for you).
export function normalizeExtras(settings) {
  const stored = settings?.extras || {};
  return Object.fromEntries(EXTRAS.map((x) => {
    const v = stored[x.key] || {};
    let target = amount(v.target);
    if (v.target === undefined) {
      const old = amount(v.goal); // older format
      if (old != null && old !== OLD_DEFAULT_GOALS[x.key]) target = old;
    }
    return [x.key, { show: Boolean(v.show), target }];
  }));
}
