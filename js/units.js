// Unit conversion + nutrition scaling. Pure functions, no DOM.

// Base units: grams for weight, millilitres for volume (US measures).
// Count units ("slice", "scoop", ...) only convert to themselves.
export const UNITS = {
  g:         { label: 'g',         kind: 'mass',   factor: 1 },
  oz:        { label: 'oz',        kind: 'mass',   factor: 28.349523125 },
  lb:        { label: 'lb',        kind: 'mass',   factor: 453.59237 },
  kg:        { label: 'kg',        kind: 'mass',   factor: 1000 },
  tsp:       { label: 'tsp',       kind: 'volume', factor: 4.92892159375 },
  tbsp:      { label: 'tbsp',      kind: 'volume', factor: 14.78676478125 },
  floz:      { label: 'fl oz',     kind: 'volume', factor: 29.5735295625 },
  cup:       { label: 'cup',       kind: 'volume', factor: 236.5882365, plural: 'cups' },
  pint:      { label: 'pint',      kind: 'volume', factor: 473.176473, plural: 'pints' },
  quart:     { label: 'quart',     kind: 'volume', factor: 946.352946, plural: 'quarts' },
  gallon:    { label: 'gallon',    kind: 'volume', factor: 3785.411784, plural: 'gallons' },
  ml:        { label: 'ml',        kind: 'volume', factor: 1 },
  l:         { label: 'L',         kind: 'volume', factor: 1000 },
  piece:     { label: 'piece',     kind: 'count',  factor: 1, plural: 'pieces' },
  slice:     { label: 'slice',     kind: 'count',  factor: 1, plural: 'slices' },
  scoop:     { label: 'scoop',     kind: 'count',  factor: 1, plural: 'scoops' },
  bar:       { label: 'bar',       kind: 'count',  factor: 1, plural: 'bars' },
  can:       { label: 'can',       kind: 'count',  factor: 1, plural: 'cans' },
  bottle:    { label: 'bottle',    kind: 'count',  factor: 1, plural: 'bottles' },
  packet:    { label: 'packet',    kind: 'count',  factor: 1, plural: 'packets' },
  container: { label: 'container', kind: 'count',  factor: 1, plural: 'containers' },
};

export const KIND_LABELS = { mass: 'Weight', volume: 'Volume', count: 'Count' };

// Always available: "serving" means one of the food's own serving size.
export const SERVING = 'serving';

// Plural only above 1 (and for 0): "⅔ cup", "½ serving", "1½ servings".
export function unitLabel(unit, amount = 1) {
  const n = Number(amount);
  const many = n > 1 || n === 0;
  if (unit === SERVING) return many ? 'servings' : 'serving';
  const u = UNITS[unit];
  if (!u) return unit;
  return many && u.plural ? u.plural : u.label;
}

// Can an amount in unit `a` be converted to unit `b`?
export function convertible(a, b) {
  const ua = UNITS[a];
  const ub = UNITS[b];
  if (!ua || !ub) return false;
  if (ua.kind === 'count' || ub.kind === 'count') return a === b;
  return ua.kind === ub.kind;
}

// What one serving of a food equals: its serving size, plus an optional second
// measure of a different kind (e.g. "2 tbsp" and "32 g"), as [amount, unit] pairs.
export function servingMeasures(food) {
  const out = [];
  if (UNITS[food.servingUnit]) out.push([Number(food.servingAmount), food.servingUnit]);
  const a2 = Number(food.servingAmount2);
  const u2 = food.servingUnit2;
  if (UNITS[u2] && a2 > 0 && !out.some(([, u]) => convertible(u, u2))) out.push([a2, u2]);
  return out;
}

// Units a food can be logged in.
export function compatibleUnits(food) {
  const units = [SERVING];
  for (const [, servingUnit] of servingMeasures(food)) {
    for (const u of Object.keys(UNITS)) {
      if (convertible(u, servingUnit) && !units.includes(u)) units.push(u);
    }
  }
  return units;
}

// How many servings of `food` is `amount` of `unit`?
export function toServings(amount, unit, food) {
  amount = Number(amount);
  if (!isFinite(amount) || amount < 0) return 0;
  if (unit === SERVING) return amount;
  const measure = servingMeasures(food).find(([, u]) => convertible(unit, u));
  if (!measure) throw new Error(`Can't measure this food in ${unitLabel(unit)}`);
  const [servingAmount, servingUnit] = measure;
  if (!(servingAmount > 0)) throw new Error('Serving size must be greater than 0');
  return (amount * UNITS[unit].factor) / (servingAmount * UNITS[servingUnit].factor);
}

const round1 = (n) => Math.round(n * 10) / 10;

// Per-serving nutrient fields on a food. Sodium is in mg, everything else in g (calories in kcal).
const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];
// Calories and sodium are whole numbers; grams keep one decimal.
const roundFor = (key, n) => (key === 'calories' || key === 'sodium' ? Math.round(n) : round1(n));

// Nutrition for a portion of a food. Foods saved before fiber/sugar/sodium existed count those as 0.
export function nutritionFor(food, amount, unit) {
  const s = toServings(amount, unit, food);
  return Object.fromEntries(NUTRIENTS.map((k) => [k, roundFor(k, (Number(food[k]) || 0) * s)]));
}

export function sumNutrition(entries) {
  return Object.fromEntries(NUTRIENTS.map((k) => [k, roundFor(k, entries.reduce((sum, e) => sum + (Number(e[k]) || 0), 0))]));
}

// "0.6667 cup" reads better as "⅔ cup". Metric amounts stay as decimals.
const FRACTIONS = [[1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾']];
export function formatAmount(n, unit) {
  n = Number(n) || 0;
  if (!['g', 'kg', 'ml', 'l'].includes(unit)) {
    const whole = Math.floor(n);
    const frac = FRACTIONS.find(([v]) => Math.abs(n - whole - v) < 0.01);
    if (frac) return whole ? `${whole}${frac[1]}` : frac[1];
  }
  return String(Math.round(n * 100) / 100);
}

// Map loose unit text (from a label or user) to a unit key.
const UNIT_WORDS = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g', grs: 'g',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbs: 'tbsp', tbsps: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  'fl oz': 'floz', floz: 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
  cup: 'cup', cups: 'cup', c: 'cup',
  pint: 'pint', pints: 'pint', pt: 'pint', pts: 'pint',
  quart: 'quart', quarts: 'quart', qt: 'quart', qts: 'quart',
  gallon: 'gallon', gallons: 'gallon', gal: 'gallon',
  ml: 'ml', mls: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece',
  slice: 'slice', slices: 'slice',
  scoop: 'scoop', scoops: 'scoop',
  bar: 'bar', bars: 'bar',
  can: 'can', cans: 'can',
  bottle: 'bottle', bottles: 'bottle',
  packet: 'packet', packets: 'packet', pkt: 'packet', pouch: 'packet', pouches: 'packet', sachet: 'packet',
  package: 'packet', pkg: 'packet',
  container: 'container', containers: 'container', cont: 'container',
};
export function normalizeUnit(text) {
  const t = String(text || '').toLowerCase().replace(/\./g, '').trim();
  return UNIT_WORDS[t] ?? (UNITS[t] ? t : null);
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
