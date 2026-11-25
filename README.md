# Stupidly Simple Calorie Tracker
by Sam Stogsdill.

A tiny calorie and macro tracker that runs in your phone's browser and can be installed to the home screen. No food database and no account needed: data is stored on your device, with optional backup and sync through your own Firebase project.

## What it does

- **Today**: the day's calories, protein, carbs and fat, with meters that fill up toward your daily goals (protein red, carbs purple, fat yellow), plus sodium, sugar and fiber (blue, orange, green) if you turn them on in Settings. Below that: the foods you logged and that day's weigh-in. The arrows step through days.
- **History**: the calendar button at the top right of Today swaps the day for your history: each day's calories and macros, a bar split into protein, carbs and fat (as long as your calorie goal when you've set one), and that day's weigh-in. Tap a day to open it, or tap the calendar again to go back to the day you were on.
- **The + menu**: add a custom food, scan a nutrition label, log your weight, or pick one of your saved foods.
- **Weight and body fat**: log your weight (lb or kg) and, if you know it, your body fat %. It's saved for the day you're viewing on Today (today when logged from Goals). Logging the same day again replaces it.
- **Goals**:
  - a chart of your weigh-ins and their 7-day average (which smooths out day-to-day water weight), or of your body fat, over your goal, 1 month, 3 months or everything
  - a weight goal: pick a goal weight and a date to get a weekly and daily guide, the pace you need from today to finish on time, and whether you're on track, ahead or behind
  - about you: sex, age, height, activity level and units, used to estimate the calories you burn in a day
  - daily nutrition: calories either **from my plan** (they follow your weight goal) or **set my own**, split into grams:
    - Balanced: 30% protein, 50% carbs, 20% fat
    - Custom: enter grams and get the calories (protein and carbs 4 kcal/g, fat 9 kcal/g)
  - sodium, sugar and fiber goals: sodium and sugar are limits to stay under (2,300 mg and 50 g to start, the US Daily Values), fiber a goal to reach (28 g to start)
- **My Foods**: your most-logged foods first (here and in the + menu), with the buttons and search pinned at the top. Save foods with calories, protein, carbs, fat, sodium, sugar and fiber per serving, a food emoji icon (only food and drink emojis are allowed), and a **default portion** that's filled in each time you log the food. Search matches the food's name or its icon ("apple" finds foods marked 🍎).
- **Portion calculator**: log in servings or in any unit that fits the food:
  - weight: g, oz, lb, kg
  - volume: tsp, tbsp, fl oz, cup, pint, quart, gallon, ml, L
  - count: piece, slice, scoop, bar, can, bottle, packet, container

  Give a serving two measures (for example "2 tbsp = 32 g", as most labels print) to log it by both weight and volume.
