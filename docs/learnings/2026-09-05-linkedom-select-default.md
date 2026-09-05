# Linkedom select defaults in standalone mockup checks

A DOM check of the Workspace/Copilot settings concept initially reported the wrong folder source because Linkedom returned `undefined` for a select without an explicitly selected option. Browsers implicitly select the first option for this single-select control.

Inspection of `node_modules/linkedom/cjs/html/select-element.js` confirmed that its value getter only queries `option[selected]`. Initialize the first option as selected in the test harness before running the fragment. The corrected check passed folder inheritance, hook status propagation, folder switching, and navigation. This was a test-environment mismatch; no application fix was needed.
