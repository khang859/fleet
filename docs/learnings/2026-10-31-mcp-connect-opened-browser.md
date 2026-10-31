# Connecting to an MCP server must not hold a working browser opener

## Symptom

Every launch of the dev app opened a browser tab to sign in to Mobbin.
Signing in on that tab did not help, and the next launch opened it again.

## Cause

`resolveAuth` handed the SDK a `FleetOAuthProvider` with the real `openExternal`, for the plain connect at startup.
The `auth.ts` header says connecting must never open a browser, but nothing enforced it.

When a connect gets a 401 and the SDK has no token, or the refresh fails, `authInternal` calls `provider.redirectToAuthorization`.

No callback listener runs on this path.
Only `signIn` starts one, so the browser came back to a closed port and the tokens were never saved.
That is why it repeated on each launch.

A sandbox gets a copy of the installed app's tokens once, and the two copies then age apart.
The likely reason the old copies go stale is refresh token rotation, but this was not confirmed against Mobbin.

## Fix

`resolveAuth` now takes only `secrets`, and gives the provider an `openExternal` that does nothing.
The SDK still throws `UnauthorizedError`, so the server lands in `needs-auth` with a Sign in button.
A refresh that works still connects with no user action.

## Lessons

**A rule in a comment is not a rule.**
Removing the capability from the type is what makes the rule hold.

**Check a guess against the live app before you trust it.**
The first guess was a keychain mismatch in dev.
A new sandbox connected to Mobbin with 8 tools, which ruled that out in one call.

**Repro an OAuth bug against a fake server, not the real account.**
Replaying a stale refresh token at a real provider can trigger reuse detection and sign out the live session.
The fake server in `src/main/agent/mcp/__tests__/fake-oauth-server.ts` can run standalone for this, with a request log to show when a browser reaches `/authorize`.
