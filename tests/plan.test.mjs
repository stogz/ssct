import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  restingCalories, maintenance, trendAt, bodyFatAt, goalProgress, calorieTarget, daysBetween, addDays, suggestedExtras,
  normalizeGoal, goalRecord, goalStart, weightTolerance, BODY_FAT_TOLERANCE, weightAtBodyFat,
  kgToLb, lbToKg, cmFromFeetInches, feetInchesFromCm,
} from '../js/plan.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const profile = { sex: 'male', age: 30, heightCm: 180, activity: 'moderate' };

test('resting calories: Mifflin-St Jeor by sex, Katch-McArdle with body fat', () => {
  close(restingCalories(profile, 80).kcal, 1780); // 800 + 1125 - 150 + 5
  close(restingCalories({ ...profile, sex: 'female' }, 80).kcal, 1614);
  const katch = restingCalories({}, 80, 20); // lean mass 64 kg; no sex, age or height needed
  assert.equal(katch.method, 'katch');
  close(katch.kcal, 1752.4);
  assert.equal(restingCalories({ sex: 'male' }, 80), null); // missing age/height and no body fat
  // Mifflin-St Jeor needs male or female ("Other" was a choice once)
  assert.equal(restingCalories({ ...profile, sex: undefined }, 80), null);
  assert.equal(restingCalories({ ...profile, sex: 'other' }, 80), null);
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

test('body fat is smoothed like weight', () => {
  const ws = [
    { date: '2026-10-01', kg: 82, bodyFat: 24 },
    { date: '2026-11-03', kg: 80, bodyFat: 22.4 },
    { date: '2026-11-05', kg: 79, bodyFat: 21.6 },
    { date: '2026-11-07', kg: 78.5 },
  ];
  close(bodyFatAt(ws, '2026-11-07').pct, 22); // the readings in the week
  assert.equal(bodyFatAt(ws, '2026-11-07').lastDate, '2026-11-05');
  close(trendAt(ws, '2026-11-07').bodyFat, 22);
  assert.equal(bodyFatAt(ws, '2026-10-20').pct, 24); // none that week: the latest reading, however old
  assert.equal(trendAt(ws, '2026-10-20').bodyFat, 24); // still within 30 days
  assert.equal(bodyFatAt(ws, '2026-12-31').pct, 21.6);
  assert.equal(trendAt(ws, '2026-12-31').bodyFat, null); // too old for the calorie estimate
  assert.equal(bodyFatAt(ws, '2026-09-30'), null);
});

test('goal progress: plan, needed rate and status', () => {
  const goal = { start: 90, startDate: '2026-11-01', target: 85, targetDate: '2026-12-01' }; // 30 days
  const tol = weightTolerance(87.5);
  const onTrack = goalProgress(goal, 87.5, '2026-11-16', tol);
  close(onTrack.planPerDay, -5 / 30);
  close(onTrack.expected, 87.5);
  assert.equal(onTrack.status, 'on-track');
  assert.equal(onTrack.daysLeft, 15);
  const behind = goalProgress(goal, 88.5, '2026-11-16', tol);
  assert.equal(behind.status, 'behind');
  close(behind.neededPerDay, (85 - 88.5) / 15);
  assert.equal(goalProgress(goal, 86.5, '2026-11-16', tol).status, 'ahead');
  assert.equal(goalProgress(goal, 84.9, '2026-11-16', tol).status, 'reached');
  assert.equal(goalProgress(goal, 86, '2026-12-03', tol).status, 'overdue');
  const gain = { start: 60, startDate: '2026-11-01', target: 63, targetDate: '2026-12-31' };
  assert.equal(goalProgress(gain, 60.2, '2026-12-01', weightTolerance(60.2)).status, 'behind'); // should be ~61.5 by now
  // body fat, in percentage points
  const bf = { start: 25, startDate: '2026-11-01', target: 18, targetDate: '2027-01-10' }; // 70 days, 0.1 a day
  assert.equal(goalProgress(bf, 21.7, '2026-12-06', BODY_FAT_TOLERANCE).status, 'on-track'); // plan says 21.5
  assert.equal(goalProgress(bf, 22.2, '2026-12-06', BODY_FAT_TOLERANCE).status, 'behind');
  assert.equal(goalProgress(bf, 20.8, '2026-12-06', BODY_FAT_TOLERANCE).status, 'ahead');
  close(goalProgress(bf, 22.2, '2026-12-06', BODY_FAT_TOLERANCE).neededPerDay, (18 - 22.2) / 35);
});

test('saved goals: weight goals keep their old shape, body fat goals are new', () => {
  const old = { startKg: 93, startDate: '2026-11-01', targetKg: 85, targetDate: '2027-02-01' }; // saved before body fat goals
  assert.deepEqual(normalizeGoal(old), { metric: 'weight', start: 93, target: 85, startDate: '2026-11-01', targetDate: '2027-02-01' });
  const bf = { metric: 'bodyFat', start: 25, target: 18, startDate: '2026-11-01', targetDate: '2027-02-01' };
  assert.deepEqual(goalRecord(bf), { metric: 'bodyFat', startDate: '2026-11-01', targetDate: '2027-02-01', startPct: 25, targetPct: 18 });
  assert.deepEqual(normalizeGoal(goalRecord(bf)), bf);
  assert.deepEqual(goalRecord(normalizeGoal(old)), { metric: 'weight', ...old });
  assert.equal(normalizeGoal(undefined), null);
  assert.equal(normalizeGoal({ metric: 'bodyFat', startKg: 90, targetKg: 80, startDate: '2026-11-01', targetDate: '2027-02-01' }), null);
});

test('a goal starts from the 7-day average on its start date', () => {
  // The user's case: the goal was set with only today's weigh-in, then earlier ones were added.
  const lb = (x) => x * 0.45359237;
  const goal = { metric: 'weight', start: lb(203.2), target: lb(185), startDate: '2026-11-25', targetDate: '2027-02-23' };
  const ws = [
    { date: '2026-11-19', kg: lb(207.4) },
    { date: '2026-11-21', kg: lb(206.5) },
    { date: '2026-11-23', kg: lb(204.1) },
    { date: '2026-11-25', kg: lb(203.2) },
    { date: '2026-11-26', kg: lb(202.9) }, // after the start: doesn't move it
  ];
  close(goalStart(goal, ws), lb(205.3), 0.001);
  const today = { ...goal, start: goalStart(goal, ws) };
  const current = trendAt(ws.slice(0, 4), '2026-11-25').kg;
  assert.equal(goalProgress(today, current, '2026-11-25', weightTolerance(current)).status, 'on-track');
  // body fat goals use the body fat average
  const bfGoal = { metric: 'bodyFat', start: 30, target: 22, startDate: '2026-11-25', targetDate: '2027-02-23' };
  close(goalStart(bfGoal, [{ date: '2026-11-24', kg: 90, bodyFat: 26 }, { date: '2026-11-25', kg: 90, bodyFat: 25 }]), 25.5);
  // no weigh-ins that far back: the saved start
  assert.equal(goalStart(goal, [{ date: '2026-12-01', kg: 90 }]), lb(203.2));
  assert.equal(goalStart(bfGoal, [{ date: '2026-11-25', kg: 90 }]), 30);
});

test('the weight you would be at a body fat goal, keeping lean mass', () => {
  close(weightAtBodyFat(100, 25, 18), 75 / 0.82); // 75 kg lean
  close(weightAtBodyFat(80, 30, 30), 80);
  assert.ok(weightAtBodyFat(60, 15, 18) > 60); // gaining body fat means gaining weight
});

test('calorie target follows any pace, above a minimum', () => {
  const normal = calorieTarget(2500, -0.5, 'male');
  assert.equal(normal.calories, 1950); // 2500 - 550
  assert.equal(normal.floored, false);
  assert.equal(calorieTarget(3000, -1, 'male').calories, 1900); // 1 kg a week: faster than 1% of most people's weight, not capped
  const floored = calorieTarget(1500, -0.8, 'female');
  assert.equal(floored.floored, true);
  assert.equal(floored.calories, 1200);
  close(floored.perWeekKg, ((1200 - 1500) * 7) / 7700);
  assert.equal(calorieTarget(2500, -1.5, 'male').calories, 1500); // the minimum for men
  assert.equal(calorieTarget(2000, -1, undefined).calories, 1200); // sex not set (body fat known): 1,200
  assert.equal(calorieTarget(1100, -0.5, 'female').calories, 1100); // never above maintenance to lose
  assert.equal(calorieTarget(2500, 1, 'male').calories, 3600); // gaining isn't capped either
  assert.equal(calorieTarget(2345, 0, 'male').calories, 2350); // maintenance, rounded
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
