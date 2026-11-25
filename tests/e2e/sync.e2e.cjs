// End-to-end test of cloud sync against the Firebase emulators: two "phones" on one account,
// live updates, deletes, offline changes, security rules, sign-out, and upgrading old data.
//
//   npm run test:sync
//
// Needs Playwright with Chromium installed (require('playwright') must work).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const target = file.endsWith(path.sep) ? path.join(file, 'index.html') : file;
  if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

let APP;
let ORIGIN;
const AUTH = 'http://127.0.0.1:9099';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-ssct/databases/(default)/documents';
const EMAIL = 'sam@example.com';
const PW = 'correct-horse-1';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
};

async function device(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return { ctx, page };
}

const total = (page) => page.textContent('#sumCalories');
const waitTotal = (page, v, timeout = 20000) =>
  page.waitForFunction((x) => document.querySelector('#sumCalories').textContent === x, v, { timeout });
const waitStatus = (page, status, timeout = 20000) =>
  page.waitForSelector(`#syncStatus[data-status="${status}"]`, { state: 'attached', timeout });

async function createFood(page, f) {
  await page.click('.tabs [data-view=foods]');
  await page.click('#newFoodBtn');
  if (f.emoji) {
    await page.click('#emojiBtn');
    await page.click(`#emojiGrid .cell[data-emoji="${f.emoji}"]`);
  }
  const q = '#foodForm ';
  await page.fill(q + '[name=name]', f.name);
  await page.fill(q + '[name=servingAmount]', String(f.servingAmount));
  await page.selectOption(q + '[name=servingUnit]', f.servingUnit);
  await page.fill(q + '[name=calories]', String(f.calories));
  await page.fill(q + '[name=protein]', String(f.protein));
  await page.fill(q + '[name=carbs]', String(f.carbs));
  await page.fill(q + '[name=fat]', String(f.fat));
  await page.click('#foodSubmitBtn');
  await page.waitForSelector('#foodDialog', { state: 'hidden' });
}

async function logFood(page, name, servings) {
  await page.click('.tabs [data-view=today]');
  await page.click('#fab');
  await page.fill('#addSearch', name);
  await page.click('#addList li');
  if (servings) {
    await page.selectOption('#portionForm [name=unit]', 'serving');
    await page.fill('#portionForm [name=amount]', String(servings));
  }
  await page.click('#portionSubmitBtn');
  await page.waitForSelector('#portionDialog', { state: 'hidden' });
}

async function account(page, email, pw, action) {
  await page.click('.tabs [data-view=settings]');
  await page.waitForSelector('#authForm', { state: 'visible', timeout: 20000 });
  await page.fill('#authForm [name=email]', email);
  await page.fill('#authForm [name=password]', pw);
  await page.click(`#authForm button[value=${action}]`);
}

async function adminList(path) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  return (await r.json()).documents || [];
}

