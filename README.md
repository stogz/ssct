# Stupidly Simple Calorie Tracker
by Sam Stogsdill.

A tiny calorie and macro tracker that runs in your phone's browser and can be installed to the home screen. No account, no server, no food database: everything is stored on your device.

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
- **Backup**: export or import all your data as a JSON file from Settings.

## Run it

It's plain HTML/JS with no build step. Serve the folder over HTTP:

```bash
npm start   # same as: python3 -m http.server 8080
```

Then open http://localhost:8080.

To use it on your phone, host it on any static host with HTTPS. On GitHub Pages: open the repo's **Settings → Pages**, deploy from your branch's root folder, then open the URL on your phone and choose **Add to Home Screen**.

## Notes

- Data is stored in the browser's IndexedDB, on this device only. The app asks the browser not to delete it when storage runs low, but clearing the site's data (or deleting the app) still erases it, so export a backup now and then.
- The first label scan downloads the OCR engine (about 10 MB). After that it's cached, so scanning also works offline.
- Weight and volume can't be converted into each other without knowing how much a spoonful or cupful weighs. That's what a serving's second measure is for: a food entered as "2 tbsp = 32 g" can be logged in grams, ounces, spoons or cups. A food with only one measure can be logged in units of that kind, and always in servings.
- History stores a copy of each food's numbers, so editing or deleting a saved food doesn't change days you've already logged.

## Tests

```bash
npm test
```

Covers unit conversions, portion math, goal presets, the food-emoji list and the nutrition-label parser (including common OCR mistakes, such as "8g" being read as "89").

## Files

```
index.html            app markup
style.css             styles (light + dark)
js/app.js             UI
js/db.js              IndexedDB storage
js/units.js           unit conversion + portion math
js/goals.js           daily goal presets + macro/calorie math
js/food-emojis.js     the allowed food emoji icons
js/label-parser.js    OCR text → nutrition values
js/scanner.js         camera photo → OCR (Tesseract.js)
sw.js                 offline caching
```
