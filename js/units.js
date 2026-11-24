// Unit conversion + nutrition scaling. Pure functions, no DOM.

// Base units: grams for mass, millilitres for volume.
export const UNITS = {
  g:     { label: 'g',     kind: 'mass',   factor: 1 },
  oz:    { label: 'oz',    kind: 'mass',   factor: 28.349523125 },
  lb:    { label: 'lb',    kind: 'mass',   factor: 453.59237 },
  kg:    { label: 'kg',    kind: 'mass',   factor: 1000 },
  ml:    { label: 'ml',    kind: 'volume', factor: 1 },
  floz:  { label: 'fl oz', kind: 'volume', factor: 29.5735295625 },
  cup:   { label: 'cup',   kind: 'volume', factor: 236.5882365 },
  tbsp:  { label: 'tbsp',  kind: 'volume', factor: 14.78676478125 },
  tsp:   { label: 'tsp',   kind: 'volume', factor: 4.92892159375 },
  l:     { label: 'L',     kind: 'volume', factor: 1000 },
  piece: { label: 'piece', kind: 'count',  factor: 1 },
};

// Always available: "serving" means one of the food's own serving size.
export const SERVING = 'serving';

export function unitLabel(unit) {
  if (unit === SERVING) return 'serving';
  return UNITS[unit]?.label ?? unit;
}

// Units a food can be logged in, given the unit its serving size is expressed in.
export function compatibleUnits(servingUnit) {
  const kind = UNITS[servingUnit]?.kind;
  const same = kind && kind !== 'count'
    ? Object.keys(UNITS).filter((u) => UNITS[u].kind === kind)
    : servingUnit && UNITS[servingUnit] ? [servingUnit] : [];
  return [SERVING, ...same];
}

// How many servings is `amount` of `unit`, for a food whose serving is servingAmount servingUnit?
export function toServings(amount, unit, servingAmount, servingUnit) {
  amount = Number(amount);
  if (!isFinite(amount) || amount < 0) return 0;
  if (unit === SERVING) return amount;
  const from = UNITS[unit];
  const to = UNITS[servingUnit];
  if (!from || !to || from.kind !== to.kind) {
    throw new Error(`Can't convert ${unit} to ${servingUnit}`);
  }
  const sAmt = Number(servingAmount);
  if (!(sAmt > 0)) throw new Error('Serving size must be greater than 0');
  return (amount * from.factor) / (sAmt * to.factor);
}

const round1 = (n) => Math.round(n * 10) / 10;

// Nutrition for a portion of a food. food has: servingAmount, servingUnit, calories, protein, carbs, fat (per serving).
export function nutritionFor(food, amount, unit) {
  const s = toServings(amount, unit, food.servingAmount, food.servingUnit);
  return {
    calories: Math.round((Number(food.calories) || 0) * s),
    protein: round1((Number(food.protein) || 0) * s),
    carbs: round1((Number(food.carbs) || 0) * s),
    fat: round1((Number(food.fat) || 0) * s),
  };
}

export function sumNutrition(entries) {
  const t = entries.reduce(
    (a, e) => ({
      calories: a.calories + (Number(e.calories) || 0),
      protein: a.protein + (Number(e.protein) || 0),
      carbs: a.carbs + (Number(e.carbs) || 0),
      fat: a.fat + (Number(e.fat) || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return { calories: Math.round(t.calories), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat) };
}

// Map loose unit text (from a label or user) to a unit key.
export function normalizeUnit(text) {
  const t = String(text || '').toLowerCase().replace(/\./g, '').trim();
  const map = {
    g: 'g', gr: 'g', gram: 'g', grams: 'g', grs: 'g',
    oz: 'oz', ounce: 'oz', ounces: 'oz',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', mls: 'ml',
    'fl oz': 'floz', floz: 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
    cup: 'cup', cups: 'cup', c: 'cup',
    tbsp: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp',
    tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
    l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  };
  return map[t] ?? (UNITS[t] ? t : null);
}

// Local calendar date as YYYY-MM-DD.
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
}
