# Test end-to-end

Suite Playwright che pilotano l'app in Chromium headless con eventi
S Pen sintetici (pressione, pulsante laterale, palmo, pinch).

```bash
npm install            # installa playwright-core (dev)
node tests/run-all.js  # tutte le suite
node tests/test.js     # una suite singola
```

Se Chromium non è in `/opt/pw-browsers`, imposta `CHROME_PATH`:

```bash
CHROME_PATH="$(which chromium)" node tests/run-all.js
```
