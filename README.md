# So We've Got Time

A phone party game for waiting rooms, road trips and dinner-table lulls. One person starts a room, everyone else scans the QR code or types the 4-letter code. Rounds: trivia, a rock-paper-scissors tournament, Guess Who (from everyone's "about you" answers), Photo Zoom (whose face is this?) and Object Photos.

It's one file (`index.html`) with no build step. Host it anywhere static (GitHub Pages works).

## Backend

Uses Supabase. Run `supabase-schema.sql` in the Supabase SQL editor, then put your project URL and publishable (anon) key at the top of the script in `index.html`. With the placeholder `YOUR_...` values it runs in **demo mode**, which works across tabs on one device for testing.

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

## Tests

`tests/game.spec.js` plays a whole game in demo mode with simulated phones. It covers the instant room code, the hide-answers mask, joining by link, HTML in player names, every round type, closing a tab mid-game and rejoining, a late joiner, the final scoreboard, and photos being wiped at the end. A second test checks that the host can leave the lobby and come back.

It runs on GitHub Actions for every push to `main` and every pull request. To run it locally:

```
npm install
npx playwright install chromium
npm test
```

## Next steps

- Per-room privacy via Supabase Anonymous Sign-Ins + RLS (only players in a room can read it), for when the app is shared beyond friends and family
- Supabase Realtime instead of polling
- App icons in `manifest.json` so phones offer "Add to Home Screen"
- A bigger trivia bank
