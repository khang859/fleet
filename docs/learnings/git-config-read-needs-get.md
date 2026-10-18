# Read git config with `--get`

`src/main/agency/__tests__/git-write-boundary.test.ts` scans the agency source for git write verbs.
Any `'config'` argument list without `'--get'` counts as a write, because `git config key value` sets a value.

Read your work first read the commit email with `git(['config', 'user.email'])`.
That is a read in practice, but the boundary test failed on it, and rightly: one more argument turns it into a write.
The fix is `git(['config', '--get', 'user.email'])`, which can only read.

Rule: in agency code, read git config with `--get`, so a read can never become a write by accident.
