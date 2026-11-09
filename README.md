# So We've Got Time

A phone party game for waiting rooms, road trips and dinner-table lulls. One person starts a room, everyone else scans the QR code or types the 4-letter code. Rounds: trivia, a rock-paper-scissors tournament, Guess Who (from everyone's "about you" answers), Photo Zoom (whose face is this?) and Object Photos.

It's one file (`index.html`) with no build step. Host it anywhere static (GitHub Pages works).

## Backend

Uses Supabase. Run `supabase-schema.sql` in the Supabase SQL editor, then put your project URL and publishable (anon) key at the top of the script in `index.html`. With the placeholder `YOUR_...` values it runs in **demo mode**, which works across tabs on one device for testing.

## How it works

- **Sync**: every phone polls the game row plus a *light* roster (names and scores, no photos) every 1.2s. Photos are fetched once per player and cached.
- **Host is the referee**: the host's phone decides rounds, tallies answers and awards points.
- **Rejoining**: each phone remembers its room for 12h. Reopening the app shows "Rejoin room ABCD", and scanning the same QR again puts you straight back in. On a new phone, joining with the same name reclaims your player, score included. The host can rejoin the same way.

## Privacy

There are no logins, so anyone with the publishable key can read the tables. The schema keeps that exposure small: no phone numbers or other contact info are stored, games older than 24h are hidden and then deleted hourly, and nothing can be deleted through the API.

## Next steps

- Per-room privacy via Supabase Anonymous Sign-Ins + RLS (only players in a room can read it)
- Supabase Realtime instead of polling
- App icons in `manifest.json` so phones offer "Add to Home Screen"
- A bigger trivia bank
