# Privacy plan: per-room access with anonymous sign-ins

**Status:** planned, not built. Do this before the app is shared beyond friends and family.
**Already in place:** short retention (option 1). Photos are wiped when a game ends, and whole games are hidden after 3h and deleted every 10 minutes. Keep that after this change too.

## The gap

There are no logins today, so the app uses Supabase's public key, and that key ships inside `index.html`. Anyone who copies it can read every game from the last 3 hours: names, ages, "about you" answers and, while a game is running, photos. Short retention limits how long that's possible. It doesn't limit who can do it.

## The fix in one line

Every phone gets a silent, invisible login (a Supabase **anonymous sign-in**), and the database only shows a room to phones that have joined it.

Nobody types an email or password, so joining still feels exactly the same. The login just gives each device a private ID that the database can check.

## How it works

### 1. Each phone gets an identity
- On first load the app calls `sb.auth.signInAnonymously()`, which needs no user input.
- Supabase stores the session on the phone. Reloading, closing the tab or locking the phone keeps the same identity.
- That identity (`auth.uid()`) becomes the player's ID. Rejoining on the same phone is then automatic, with no name matching needed.

### 2. The database knows who is in each room
- `swgt_players` gets a `user_id uuid` column (the phone's identity).
- `swgt_games` gets a `host_user_id uuid` column.
- A helper function `is_member(code)` checks whether this phone has a player in that room.

### 3. Rules (row level security)
| Table | Read | Write |
|---|---|---|
| games | members of the room | only the host updates it |
| players | members of the room | each phone updates its own row; the host can update scores in their own game |
| answers | members of the room | a phone can only answer as its own player |

### 4. Joining goes through one database function
A phone that isn't a member yet can't read the room, so it can't check the room code the way it does today. Instead:
- `join_game(code, name, age, answers, avatar, object_photo)` runs on the server. It checks the room exists and hasn't ended, adds the player with `user_id = auth.uid()`, and returns the room.
- `create_game(...)` does the same for the host.
- Both can refuse too many attempts from one phone, which makes guessing room codes impractical.

### 5. New phone, same player (optional)
Today, joining with the same name on a different phone reclaims your player. With sign-ins, a `reclaim_player(code, name)` function can keep that by moving the player to the new phone's identity. The trade-off: anyone in the room who knows your name could take over your spot. That's fine among friends. For a public app, allow it only while the game is in the lobby, or have the host approve it.

## What changes in the app

- **Startup:** sign in anonymously before anything else. It's one call and adds about 200 ms on first launch only.
- **Create and join:** call `create_game` / `join_game` instead of inserting rows directly.
- **Scoring:** the host's phone keeps awarding points. The rules let it update scores in its own game only.
- **Saved session:** local storage keeps only the room code, since identity now comes from the sign-in.
- **Bonus:** with proper per-room rules in place, the app can switch from polling every 1.2s to **Supabase Realtime**, which only sends a phone the changes for its own room. That makes it faster and lighter on data.

## Setup steps

1. Supabase dashboard → Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins**.
2. Add a migration in `supabase/migrations/` with the new columns, `is_member`, `create_game`, `join_game`, `reclaim_player` and the new policies. Drop the old open policies.
3. Add `enable_anonymous_sign_ins = true` under `[auth]` in `supabase/config.toml`, so the CI database matches.
4. Update `index.html` (startup sign-in, create/join calls).
5. Add tests:
   - a phone that hasn't joined a room gets nothing back when it reads that room
   - a phone can't answer as another player
   - a guest can't change scores; only the host can
   - everything in the existing full-game tests still passes
6. Deploy at a quiet time. Games already running under the old rules won't be visible to the new version, and they'll age out within 3h anyway.

## Costs and housekeeping

- Anonymous users count toward Supabase's monthly active users. The free tier allows 50,000, which is plenty here.
- Add a cleanup step that deletes anonymous users who haven't been seen in 30 days, so the user list doesn't grow forever.
- Effort: about half a day including tests.

## What it doesn't solve

- **Players in the room can still see each other's details.** That's the game: Guess Who needs everyone's answers. Answers can move out of what guests read so that only the host's phone sees them, if that ever matters.
- **A determined player could still cheat.** The host's phone is the referee, so someone who edits the page on the host's phone could change scores. Fixing that means moving scoring into database functions, which isn't worth it for a party game.
