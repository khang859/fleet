# GitHub Release Target Short SHA

When creating a draft release with `gh release create --target`, the GitHub release API can reject a short commit SHA with `Release.target_commitish is invalid`, even though other GitHub APIs resolve the short SHA.

Use the full commit SHA or a branch ref for `--target`. Also, a draft release created before the git tag exists may show an `untagged-*` URL while still reporting the intended `tagName`; push the actual git tag afterward to trigger the release workflow and attach the tag.
