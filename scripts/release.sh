#!/usr/bin/env bash
set -euo pipefail

# Fleet Release Script
# Usage: ./scripts/release.sh <patch|minor|major>

BUMP_TYPE="${1:-}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

# Ensure we're on main and up to date
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on '$BRANCH')"
  exit 1
fi

echo "Pulling latest from origin/main..."
git pull origin main

# Read current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo "New version: $NEW_VERSION"

# Confirm with user
read -rp "Proceed with release v${NEW_VERSION}? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Step 1: Bump version in package.json
echo "Bumping version in package.json..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
npm install

# Step 2: Add changelog entry
echo ""
echo "Add your changelog entry for v${NEW_VERSION} now."
echo "The CHANGELOG.md will open in your editor."
echo ""

# Insert a placeholder entry at the top (after the # Changelog heading)
sed -i '' "s/^# Changelog$/# Changelog\n\n## v${NEW_VERSION}\n\n- \n/" CHANGELOG.md

# Open in editor
"${EDITOR:-vi}" CHANGELOG.md

# Verify the entry exists
if ! grep -q "## v${NEW_VERSION}" CHANGELOG.md; then
  echo "Error: CHANGELOG.md missing ## v${NEW_VERSION} heading. Aborting."
  exit 1
fi

# Step 3: Commit
echo "Committing version bump and changelog..."
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump version to ${NEW_VERSION}"

# Step 4: Push to main
echo "Pushing to main..."
git push origin main

# Step 5: Create draft release and push tag
echo "Creating draft GitHub release..."
gh release create "v${NEW_VERSION}" --draft --title "v${NEW_VERSION}" --generate-notes

echo "Creating and pushing tag..."
git tag "v${NEW_VERSION}"
git push origin "v${NEW_VERSION}"

echo ""
echo "Release v${NEW_VERSION} initiated!"
echo "Monitor CI: gh run list --limit 5"
echo "Watch CI:   gh run watch"
echo "Verify:     gh release view v${NEW_VERSION}"
