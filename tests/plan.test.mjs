import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  restingCalories, maintenance, trendAt, goalProgress, calorieTarget, daysBetween, addDays, suggestedExtras,
  kgToLb, lbToKg, cmFromFeetInches, feetInchesFromCm,
} from '../js/plan.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const profile = { sex: 'male', age: 30, heightCm: 180, activity: 'moderate' };

test('resting calories: Mifflin-St Jeor by sex, Katch-McArdle with body fat', () => {
  close(restingCalories(profile, 80).kcal, 1780); // 800 + 1125 - 150 + 5
  close(restingCalories({ ...profile, sex: 'female' }, 80).kcal, 1614);
  close(restingCalories({ ...profile, sex: 'other' }, 80).kcal, 1697);
  const katch = restingCalories({}, 80, 20); // lean mass 64 kg; no age/height needed
  assert.equal(katch.method, 'katch');
  close(katch.kcal, 1752.4);
  assert.equal(restingCalories({ sex: 'male' }, 80), null); // missing age/height and no body fat
});

test('maintenance multiplies by activity', () => {
  const m = maintenance(profile, 80);
  close(m.calories, 1780 * 1.55);
  assert.equal(m.activity.key, 'moderate');
  assert.equal(maintenance({ ...profile, activity: undefined }, 80), null);
});

test('trend weight is the 7-day average, body fat the latest in 30 days', () => {
  const ws = [
    { date: '2026-10-01', kg: 82, bodyFat: 24 },
    { date: '2026-11-01', kg: 80, bodyFat: 22 },
    { date: '2026-11-05', kg: 79 },
    { date: '2026-11-07', kg: 78.5 },
  ];
  close(trendAt(ws, '2026-11-07').kg, (80 + 79 + 78.5) / 3);
  close(trendAt(ws, '2026-11-10').kg, (79 + 78.5) / 2);
  assert.equal(trendAt(ws, '2026-11-10').bodyFat, 22);
  assert.equal(trendAt(ws, '2026-12-15').bodyFat, null); // too old
  assert.equal(trendAt(ws, '2026-12-15').kg, 78.5); // latest weigh-in when the week is empty
  assert.equal(trendAt(ws, '2026-09-30'), null);
});

test('goal progress: plan, needed rate and status', () => {
  const goal = { startKg: 90, startDate: '2026-11-01', targetKg: 85, targetDate: '2026-12-01' }; // 30 days
  const onTrack = goalProgress(goal, 87.5, '2026-11-16');
  close(onTrack.planPerDay, -5 / 30);
  close(onTrack.expectedKg, 87.5);
  assert.equal(onTrack.status, 'on-track');
  assert.equal(onTrack.daysLeft, 15);
  const behind = goalProgress(goal, 88.5, '2026-11-16');
  assert.equal(behind.status, 'behind');
  close(behind.neededPerDay, (85 - 88.5) / 15);
  assert.equal(goalProgress(goal, 86.5, '2026-11-16').status, 'ahead');
  assert.equal(goalProgress(goal, 84.9, '2026-11-16').status, 'reached');
  assert.equal(goalProgress(goal, 86, '2026-12-03').status, 'overdue');
  const gain = { startKg: 60, startDate: '2026-11-01', targetKg: 63, targetDate: '2026-12-31' };
  assert.equal(goalProgress(gain, 60.2, '2026-12-01').status, 'behind'); // should be ~61.5 by now
});

test('calorie target with safety limits', () => {
  const normal = calorieTarget(2500, -0.5, 80, 'male');
  assert.equal(normal.calories, 1950); // 2500 - 550
  assert.equal(normal.limited, false);
  const fast = calorieTarget(2500, -2, 80, 'male'); // more than 1% of 80 kg a week
  assert.equal(fast.limited, true);
  assert.equal(fast.calories, 1620); // 2500 - 0.8 * 1100
  const floored = calorieTarget(1500, -0.8, 60, 'female');
  assert.equal(floored.floored, true);
  assert.equal(floored.calories, 1200);
  close(floored.perWeekKg, ((1200 - 1500) * 7) / 7700);
  assert.equal(calorieTarget(1100, -0.5, 45, 'female').calories, 1100); // never above maintenance to lose
  assert.equal(calorieTarget(2500, 1, 70, 'male').calories, 2890); // gain capped at 0.35 kg/week
  assert.equal(calorieTarget(2345, 0, 80, 'male').calories, 2350); // maintenance, rounded
});

test('dates and units', () => {
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2); // across a DST change
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  close(kgToLb(1), 2.20462);
  close(lbToKg(220.462), 100);
  close(cmFromFeetInches(5, 10), 177.8);
  assert.deepEqual(feetInchesFromCm(177.8), { ft: 5, inches: 10 });
  assert.deepEqual(feetInchesFromCm(182.88), { ft: 6, inches: 0 });
});

test('suggested sodium, sugar and fiber', () => {
  // from the plan's calories
  assert.deepEqual(suggestedExtras({ calories: 2000, age: 35, sex: 'male' }), { sodium: 2300, sugar: 50, fiber: 28 });
  assert.deepEqual(suggestedExtras({ calories: 2600, age: 35, sex: 'male' }), { sodium: 2300, sugar: 65, fiber: 36 });
  assert.deepEqual(suggestedExtras({ calories: 1600, age: 60, sex: 'female' }), { sodium: 2300, sugar: 40, fiber: 22 });
  // sodium only changes by age
  assert.equal(suggestedExtras({ calories: 2200, age: 13 }).sodium, 1800);
  assert.equal(suggestedExtras({ calories: 1400, age: 80 }).sodium, 2300);
  // no calories yet: fiber by age and sex, sugar 50 g
  assert.deepEqual(suggestedExtras({ age: 30, sex: 'male' }), { sodium: 2300, sugar: 50, fiber: 38 });
  assert.deepEqual(suggestedExtras({ age: 55, sex: 'female' }), { sodium: 2300, sugar: 50, fiber: 21 });
  assert.deepEqual(suggestedExtras({}), { sodium: 2300, sugar: 50, fiber: 28 });
});