- **Custom foods**: add a one-off food, and optionally save it to My Foods.
- **Scan a nutrition label**: take a photo and the app reads the serving size (both measures), calories, protein, carbs, fat, sodium (or salt on EU labels), total sugars and fiber for you to check. The text is read on your phone (Tesseract.js); the photo is never uploaded.
- **Settings**: account and backup (see [Cloud backup and sync](#cloud-backup-and-sync-firebase)), which of sodium, sugar and fiber show on Today, appearance (Light by default, or Dark (true black) or Automatic, and a color: green by default, five other presets, or any custom color), and export/import of all your data as a JSON file. Appearance choices are saved per device.

## Custom colors

Pick a color in Settings > Appearance and the app works out the rest in [`js/colors.js`](js/colors.js): text on buttons is white, or a very dark shade of the color when white wouldn't read; links, icons and the active tab use a shade with at least 4.5:1 contrast on the page; the chart line gets at least 3:1; and dark mode gets its own lighter shade. So even a pale yellow stays readable.

## How the plan works

All of this lives in [`js/plan.js`](js/plan.js), with tests in `tests/plan.test.mjs`.

- **Current weight** is the average of your weigh-ins over the last 7 days, so one salty dinner doesn't look like a setback.
- **Calories you burn** = resting calories × activity level (1.2 sedentary up to 1.9 extra active). Resting calories use the Katch-McArdle formula when you've logged body fat in the last 30 days (it's based on lean mass), and Mifflin-St Jeor otherwise (sex, age, height and weight).
- **Your plan** runs from your weight and the date when you set the goal to the goal weight and date. "From today" is the pace still needed to finish on time, so if you fall behind or get ahead, the calories adjust.
- **Daily calories** = calories burned ± about 7,700 kcal per kg (3,500 per lb) of change per week, spread over 7 days. For safety the pace is capped at 1% of your body weight a week when losing (0.5% when gaining), and calories never go below 1,500 (men), 1,200 (women) or 1,350 (other) unless you burn less than that.
- **On track** means you're within normal day-to-day noise (the larger of 0.25 kg and 0.3% of your weight) of where the plan says you should be today.

These are estimates, not medical advice.

## Run it

It's plain HTML/JS with no build step. Serve the folder over HTTP:

```bash
npm start
```

That runs `python3 -m http.server 8000`; open http://localhost:8000.

To use it on your phone, host it on any static host with HTTPS. On GitHub Pages: open the repo's **Settings → Pages**, deploy from the `main` branch's root folder, then open the URL on your phone and choose **Add to Home Screen**. Always open it from the home-screen icon.

## Cloud backup and sync (Firebase)

Optional. Without it, everything stays on the device. With it, you sign in with an email and password, and your foods, history and goals are backed up to your own Firebase project and kept in sync across your devices. The app still works offline; changes upload when you're back online.

### One-time setup (free)

1. In the [Firebase console](https://console.firebase.google.com/), create a project. Google Analytics isn't needed. New projects are on the free Spark plan.
2. **Authentication** → Get started → **Sign-in method** → **Email/Password** → turn it on → Save.
3. **Authentication** → **Settings** → **Authorized domains** → Add domain → the domain you host the app on (for GitHub Pages, `<your-username>.github.io`).
4. **Firestore Database** → Create database → Standard edition → pick a location near you → **Start in production mode** → Create.
5. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**.
6. **Project settings** (gear icon) → **General** → **Your apps** → add a **Web** app (`</>`) → give it a nickname → Register app. Copy the `firebaseConfig` values it shows.
7. Paste them into [`js/firebase-config.js`](js/firebase-config.js) in place of `null`, and deploy.

Then open the app, go to **Settings → Account & backup** and tap **Create account**. Anything already on the device is added to your account. On your other devices, tap **Sign in**.

The config values aren't secret: they only identify the project, and every visitor's browser receives them. The security rules are what keep data private: each signed-in user can only read and write their own `users/<user id>/` data.

### How it works

- The app always reads and writes the device's own copy (IndexedDB), so it's fast and works offline.
- `js/sync.js` uploads changes and listens for changes made on your other devices.
- Every record remembers when it was last changed. If the same thing was changed on two devices, the newer change wins. Deleting leaves a marker, so deletes sync too.
- Signing out removes the device's copy (it's safe in your account). If something hasn't been backed up yet, the app warns you first.
- Usage is tiny: a few reads and writes per food you log, far inside the free limits.

### Testing sync

The Firebase emulators run sign-in and Firestore locally (they need Java 21 or newer). Install the dev tools once:

```bash
npm install
```

Run the automated sync test. It needs Playwright with Chromium and checks two devices on one account (foods, entries, weigh-ins, profile and goals), live updates, offline changes, security rules and sign-out:

```bash
npm run test:sync
```

Or try it by hand: start the emulators in one terminal,

```bash
npm run emulators
```

then serve the app in another and open http://localhost:8000/?emulator.

```bash
npm start
```

## Notes

- Without an account, data lives only in this browser on this device. The app asks the browser not to delete it when storage runs low, but clearing the site's data (or deleting the app) still erases it. Sign in, or export a backup now and then.
- The first label scan downloads the OCR engine (about 10 MB). After that it's cached, so scanning also works offline.
- Weight and volume can't be converted into each other without knowing how much a spoonful or cupful weighs. That's what a serving's second measure is for: a food entered as "2 tbsp = 32 g" can be logged in grams, ounces, spoons or cups. A food with only one measure can be logged in units of that kind, and always in servings.
- History stores a copy of each food's numbers, so editing or deleting a saved food doesn't change days you've already logged.

## Tests

```bash
npm test
```

Unit tests for unit conversions, portion math, goal presets, the weight-goal and calorie math, accent color contrast, the food-emoji list and the nutrition-label parser (including common OCR mistakes, such as "8g" being read as "89"). For sync, see [Testing sync](#testing-sync).

## Files

```
index.html                  app markup
style.css                   styles (light + dark)
js/app.js                   UI
js/db.js                    this device's data (IndexedDB) + settings
js/sync.js                  cloud backup and sync (Firebase)
js/firebase-config.js       your Firebase project's config (null = sync off)
js/vendor/firebase.js       Firebase SDK, bundled by `npm run vendor` from scripts/firebase-entry.js
js/units.js                 unit conversion + portion math
js/goals.js                 daily nutrition presets + macro/calorie math
js/plan.js                  weight goals, calories burned, calorie targets
js/colors.js                accent colors: contrast math and readable variants
js/food-emojis.js           the allowed food emoji icons
js/label-parser.js          OCR text → nutrition values
js/scanner.js               camera photo → OCR (Tesseract.js)
sw.js                       offline caching
icons/ui/                   interface icons (SVG)
firestore.rules             Firestore security rules
firebase.json               emulator settings
tests/                      unit tests; tests/e2e has the sync test
```

## Credits

Interface icons are based on [Streamline](https://www.streamlinehq.com)'s Core Solid set, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The star is Streamline's own SVG; the others were redrawn as vectors from 48px PNGs.

