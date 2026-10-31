# onnxruntime-node download can fail `npm ci` in CI

## What happened

PR #714 failed in the `npm ci` step, before any project code ran.
The install script of `onnxruntime-node` failed with `ETIMEDOUT` and `ENETUNREACH`.
A rerun of the same commit passed.

## Why

On `linux/x64`, the install script downloads GPU (CUDA) files from NuGet.
The other platforms do not download anything, so this only shows on the Linux runner.
A failed download fails the whole install.

Fleet does not need these files in CI.
The CPU binding and `libonnxruntime.so.1` come inside the npm package, and nothing in `src` uses CUDA.

## Fix

`.github/workflows/ci.yml` sets `ONNXRUNTIME_NODE_INSTALL: skip` on the `npm ci` step.
`parseInstallFlag()` in `node_modules/onnxruntime-node/script/install-utils.js` reads this variable, and the script then exits before it downloads.

`release.yml` still downloads these files.
The skip there would change what the Linux release contains, so that is a separate decision.