(async () => {
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  ORIGIN = `http://localhost:${server.address().port}`;
  APP = `${ORIGIN}/?emulator`;
  const browser = await chromium.launch();

  // ---------- Device A: data from before signing in ----------
  const A = await device(browser, 'A');
  await A.page.goto(APP);
  await createFood(A.page, { name: 'Oats', emoji: '🥣', servingAmount: 40, servingUnit: 'g', calories: 150, protein: 5, carbs: 27, fat: 3 });
  await logFood(A.page, 'Oats');
  check(await total(A.page) === '150', 'A logged 150 kcal before signing in');
  await A.page.click('.tabs [data-view=goals]');
  await A.page.fill('#goalCalories', '2000');
  await A.page.click('.tabs [data-view=settings]');
  check(await A.page.isVisible('#accountCard'), 'account card shown when Firebase is configured');

  // ---------- A creates an account: local data goes up ----------
  await account(A.page, EMAIL, PW, 'signup');
  await waitStatus(A.page, 'synced');
  check((await A.page.textContent('#accountEmail')) === EMAIL, 'A signed in');
  const uidA = await A.page.evaluate(() => JSON.parse(localStorage.getItem('ssct-sync')).uid);
  const foodsInAccount = await adminList(`users/${uidA}/foods`);
  const entriesInAccount = await adminList(`users/${uidA}/entries`);
  const settingsDoc = await (await fetch(`${FS}/users/${uidA}/settings/main`, { headers: { Authorization: 'Bearer owner' } })).json();
  check(foodsInAccount.length === 1 && foodsInAccount[0].fields.name.stringValue === 'Oats', 'food uploaded to Firestore');
  check(entriesInAccount.length === 1, 'entry uploaded to Firestore');
  check(settingsDoc.fields?.goals?.mapValue?.fields?.calories?.integerValue === '2000', 'goals uploaded to Firestore');
  check(!JSON.stringify(foodsInAccount).includes('"dirty"'), 'internal "dirty" flag not uploaded');

  // ---------- Device B signs in: gets everything ----------
  const B = await device(browser, 'B');
  await B.page.goto(APP);
  await account(B.page, EMAIL, PW, 'signin');
  await waitStatus(B.page, 'synced');
  await B.page.click('.tabs [data-view=today]');
  await waitTotal(B.page, '150');
  check(true, 'B downloaded the entry (150 kcal)');
  check(await B.page.isVisible('#meter-protein'), 'B downloaded the goals (meters shown)');
  await B.page.click('.tabs [data-view=foods]');
  const bFoods = await B.page.waitForFunction(() => {
    const text = document.querySelector('#foodList').textContent;
    return text.includes('Oats') && text.replace(/\s+/g, ' ');
  }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => '');
  check(bFoods.includes('🥣') && bFoods.includes('Oats'), 'B downloaded the food with its emoji');

  // ---------- Live: B logs, A sees it without reloading ----------
  await logFood(B.page, 'Oats', 2);
  await A.page.click('.tabs [data-view=today]');
  await waitTotal(A.page, '450');
  check(true, "A sees B's new entry live (450 kcal)");

  // ---------- Live delete: A removes B's entry, B sees it ----------
  await A.page.click('#entryList li:nth-child(2)');
  await A.page.click('#deleteEntryBtn');
  await waitTotal(A.page, '150');
  await waitTotal(B.page, '150');
  check(true, 'delete on A reached B');

  // ---------- Offline: A logs while offline, uploads once back online ----------
  await A.ctx.setOffline(true);
  await logFood(A.page, 'Oats');
  check(await total(A.page) === '300', 'A works offline (300 kcal)');
  await A.page.click('.tabs [data-view=settings]');
  await waitStatus(A.page, 'offline');
  console.log('   A offline status:', await A.page.textContent('#syncStatus'));
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitStatus(A.page, 'synced', 30000);
  await waitTotal(B.page, '300', 30000);
  check(true, "A's offline entry reached B after reconnecting");

  // ---------- Weights, profile and weight goal sync too ----------
  await A.page.click('.tabs [data-view=today]');
  await A.page.click('#fab');
  await A.page.click('#logWeightBtn');
  await A.page.selectOption('#weightForm [name=unit]', 'lb');
  await A.page.fill('#weightForm [name=weight]', '182.4');
  await A.page.fill('#weightForm [name=bodyFat]', '21');
  await A.page.click('#weightForm button[type=submit]');
  await A.page.click('.tabs [data-view=goals]');
  await A.page.fill('#profileForm [name=age]', '35');
  await A.page.fill('#weightGoalForm [name=target]', '175');
  const later = new Date(Date.now() + 60 * 86400000);
  const laterKey = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
  await A.page.fill('#weightGoalForm [name=date]', laterKey);
  await A.page.click('#saveGoalBtn');
  await B.page.click('.tabs [data-view=today]');
  const weightOnB = await B.page.waitForFunction(() => document.querySelector('#entryList li[data-weight]')?.textContent.includes('182.4'), null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  check(weightOnB, "A's weigh-in reached B");
  await B.page.click('.tabs [data-view=goals]');
  const profileOnB = await B.page.waitForFunction((d) => document.querySelector('#profileForm [name=age]').value === '35'
    && document.querySelector('#weightGoalForm [name=date]').value === d, laterKey, { timeout: 20000 }).then(() => true).catch(() => false);
  check(profileOnB, "A's profile and weight goal reached B");
  // sodium / sugar / fiber: switch and goal
  await A.page.fill('#goal-fiber', '33');
  await A.page.click('.tabs [data-view=settings]');
  await A.page.click('label:has([data-extra-toggle=fiber])');
  await B.page.click('.tabs [data-view=settings]');
  const extrasOnB = await B.page.waitForFunction(() => document.querySelector('[data-extra-toggle=fiber]').checked, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  await B.page.click('.tabs [data-view=goals]');
  const fiberGoalOnB = await B.page.waitForFunction(() => document.querySelector('#goal-fiber').value === '33', null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  check(extrasOnB && fiberGoalOnB, "A's fiber switch and goal reached B");

  // ---------- Security rules: another user can't read A's data ----------
  const signUp = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'other@example.com', password: 'other-pass-1', returnSecureToken: true }),
  })).json();
  const asOther = await fetch(`${FS}/users/${uidA}/foods`, { headers: { Authorization: `Bearer ${signUp.idToken}` } });
  const asNobody = await fetch(`${FS}/users/${uidA}/foods`);
  const ownData = await fetch(`${FS}/users/${signUp.localId}/foods`, { headers: { Authorization: `Bearer ${signUp.idToken}` } });
  check(asOther.status === 403, `another user is refused (${asOther.status})`);
  check(asNobody.status === 403, `signed-out request is refused (${asNobody.status})`);
  check(ownData.status === 200, `a user can read their own data (${ownData.status})`);

  // ---------- Sign out wipes the device; signing back in restores it ----------
  await A.page.click('.tabs [data-view=settings]');
  await A.page.click('#signOutBtn');
  await A.page.waitForSelector('#authForm', { state: 'visible' });
  await A.page.click('.tabs [data-view=today]');
  await waitTotal(A.page, '0');
  check(true, "sign-out removed this device's copy");
  await account(A.page, EMAIL, 'wrong-password', 'signin');
  await A.page.waitForSelector('#authMessage:not([hidden])');
  check((await A.page.textContent('#authMessage')) === 'Wrong email or password.', 'wrong password message');
  await account(A.page, EMAIL, PW, 'signin');
  await waitStatus(A.page, 'synced');
  await A.page.click('.tabs [data-view=today]');
  await waitTotal(A.page, '300');
  check(true, 'signing back in restored the data');

  // ---------- Reload keeps you signed in ----------
  await B.page.reload();
  await waitTotal(B.page, '300');
  await B.page.click('.tabs [data-view=settings]');
  await waitStatus(B.page, 'synced');
  check(true, 'B still signed in and synced after reload');

  // ---------- Upgrade: data saved by the first version of the app ----------
  const C = await device(browser, 'C');
  await C.page.goto(`${ORIGIN}/icons/icon.svg`);
  await C.page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('ssct', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('foods', { keyPath: 'id' });
      req.result.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date');
    };
    req.onsuccess = () => {
      const t = req.result.transaction('foods', 'readwrite');
      t.objectStore('foods').put({ id: 'old-1', name: 'Old toast', servingAmount: 1, servingUnit: 'piece', calories: 80, protein: 3, carbs: 15, fat: 1, defaultAmount: 1, defaultUnit: 'serving', createdAt: 1700000000000 });
      t.oncomplete = () => { req.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  }));
  await C.page.evaluate(() => localStorage.setItem('ssct-settings', JSON.stringify({ goal: 1800, proteinGoal: 120 })));
  await C.page.goto(APP);
  await C.page.click('.tabs [data-view=foods]');
  const upgraded = await C.page.waitForFunction(() => document.querySelector('#foodList').textContent.includes('Old toast'), null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(upgraded, 'v1 data still readable after upgrade');
  await account(C.page, 'new@example.com', 'new-pass-1', 'signup');
  await waitStatus(C.page, 'synced');
  const uidC = await C.page.evaluate(() => JSON.parse(localStorage.getItem('ssct-sync')).uid);
  const cFoods = await adminList(`users/${uidC}/foods`);
  check(cFoods.length === 1 && cFoods[0].fields.name.stringValue === 'Old toast', 'v1 data uploaded on first sign-in');
  await C.page.click('.tabs [data-view=goals]');
  const oldGoal = await C.page.waitForFunction(() => document.querySelector('#goalCalories').value === '1800', null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check(oldGoal, 'old calorie goal carried over (1800)');

  const errors = [...A.page.errors, ...B.page.errors, ...C.page.errors];
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
  await browser.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
