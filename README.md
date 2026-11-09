# Cribbage Board

A cribbage pegging board for your phone. Tap to score, and the pegs leapfrog along a wooden board.

**Play it:** once GitHub Pages is turned on (see below), the board is at
`https://brettmusco-code.github.io/Cribbage-/`.

## Features

- **One-tap scoring.** Quick buttons for +1 to +8, +10 and +12, plus an "Other" box for any amount.
- **2, 3 or 4 players, or partners (2 v 2).** Partners share a lane; you pick which partner scored so each person's stats stay accurate.
- **Guided counting.** Each hand goes pegging, then each hand in order from the dealer's left, then the crib. The deal passes on its own, and the game ends the moment someone reaches 121.
- **Undo** for every step, including a win.
- **Skunk and double-skunk detection**, a match tally, and the loser deals first in the next game.
- **Five board designs**, each with its own track shape. Pick one in Settings:
  - **Walnut, Classic:** four straight streets that run back and forth.
  - **Maple, Racetrack:** one long lap around an oval.
  - **Ebony, Spiral:** winds inward and finishes in the centre.
  - **Card table, Columns:** six up-and-down columns on green felt.
  - **Slate, Wave:** three long wavy streets.
- **Game recap chart** at the end of each game, with points from pegging, hands and crib.
- **History tab**: wins, win %, average hand, average crib, pegging per game, best hand, skunks, and every past game with its chart.
- **Installs to your home screen** and works offline.

## Install on your phone

1. Open the GitHub Pages link above.
2. **iPhone (Safari):** tap Share, then **Add to Home Screen**.
   **Android (Chrome):** tap the menu, then **Install app** or **Add to Home screen**.

## Turn on GitHub Pages

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**, then **Save**.

The site is live a minute or two later.

## Where data is kept

The game in progress and the player history are saved in your browser on each device.

Live sync between phones and history shared across devices need the database that the claude.ai Artifact version of this page provides. In this standalone version, those settings are switched off automatically and everything stays on the device you're using.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: markup, styles and script in one file, no build step |
| `manifest.webmanifest` | Name, colors and icons for installing to a home screen |
| `sw.js` | Service worker that caches the app so it opens offline |
| `icons/` | App icons |

To run it locally, serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000`.
