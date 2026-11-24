# Stupidly Simple Calorie Tracker
by Sam Stogsdill.

A tiny calorie and macro tracker that runs in your phone's browser and can be installed to the home screen. No food database and no account needed: data is stored on your device, with optional backup and sync through your own Firebase project.

## What it does

- **Dashboard**: today's calories, protein, carbs and fat, with meters that fill up toward your daily goals (protein red, carbs purple, fat yellow).
- **Daily goals**: pick a preset and enter your calories to get your grams, or choose Custom to enter grams and get the calories (protein and carbs 4 kcal/g, fat 9 kcal/g).
  - Balanced: 30% protein, 40% carbs, 30% fat
  - High protein: 50% protein, 35% carbs, 15% fat
  - Keto: 50% protein, 5% carbs, 45% fat
- **My Foods**: save foods with calories, protein, carbs and fat per serving, a food emoji icon (only food and drink emojis are allowed), and a **default portion** that's filled in each time you log the food. Search matches the food's name or its icon ("apple" finds foods marked 🍎).
- **Portion calculator**: log in servings or in any unit that fits the food:
  - weight: g, oz, lb, kg
  - volume: tsp, tbsp, fl oz, cup, pint, quart, gallon, ml, L
  - count: piece, slice, scoop, bar, can, bottle, packet, container

  Give a serving two measures (for example "2 tbsp = 32 g", as most labels print) to log it by both weight and volume.
- **Custom foods**: add a one-off food, and optionally save it to My Foods.
- **Scan a nutrition label**: take a photo and the app reads the serving size (both measures), calories, protein, carbs and fat for you to check. The text is read on your phone (Tesseract.js); the photo is never uploaded.
- **History**: step back through previous days, or open the History tab for daily totals and 7- and 30-day averages.
- **Account & backup** (optional): sign in to back up everything and sync it between your devices. See [Cloud backup and sync](#cloud-backup-and-sync-firebase).
- **Export / import**: download all your data as a JSON file, or load one back, from Settings.

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

Run the automated sync test. It needs Playwright with Chromium and checks two devices on one account, live updates, offline changes, security rules and sign-out:

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

Unit tests for unit conversions, portion math, goal presets, the food-emoji list and the nutrition-label parser (including common OCR mistakes, such as "8g" being read as "89"). For sync, see [Testing sync](#testing-sync).

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
js/goals.js                 daily goal presets + macro/calorie math
js/food-emojis.js           the allowed food emoji icons
js/label-parser.js          OCR text → nutrition values
js/scanner.js               camera photo → OCR (Tesseract.js)
sw.js                       offline caching
firestore.rules             Firestore security rules
firebase.json               emulator settings
tests/                      unit tests; tests/e2e has the sync test
```
