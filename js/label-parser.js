// Turns raw OCR text from a nutrition label into { name?, calories, protein, carbs, fat, servingAmount, servingUnit }.
// Every field may be null if it couldn't be found — the user always reviews the result before saving.
import { normalizeUnit } from './units.js';

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

// Fix the most common OCR confusions inside numbers ("O" for 0, "l"/"I" for 1, "S" for 5 next to digits).
function cleanLine(line) {
  return line
    .replace(/(?<=\d)[oO](?=\s*(?:g|mg|%|\d|\b))/g, '0')
    .replace(/\b[oO](?=\s*(?:g|mg)\b)/g, '0')
    .replace(/(?<=\d)[lI|](?=\d|\s*g\b)/g, '1')
    .replace(/\b[lI|](?=\d)/g, '1')
    .replace(/(?<=\d),(?=\d{3}\b)/g, '') // 1,200 -> 1200
    .replace(/\s+/g, ' ')
    .trim();
}

const toNum = (s) => parseFloat(String(s).replace(',', '.'));

// Parse "2/3", "1 1/2", "1.5", "½" into a number.
function parseQuantity(s) {
  s = s.trim().replace('½', ' 1/2').replace('⅓', ' 1/3').replace('⅔', ' 2/3').replace('¼', ' 1/4').replace('¾', ' 3/4').trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = toNum(s);
  return isFinite(n) ? n : null;
}

// Grams value after a keyword, e.g. "Total Fat 8g 10%". Handles "g" being misread as "9" ("8g" -> "89").
function gramsAfter(lines, keyword, exclude) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const km = line.match(keyword);
    if (!km || (exclude && exclude.test(line))) continue;
    // Look at the rest of this line; if nothing there, peek at the next line (columns sometimes split).
    const candidates = [line.slice(km.index + km[0].length)];
    if (lines[i + 1]) candidates.push(lines[i + 1]);
    for (const rest of candidates) {
      const withUnit = rest.match(new RegExp(`${NUM}\\s*(m?g)\\b`, 'i'));
      if (withUnit) {
        const v = toNum(withUnit[1]);
        return withUnit[2].toLowerCase() === 'mg' ? v / 1000 : v;
      }
      const bare = rest.match(new RegExp(`^\\s*[:\\-]?\\s*${NUM}(?!\\s*%)`));
      if (bare) {
        const raw = bare[1];
        // "89" with no unit anywhere is very likely "8g".
        if (/^\d+9$/.test(raw) && !/\dg/i.test(rest)) return toNum(raw.slice(0, -1));
        return toNum(raw);
      }
    }
  }
  return null;
}

function findCalories(lines, text) {
  for (let i = 0; i < lines.length; i++) {
    // Drop "Calories from Fat 70" / "Fat Cal. 70" so they don't get mistaken for the total.
    const line = lines[i].replace(/calor\w*\s*from\s*fat.*|fat\s*cal.*/i, '');
    if (!/calor/i.test(line)) continue;
    const after = line.slice(line.search(/calor/i)).replace(/^calor\w*/i, '');
    const m = after.match(/\d+/) || (lines[i + 1] && /^\s*\d+\s*$/.test(lines[i + 1]) && lines[i + 1].match(/\d+/));
    if (m) return Number(m[0]);
  }
  // EU / international: "Energy 1046 kJ / 250 kcal"
  const kcal = text.match(/(\d+(?:[.,]\d+)?)\s*kcal/i);
  if (kcal) return Math.round(toNum(kcal[1]));
  const kj = text.match(/(\d+(?:[.,]\d+)?)\s*kj/i);
  if (kj) return Math.round(toNum(kj[1]) / 4.184);
  return null;
}

function findServing(lines, text) {
  const line = lines.find((l) => /serv\w*\s*size|serving\s*:|portion/i.test(l));
  if (line) {
    const rest = line.replace(/.*?(serv\w*\s*size|serving\s*:|portion)\s*:?/i, '');
    // Prefer metric value in parentheses: "2/3 cup (55g)".
    const metric = rest.match(new RegExp(`\\(?\\s*(?:about\\s*)?${NUM}\\s*(g|grams?|ml|mL)\\b`, 'i'));
    if (metric) return { servingAmount: toNum(metric[1]), servingUnit: normalizeUnit(metric[2]) };
    // "(559)" is almost always "(55g)" with the g misread as 9.
    const misread = rest.match(/\(\s*(\d+)9\s*\)/);
    if (misread) return { servingAmount: Number(misread[1]), servingUnit: 'g' };
    const qty = rest.match(/((?:\d+\s+)?\d+\/\d+|\d+(?:[.,]\d+)?|[½⅓⅔¼¾])\s*([a-zA-Z][a-zA-Z .]*)/);
    if (qty) {
      const unitWord = qty[2].trim().split(/\s+/).slice(0, 2);
      const unit = normalizeUnit(unitWord.join(' ')) || normalizeUnit(unitWord[0]);
      const amount = parseQuantity(qty[1]);
      if (amount) return { servingAmount: amount, servingUnit: unit || 'piece' };
    }
  }
  const per = text.match(/per\s*(\d+)\s*(g|ml)\b/i);
  if (per) return { servingAmount: Number(per[1]), servingUnit: normalizeUnit(per[2]) };
  return { servingAmount: null, servingUnit: null };
}

export function parseNutritionLabel(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  const text = lines.join('\n');

  return {
    calories: findCalories(lines, text),
    fat: gramsAfter(lines, /total\s*fat|^fat\b|\bfat\b(?!\s*cal)/i, /saturated|trans|sat\.|poly|mono|from\s*fat/i),
    carbs: gramsAfter(lines, /total\s*carb\w*\.?|carbohydrate\w*|carbs\b/i, /of\s*which/i),
    protein: gramsAfter(lines, /prote\w*/i),
    ...findServing(lines, text),
  };
}
