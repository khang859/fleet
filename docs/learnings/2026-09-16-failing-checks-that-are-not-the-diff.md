# When typecheck and tests fail for reasons that have nothing to do with your change

Two failures showed up while building an unrelated feature, both looking like pre-existing code defects and neither actually being one.
Both were confirmed against a clean `git worktree add /tmp/baseline HEAD` rather than by touching the working tree.

## 1. `node_modules` had drifted from the lockfile

`npm run typecheck` reported three errors in `src/renderer/src/lib/claude-settings-lint.ts`:

```
(24,44): error TS2353: 'strict' does not exist in type 'Options'.
(116,41): error TS2339: Property 'instancePath' does not exist on type 'ErrorObject'.
```

plus one lint error in the same file and one failing test.
All of it looked like ajv code written against the wrong version.

It was, but the wrong version was on disk, not in the source.
`package.json` asks for `ajv@^8.20.0`; `node_modules/ajv` was **6.14.0**, hoisted there by electron-builder's `@develar/schema-utils`, which wants ajv 6.
`npm ls ajv` says so outright:

```
├── ajv@6.14.0 invalid: "^8.20.0" from the root project
```

ajv 6 has no `strict` option and spells the error path `dataPath`, not `instancePath` - so the source was right and the installed package was wrong.
`package-lock.json` already had it correct (root `ajv` 8.20.0, v6 nested under the three packages that need it); only the installed tree had drifted.

`npm install` fixed all five symptoms and changed neither `package.json` nor `package-lock.json`.

**The tell:** `npm ls <package>` printing `invalid:`. Before "fixing" code that looks written for a different major version of a dependency, check which version is actually installed.
Editing the source to match ajv 6 would have been the wrong fix twice over - it would have broken against the version the lockfile installs everywhere else.

## 2. A test that only passed on a machine with an empty home directory

Two tests in `src/main/agent/__tests__/agent-service.test.ts` asserted that with nothing recorded, the agent is offered `memory_write` but not the `memory` read tool.
They failed on this machine.

The block creates a temp dir for the **project** memory tier (`<cwd>/.fleet/memory`) but memory has two tiers, and the **user** tier is `join(homedir(), '.fleet', 'memory')` - read straight from the real home directory.
A single file in `~/.fleet/memory` on the developer's machine is enough to make "nothing recorded" false and the assertion fail.

The fix is to isolate the tier the test forgot, with its own temp dir so a project entry cannot also appear as a user entry:

```ts
home = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-agent-home-')));
vi.stubEnv('HOME', home);
vi.stubEnv('USERPROFILE', home);
```

**The general point:** a test that reads `homedir()` transitively is environment-dependent even when it looks hermetic, and it fails on exactly the machines that use the feature most.
When a test asserts "there is nothing", check every source the code reads to decide that, not just the one the test sets up.
