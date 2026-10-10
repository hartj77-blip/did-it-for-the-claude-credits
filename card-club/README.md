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

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd card-club
npm install
npm start          # http://localhost:3000
```

Friends on the same Wi-Fi can join at `http://<your-computer's-local-IP>:3000`.

### Put it online so friends anywhere can join

**Render (free, easiest).** Push this repo to GitHub, then on [render.com](https://render.com)
choose **New → Blueprint** and pick the repo. It reads `render.yaml` at the repo root and
gives you a URL like `https://card-club-xxxx.onrender.com`. Send that to your friends.

- The free plan sleeps after about 15 minutes with no visitors. The first visit after that
  takes about 30 seconds to wake it up.
- The free plan's disk is wiped on every restart or redeploy, so chip counts and history reset
  too. To keep them, add a persistent disk (paid plan) and set the `DATA_DIR` environment
  variable to its mount path.

**Any other Node host** (Railway, Fly.io, a VPS, etc.): run `npm install && npm start` in
`card-club/`. The server listens on `$PORT` (default 3000), and the host must support
WebSockets.

**Quick temporary link from your own computer:** run `npm start`, then
`npx cloudflared tunnel --url http://localhost:3000` (or ngrok) and share the URL it prints.

## How it works

- `server/index.js` serves the static client and runs a WebSocket at `/ws`.
- `server/rooms.js` handles rooms, members, the chip bank, scoreboard, bots and auto-play.
  Chips, scores and history are saved to `data/rooms.json`. A game in progress is not saved.
- `server/games/*.js` hold the rules for each game. The server is authoritative and sends
  each player only what they're allowed to see, so nobody can peek at other hands.
- `public/` is the client: plain HTML, CSS and JS with no build step.

```bash
npm test   # rules tests plus thousands of simulated bot hands
```
