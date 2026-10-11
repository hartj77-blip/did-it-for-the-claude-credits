# Card Club ♠♥♦♣

A browser card room for you and your friends. One person creates a room, sends the
invite link, and everyone plays together in real time on desktop or phone. No sign-up needed.

**Games**

| Game | Players | Notes |
| --- | --- | --- |
| Texas Hold'em | 2–9 | No-limit, blinds, side pots, automatic showdown and hand naming |
| Spades | 4 (two teams) | Nil bids, bags (10 = −100), spades must be broken, play to 500 (adjustable) |
| Gin Rummy | 2 | Melds and deadwood counted for you; knock, gin, big gin, undercuts, layoffs, game and box bonuses |
| Blackjack | 1–7 vs. the house | Double, split, 3:2 blackjack, dealer stands on all 17s |

**Room features**

- **Shared chip bank.** Everyone starts with 1,000 chips (the host can change this). Hold'em
  and Blackjack bet straight from it. Spades and Gin can have an optional chip stake, and the
  winners split the pot.
- **Automatic score keeping.** A leaderboard of wins per player per game, plus a history of
  every finished game or session with its result. Rebuys are tracked, so "net" is honest.
- **Bots.** The host can add bots to fill seats (say, if only two of you want Spades).
- **Drop-outs.** Refresh or reconnect and you're back in your seat. If someone disconnects,
  their turn is auto-played after 30 seconds so the game keeps moving.
- Chat, a "your turn" chime, and a mobile layout.

## Two ways to host it

### Option 1: GitHub Pages (free, no server)

The `pages.yml` workflow builds a static version where **the person who creates a room
hosts it from their own browser tab**. Friends connect straight to that tab over WebRTC.
[PeerJS](https://peerjs.com)'s free public servers help everyone find each other and
relay traffic when a direct connection isn't possible.

One-time setup:

1. The repo must be **public**. GitHub Pages on private repos needs a paid GitHub plan.
   Settings → General → Danger Zone → Change visibility.
2. Settings → **Pages** → Build and deployment → Source: **GitHub Actions**.
3. Merge this code into the default branch. The workflow builds, tests and deploys on every
   push there. You can also run it by hand from the Actions tab.

The site appears at `https://<your-username>.github.io/<repo-name>/`. The golf game is
included at `/golf.html`, and the Bunker Nine zombies game (solo or 1–4 player co-op with
voice chat, using the same peer-to-peer rooms) at `/zombies.html`.

Things to know about this mode:

- **The host's tab is the game server.** If the host closes it or their computer sleeps,
  the game pauses for everyone. Friends reconnect automatically when the host comes back.
- **The host can reopen the room.** Reloading the page, or using "Reopen your room" on the
  home page, brings the room back with the same code, chips, scores and history. Those are
  saved in the host's browser, so they live on that one device.
- A few very strict networks (some offices, schools or mobile carriers) can block
  peer-to-peer connections even with the relay.

Build it locally with `npm run build:web`. The output goes to `dist-web/`.

### Option 2: Run the Node server

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd card-club
npm install
npm start          # http://localhost:3000
```

Friends on the same Wi-Fi can join at `http://<your-computer's-local-IP>:3000`.
In this mode the server hosts the rooms, so nobody has to keep a tab open.

**Render (free tier).** On [render.com](https://render.com) choose **New → Blueprint** and
pick the repo. It reads `render.yaml` at the repo root and gives you a public URL.

- The free plan sleeps after about 15 minutes with no visitors. The first visit after that
  takes up to a minute to wake it up.
- The free plan's disk is wiped on every restart or redeploy, so chip counts and history
  reset too. To keep them, add a persistent disk (paid plan) and set the `DATA_DIR`
  environment variable to its mount path.

**Any other Node host** (Railway, Fly.io, a VPS, etc.): run `npm install && npm start` in
`card-club/`. The server listens on `$PORT` (default 3000), and the host must support
WebSockets.

## How it works

- `server/rooms.js` handles rooms, members, the chip bank, scoreboard, bots and auto-play.
  `server/protocol.js` handles incoming messages. Both run unchanged in either mode.
- `server/index.js` (Node mode) serves the client, runs a WebSocket at `/ws`, and saves
  chips, scores and history to `data/rooms.json`. A game in progress is not saved.
- `web/p2p.js` and `scripts/build-web.js` (Pages mode) bundle the same engine to run in the
  host's tab, connect players over PeerJS, and save to the host's `localStorage`.
- `server/games/*.js` hold the rules for each game. The server is authoritative and sends
  each player only what they're allowed to see, so nobody can peek at other hands.
- `public/` is the client: plain HTML, CSS and JS with no build step.

```bash
npm test   # rules tests plus thousands of simulated bot hands
```
