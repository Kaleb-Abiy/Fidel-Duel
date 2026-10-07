# Fidel Duel

A two-player spoken word game in English and Amharic. Plain static files: no build step, no server code.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 in Chrome or Edge. (Opening `index.html` directly as a file works for play,
but the offline cache needs `http://localhost` or `https://`.)

## Offline

- The first visit saves the game for offline play (service worker in `sw.js`).
  Players can also use **Install app** to add it to their home screen or desktop.
- **When you change any file, bump `VERSION` in `sw.js`** (e.g. `fidel-duel-v2` → `fidel-duel-v3`) so players get the update.
  If you add new files, add them to the `ASSETS` list there too.
- Voice offline: in Chrome, the English voice can be downloaded once from the setup screen and then runs
  on-device. Amharic voice currently only works online in Chrome; offline, players type their answers
  (everything else, including the opponent Accept/Reject ruling, works offline).

## Your own words

Players can add words to any topic, or create their own topics, from **Edit words** and **+ New topic**
on the setup screen. When an opponent accepts a word that isn't in the list, it's added to the player's
words too (they can untick that). These words are saved in the browser's local storage, so they stay on
that device only; **Back up** downloads them as a JSON file and **Restore** loads one back (merging, never
deleting).

## Edit the built-in words

`words.js` holds every built-in topic. Entries are comma-separated; `|` joins alternative names for the same answer
(`Hippo|Hippopotamus`). Remember to bump `VERSION` in `sw.js` afterwards.
