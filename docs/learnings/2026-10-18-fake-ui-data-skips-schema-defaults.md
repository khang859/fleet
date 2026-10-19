# Fake UI data skips schema defaults

## What happened

A visual check of the Bridge plan reader seeded a fake plan into the renderer's agency store with `fleet-drive eval`.
The reader crashed with `Cannot read properties of undefined (reading 'length')`.
The plan had no `asksFirst` or `newRoles`, and its steps had no `skills`, `deliverables` or `after`.

## Why

Real plans always pass through `PlanSchema`, which fills those arrays with `[]` defaults.
A hand-written object in an `eval` script does not, so the UI saw fields that real data never lacks.
The code was right; the fake data was not.

## Fix

Seed fake plans with every field the schema defaults, or build them in a test with `PlanSchema.parse`.
When a seeded screen crashes, read the stack in `.fleet-drive/dev.log` (search for `react render error`) and compare the failing field against the schema before changing code.
