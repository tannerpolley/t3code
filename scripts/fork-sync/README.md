# Fresh fork cutover

Use the repository's pinned Node version. Pass the directory containing
`statev2.sqlite` and `settings.json`, normally `~/.t3/userdata`.

1. Run the read-only preflight. It uses separate bounded queries, so counts can
   change while T3 is running. A nonzero blocker count exits with status 1.
   Resolve the reported work in the legacy fork.
   ```sh
   node scripts/fork-sync/convert-database.mjs dry-run "$HOME/.t3/userdata"
   ```
2. Quit T3 and stop its background service if installed. Keep an offline
   pre-cutover backup of the state and configuration, including any outstanding
   SQLite WAL. Run the conversion before the fresh build first opens the state.
   It acquires exclusive locks, repeats preflight, and commits only after counts
   and sample projection checks agree. It saves the two preference keys in the
   database in the same transaction.
   ```sh
   node scripts/fork-sync/convert-database.mjs convert "$HOME/.t3/userdata"
   ```
3. Start the fresh build with the keep-list settings ports. After first startup
   and before editing preferences, quit T3 again and restore the saved keys.
   Then reopen the fresh build.
   ```sh
   node scripts/fork-sync/convert-database.mjs restore-settings "$HOME/.t3/userdata"
   ```

For rollback, keep the post-cutover state separately and restore the offline
backup with T3 stopped.

To prove the cutover on a synthetic database, pass an installed checkout at
`archive/issue-692-db-compat-proof`. The proof seeds that checkout's real stores,
runs the conversion, then starts and reads from the server in this checkout.

```sh
node scripts/fork-sync/prove-database-conversion.mjs /path/to/installed/legacy-checkout
```
