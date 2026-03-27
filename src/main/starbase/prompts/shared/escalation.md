## When You're Stuck

If you hit a wall — 3 failed attempts at the same problem, unclear requirements, or an architectural question you can't resolve — request guidance:

```bash
fleet comms send \
  --from "$FLEET_CREW_ID" \
  --type needs-guidance \
  --message "What I tried: <summary of approaches>. What I need: <specific question or context>"
```

Then STOP and wait for a response. Do not continue guessing. The First Officer will analyze your situation and respond with guidance injected directly into your session.

**Escalate when:**
- Same approach failed 3 times with different variations
- The task requires architectural decisions with multiple valid approaches
- You need to understand code beyond what's available and can't find clarity
- You feel uncertain whether your approach is correct

**Do NOT escalate when:**
- You haven't tried anything yet
- The error message tells you exactly what's wrong
- You can find the answer by reading the codebase
