# Pi skill frontmatter YAML parsing

## Symptom

The bundled Pi `code-review` skill failed to load with `Nested mappings are not allowed in compact mappings` at the `description` field.

## Fix

- Change the long description from an unquoted plain scalar to a folded block scalar.
- Add a regression test that parses every bundled Pi skill's frontmatter with the same `yaml` package Pi uses.

## Lesson

YAML plain scalars are fragile for skill descriptions because `: ` inside prose, such as `Examples:`, can be parsed as a nested mapping. Use quoted or folded block scalars for bundled skill descriptions, and test frontmatter parsing before packaging skills.
