# zsh does not word-split, and a rebase loop pays for it

## What happened

A loop over `branch:parent` pairs held in one variable rebased the wrong branch onto the wrong parent:

```zsh
pairs="a:b c:d e:f"
for p in $pairs; do ...   # runs ONCE, with p = the whole string
```

zsh does not split an unquoted parameter on whitespace the way bash does.
`${p%%:*}` then took everything before the first colon and `${p##*:}` everything after the last, so the loop rebased the first branch onto the last parent.

It reported `OK`, because the rebase succeeded - it was a fast-forward onto a descendant.
Nothing was lost, but the branch silently moved to the wrong place.

## The fix

Run the loop under bash, and use an array-shaped list:

```bash
bash -c '
for p in a:b c:d e:f; do
  b="${p%%:*}"; parent="${p##*:}"
  ...
done'
```

## The other half of the same bug

Rebasing a stack is not `git rebase <parent>` for each branch.
Once the parent has been rewritten, the child still holds the parent's *old* commits, so a plain rebase replays them again and conflicts against itself.

Record each child's old parent first, then:

```bash
git rebase --onto <new parent> <old parent sha> <branch>
```

`git merge-base child parent` before any rewriting is how to read the old parent off the stack.
