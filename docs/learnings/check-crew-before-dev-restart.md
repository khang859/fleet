# Check for live crew before stopping or restarting dev

Stopping `npm run dev` kills every pane it owns, including crew at work on a job.
An agent once ran the live-crew check and the restart in one shell command, so the restart ran even when the check would have said stop.

Do the check as its own step, read the answer, and only then stop or restart.
`sqlite3 -readonly ~/.fleet/agency.db` fails while the app has the database open, so copy `agency.db` and its `-wal` file to a scratch folder and query the copy:

```bash
cp ~/.fleet/agency.db ~/.fleet/agency.db-wal "$SCRATCH"/
sqlite3 "$SCRATCH"/agency.db "select status, count(*) from crew_members group by status;"
```

Stop only when no crew member has a status other than `ended`.
