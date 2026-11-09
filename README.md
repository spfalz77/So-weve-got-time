# So We've Got Time

A phone party game for waiting rooms, road trips and dinner-table lulls. One person starts a room, everyone else scans the QR code or types the 4-letter code. Rounds: trivia, a rock-paper-scissors tournament, Guess Who (from everyone's "about you" answers), Photo Zoom (whose face is this?) and Object Photos.

It's one file (`index.html`) with no build step. Host it anywhere static (GitHub Pages works).

## Backend

Uses Supabase. Run the SQL in `supabase/migrations/` (in order) in the Supabase SQL editor, then put your project URL and publishable (anon) key at the top of the script in `index.html`. With the placeholder `YOUR_...` values it runs in **demo mode**, which works across tabs on one device for testing.

## How it works

- **Sync**: every phone polls the game row plus a *light* roster (names and scores, no photos) every 1.2s. Photos are fetched once per player and cached.
- **Host is the referee**: the host's phone decides rounds, tallies answers and awards points.
- **Rejoining**: each phone remembers its room for 3h. Reopening the app shows "Rejoin room ABCD", and scanning the same QR again puts you straight back in. On a new phone, joining with the same name reclaims your player, score included. The host can rejoin the same way.

## Privacy

There are no logins, so anyone with the publishable key can read the tables. The schema keeps that exposure small:
- no phone numbers or other contact info are stored
- selfies and object photos are wiped the moment a game ends (and by the cleanup job for any game that's ended or 2h old)
- whole games are hidden after 3h and deleted by a cleanup job every 10 minutes
- nothing can be deleted through the API

What's still open: anyone with the public key can read games from the last 3 hours. The fix (per-room access with anonymous sign-ins) is written up in [docs/privacy-anonymous-auth.md](docs/privacy-anonymous-auth.md).

## Tests

`tests/game.spec.js` has simulated phones play real games:
- a full game through every round type, with a player closing the tab mid-game and rejoining, a late joiner, HTML in a player name, the final scoreboard, and photos being wiped at the end
- the host leaving the setup screen and coming back
- rock-paper-scissors: the ready screen, a tie that doesn't count, best of three, and the bracket
- rock-paper-scissors with an odd number of players: the bye and the losers bracket

On GitHub (every pull request and push to `main`), the tests start a real local Supabase from `supabase/migrations/`, give every phone its own separate browser, and run in both Chrome's engine (Android) and Safari's engine (iPhone).

Locally, with no Supabase running, they use demo mode instead:

```
npm install
npx playwright install chromium
npx playwright test --project=chromium
```

A second workflow pings the live database every 3 days so the free Supabase project doesn't pause.

## Next steps

- Per-room privacy via anonymous sign-ins, for when the app is shared beyond friends and family. See [docs/privacy-anonymous-auth.md](docs/privacy-anonymous-auth.md)
- Supabase Realtime instead of polling
- App icons in `manifest.json` so phones offer "Add to Home Screen"
- A bigger trivia bank
