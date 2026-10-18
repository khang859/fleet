# Mask a bearer token before key=value pairs

`maskCredentials` in `src/main/redactor.ts` runs several regex passes over text before it leaves Fleet.
The first version ran the `key: value` pass first.
On `Authorization: Bearer abc123` that pass matched `Authorization` as the key and masked only the next word, `Bearer`.
The token itself, `abc123`, went out unmasked.

The fix is order: the `Bearer <token>` pass runs first, then the `key: value` pass.
A test in `src/main/__tests__/redactor.test.ts` now plants `Authorization: Bearer x` and checks the token is gone.

Rule: when masking passes overlap, run the most specific pattern first, and test each secret shape with the text that usually comes before it.
