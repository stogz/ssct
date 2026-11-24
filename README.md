# Stupidly Simple Calorie Tracker
by Sam Stogsdill.

A tiny calorie and macro tracker that runs in your phone's browser and can be installed to the home screen. No account, no server, no food database: everything is stored on your device.

## What it does

- **My Foods**: save foods with calories, protein, carbs and fat per serving, plus a **default portion** that's filled in each time you log the food.
- **Portion calculator**: log any amount in servings, g, oz, lb, kg, or (for foods measured by volume) ml, cups, tbsp, tsp, fl oz. Calories and macros update as you type.
- **Custom foods**: add a one-off food, and optionally save it to My Foods.
- **Scan a nutrition label**: take a photo and the app reads the serving size, calories, protein, carbs and fat for you to check. The text is read on your phone (Tesseract.js); the photo is never uploaded.
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

- Data is stored in the browser's IndexedDB. Clearing site data deletes it, so export a backup now and then.
- The first label scan downloads the OCR engine (about 10 MB). After that it's cached, so scanning also works offline.
- Mass and volume can't be converted into each other without knowing a food's density. A food whose serving is in grams can be logged by weight; one whose serving is in cups can be logged by volume. Both can always be logged in servings.
- History stores a copy of each food's numbers, so editing or deleting a saved food doesn't change days you've already logged.

## Tests

```bash
npm test
```

Covers unit conversions, portion math and the nutrition-label parser (including common OCR mistakes, such as "8g" being read as "89").

## Files

```
index.html            app markup
style.css             styles (light + dark)
js/app.js             UI
js/db.js              IndexedDB storage
js/units.js           unit conversion + portion math
js/label-parser.js    OCR text → nutrition values
js/scanner.js         camera photo → OCR (Tesseract.js)
sw.js                 offline caching
```
