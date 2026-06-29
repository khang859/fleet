# Learnings: Bundled chat skills missing from packaged app (2026-06-28)

## Bundled chat skills (e.g. create-goal) don't show in the Chat `/` slash menu when installed

**Symptom:** The `create-goal` skill (added in PR #387) appeared in the Chat `/` slash menu under `npm run dev` but was absent in the installed `Fleet.app`.

**Root cause:** A packaging/path mismatch.

The Chat `SkillManager` loads bundled skills from `<resourcesPath>/resources/*` (`src/main/index.ts`):

```ts
const skillsResourcesDir = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources');
// roots: join(skillsResourcesDir, 'chat-skills'), join(skillsResourcesDir, 'pi-skills')
```

But `electron-builder.yml`'s `extraResources` only copied:

- `resources/mascots/` → `resources/mascots/` (correct location)
- `resources/pi-skills/` → `pi-skills/` (top-level, for the Pi agent in `pi-agent-manager.ts`, which reads `join(process.resourcesPath, 'pi-skills')`)
- nothing for `resources/chat-skills/`

So in the packaged app, `Contents/Resources/resources/` contained only `mascots`.
Neither `chat-skills` nor `pi-skills` landed where the Chat `SkillManager` looks, so the slash menu showed no bundled skills.
`asarUnpack: resources/**` does drop copies under `app.asar.unpacked/resources/`, but the Chat manager never reads from there.

PR #387 added the skill file and the code root but never added the matching `extraResources` entry, so the gap only surfaced in packaged builds.

**Fix:** Add `extraResources` entries that copy the chat-consumed skill folders into `resources/` (matching the working `mascots` convention):

```yaml
- from: resources/chat-skills/
  to: resources/chat-skills/
- from: resources/pi-skills/
  to: resources/pi-skills/
```

The existing top-level `pi-skills/` copy is kept because the Pi agent depends on it; pi-skills is now duplicated (top-level for Pi, `resources/` for Chat), which is negligible.

**Takeaway:** When adding a new bundled-resource directory that the packaged app reads via `process.resourcesPath`, you must add a matching `extraResources` entry in `electron-builder.yml`. Dev mode resolves paths relative to the source tree, so a missing packaging entry is invisible until you test the installed `.app`. The two paths (`<resourcesPath>/resources/...` vs `<resourcesPath>/...` vs `app.asar.unpacked/resources/...`) must agree between the code and the packaging config.
