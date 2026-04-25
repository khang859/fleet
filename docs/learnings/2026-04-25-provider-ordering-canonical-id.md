# Provider Ordering Expectations With Canonical IDs

When changing a provider identifier to match an upstream canonical id, update ordering tests to match the actual label/id sort behavior. `amazon-bedrock` sorts before `anthropic` with the existing `localeCompare`-based ordering, so tests should assert that order instead of preserving the previous `bedrock` position.
