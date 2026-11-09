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
- **Easy-to-read board**: large hole numbers, lanes painted in each player's colour, arrows at every turn, skunk lines spelled out, and a tag in each player's colour showing their score beside their lead peg.
- **Five board designs**, each with its own track shape. Pick one in Settings:
  - **Walnut, Classic:** four straight streets that run back and forth.
  - **Maple, Racetrack:** one lap around a rounded oval, starting and finishing together on the top straight.
  - **Ebony, Spiral:** winds inward to a brass medallion in the centre.
  - **Card table, Columns:** six up-and-down columns on green felt with gold stitching.
  - **Slate, Wave:** three long wavy streets.
- **Game recap chart** at the end of each game, with points from pegging, hands and crib.
- **History tab**: wins, win %, average hand, average crib, pegging per game, best hand, skunks, and every past game with its chart.
- **Share screen** with a QR code and install steps, so anyone at the table can get the app in seconds.
- **Play live**: find an open table or start one, and each player scores from their own phone (needs the free sync server below).
- **Installs to your home screen** and works offline.

## Share and install

Tap **Share** at the top of the app. It shows a QR code and a copy button for the app link, plus install steps for the phone you're on.

- **Android (Chrome):** the Share screen has an **Install app** button. You can also use the ⋮ menu, then **Install app**.
- **iPhone (Safari):** tap Share, then **Add to Home Screen**.

Installed, it opens full screen from its own icon, works without signal, and updates itself when this repository changes.

## Turn on GitHub Pages

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**, then **Save**.

The site is live a minute or two later.

## Live play between phones

Tap **Play live** at the top of the app.

- **Open tables** lists the tables in use, with their players, scores, game number and how many phones are connected. Tap **Join** to sit down at one.
- **Start or join by name**: type a new name to start a table with your current game, or the name of a hidden table to join it. A name made from the players' names is filled in for you.
- At a table, everyone sees and scores the same game on their own phone, and finished games are shared with the table.
- **Show this table in the list** is on for new tables. Turn it off to keep a table private; people can still join by typing its name.
- If this phone has a game of its own (not at a table), joining asks first, because the table's game replaces it.

Tables leave the list after a day without changes. This copy of the app uses the server at `https://cribbage-sync.brettmusco.workers.dev`.

Without the server, the app still works fully on one phone: the game and history are saved on that phone.

### Set up the sync server (one time, free)

The server is a small Cloudflare Worker in [`server/`](server/). It runs on Cloudflare's free plan and keeps each table's game and history in Cloudflare's built-in storage, plus a small directory of open tables.

1. **Cloudflare API token.** In the Cloudflare dashboard, open **My Profile → API Tokens → Create Token**, choose the **Edit Cloudflare Workers** template, and create it. Copy the token.
2. **Account ID.** Open **Workers & Pages** in the Cloudflare dashboard. The Account ID is on the right. If you've never used Workers, opening this page once also sets up your `workers.dev` address.
3. **Add both to GitHub.** In this repository, open **Settings → Secrets and variables → Actions → New repository secret**. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Deploy.** Open **Actions → Deploy sync server → Run workflow**. When it finishes, the run summary shows the server address, like `https://cribbage-sync.<your-name>.workers.dev`.
5. **Point the app at it.** In `index.html`, put that address in the `cribbage-sync` meta tag near the top:
   ```html
   <meta name="cribbage-sync" content="https://cribbage-sync.<your-name>.workers.dev">
   ```

After that, any change under `server/` pushed to `main` redeploys automatically. Each deploy ends with a check (`server/smoke-test.mjs`) that the server answers, passes live updates between two connections, lists a table and hides it again, and saves and deletes a game.

To run the server on your own computer: `cd server && npm install && npm run dev`, then set the meta tag to `http://127.0.0.1:8787`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: markup, styles and script in one file, no build step |
| `manifest.webmanifest` | Name, colors and icons for installing to a home screen |
| `sw.js` | Service worker that caches the app so it opens offline |
| `icons/` | App icons |
| `server/` | The live sync server (Cloudflare Worker) |
| `.github/workflows/deploy-sync.yml` | Deploys the sync server when its secrets are set |

To run it locally, serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000`.
