# The image model picker was reading the wrong registry

## Symptom

The Agent pane's settings offered ten image models.
Nine were Gemini or GPT-5 chat models; the tenth was `openrouter/auto`, which is not an image model at all and fails the call if you pick it.
Flux, Seedream, Recraft, Qwen Image, Grok Imagine, Krea, Riverflow, MAI and `gpt-image-*` were all missing - 32 models in total.

## Cause

`AgentSettingsPanel` built the list as `models.filter((m) => m.outputImage)` over the models.dev **chat-completions** catalog, while `images.ts` posts to `https://openrouter.ai/api/v1/images`.

Those are two different registries, and neither is a subset of the other:

- Most image models never appear in a completions catalog, because you cannot hold a conversation with them.
- `openrouter/auto` appears in the completions catalog with `output: ['text', 'image']` and is refused by the images endpoint.

The right source is `https://openrouter.ai/api/v1/images/models`, which listed 41 models against the picker's 10.

## The larger half of the bug

That endpoint also publishes `supported_parameters` per model, and the spread is wide:

| Parameter | Models supporting it (of 41) |
| --- | --- |
| `input_references` | 41 (range 1-16) |
| `aspect_ratio` | 38, with 22 distinct values between them |
| `n` | 38 |
| `resolution` | 17 |
| `seed` | 10 |
| `quality` | 7 |

Fleet drew a fixed Resolution (`512 1K 2K 4K`), a fixed Quality (`low medium high`) and a Seed field for every model, and sent all three.
So Quality was a working-looking control that meant nothing for 34 of the 41 models, and the tool advertised a fixed 8-value `aspectRatio` enum that included `21:9`, which 25 of them reject - after the generation is paid for.

## Fix

- `AgentModelCatalog` downloads the images register beside the completions catalog, into the same cache file on the same daily schedule. A cache written before this exists fails `cacheSchema` and is re-downloaded, which is correct: its image models were the wrong ones.
- Unlike the OpenRouter defaults list, this fetch is **not** best effort. An empty image list is indistinguishable from "image generation is unavailable", so a failure fails the refresh and the last good cache is served with the reason attached.
- The settings controls are drawn from the selected model's own lists, and hidden when the list is empty. Switching model runs `supportedImageConfig`, which drops values the new model has no parameter for.
- `buildImageSpec` replaces the static `image` entry in `AGENT_TOOL_SPECS`: the aspect-ratio enum and the reference ceiling come from the chosen model, and either property is dropped entirely when the model has no use for it.
- `AgentService` gets `imageCapabilities`, a **synchronous** lookup against whatever the catalog has already downloaded. A turn must never wait on a model list to find out what shapes to offer, so it answers `null` before the first download and the spec falls back to the shapes every model accepts. `index.ts` warms the catalog at startup so that fallback is rare.

## What to watch for

Two registries that look like one list is the trap here.
Before filtering a catalog to answer "what can do X", check whether X is served by a different endpoint with a register of its own.
`outputImage` on a completions model means "this chat model can emit an image inline", which is a different claim from "the images endpoint will run this".

The other trap: a control whose values are hardcoded when the provider publishes them per model.
It fails silently - the setting shows, the request goes out, the parameter is ignored - and the only symptom is that the picture does not change when you change the setting.
