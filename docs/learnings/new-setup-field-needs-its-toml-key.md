# A new setup field needs its TOML key too

## What happened

Phase 3 added `setupCommand` and `setupTimeoutSec` to the project level of `ProjectSetupSchema`, for the workspace setup that runs after each member's setup.
The setup screen showed the field and the schema had a default, so every unit test passed.
A real-git test that saved a workspace setup and opened a workspace found that the command never ran.

## Why

`setupToToml` and `parseSetupToml` in `src/main/agency/projects/project-store.ts` list each key by hand.
The new project-level keys were not in either list.
The save dropped the command, and the load filled in the schema default, an empty string.
The zod default hid the loss: nothing failed, the value was just gone.

## Fix

Map `setup_command` and `setup_timeout_sec` at the top level in both functions.
A round-trip test now uses a non-default workspace setup, so a dropped key fails the test.

## Rule

When you add a field to a schema that is saved through a hand-written mapping, add it to the mapping in both directions, and give the round-trip test a non-default value for it.
A round-trip test whose fixture uses only default values does not catch a missing key.
