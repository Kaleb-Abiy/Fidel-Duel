# Fidel Duel

A two-player spoken word game in English and Amharic. Plain static files: no build step, no server code.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 in Chrome or Edge. (Opening `index.html` directly as a file works for play,
but the offline cache needs `http://localhost` or `https://`.)

## Host it

Upload this whole folder to any static host that serves **HTTPS** (required for the microphone and offline mode):
GitHub Pages, Netlify, Cloudflare Pages, Vercel, or your own server. It works from a sub-path too
(e.g. `https://you.github.io/fidel-duel/`).

## Offline

- The first visit saves the game for offline play (service worker in `sw.js`).
  Players can also use **Install app** to add it to their home screen or desktop.
- **When you change any file, bump `VERSION` in `sw.js`** (e.g. `fidel-duel-v2`) so players get the update.
  If you add new files, add them to the `ASSETS` list there too.
- Voice offline: in Chrome, the English voice can be downloaded once from the setup screen and then runs
  on-device. Amharic voice currently only works online in Chrome; offline, players type their answers
  (everything else, including the opponent Accept/Reject ruling, works offline).

## Edit the words

`words.js` holds every topic. Entries are comma-separated; `|` joins alternative names for the same answer
(`Hippo|Hippopotamus`). Remember to bump `VERSION` in `sw.js` afterwards.
