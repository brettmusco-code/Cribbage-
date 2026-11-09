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
- **Share screen** with a QR code and install steps, so anyone at the table can get the app in seconds.
- **Live sync** so each player can score from their own phone (needs the free sync server below).
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

## Live sync between phones

With the sync server running, everyone at a table can score from their own phone, and finished games are shared with the table.

In the app, open **Settings → Live sync**, turn on **Share this game live**, and give your group a table name. Everyone who enters the same name joins the same game and history, so pick a name only your group knows. Live sync is off until you turn it on, and each phone starts with a random table name.

Without the server, the app still works fully on one phone: the game and history are saved on that phone.

### Set up the sync server (one time, free)

The server is a small Cloudflare Worker in [`server/`](server/). It runs on Cloudflare's free plan and keeps each table's game and history in Cloudflare's built-in storage.

1. **Cloudflare API token.** In the Cloudflare dashboard, open **My Profile → API Tokens → Create Token**, choose the **Edit Cloudflare Workers** template, and create it. Copy the token.
2. **Account ID.** Open **Workers & Pages** in the Cloudflare dashboard. The Account ID is on the right. If you've never used Workers, opening this page once also sets up your `workers.dev` address.
3. **Add both to GitHub.** In this repository, open **Settings → Secrets and variables → Actions → New repository secret**. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Deploy.** Open **Actions → Deploy sync server → Run workflow**. When it finishes, the run summary shows the server address, like `https://cribbage-sync.<your-name>.workers.dev`.
5. **Point the app at it.** In `index.html`, put that address in the `cribbage-sync` meta tag near the top:
   ```html
   <meta name="cribbage-sync" content="https://cribbage-sync.<your-name>.workers.dev">
   ```

After that, any change under `server/` pushed to `main` redeploys automatically.

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
