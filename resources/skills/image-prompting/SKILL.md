---
name: image-prompting
description: Write prompts for the `image` tool that land the first time - structure, text inside an image, edits that keep what must not change, and reference images. Use before any `image` call, especially for logos, icons, UI mockups, diagrams, hero art and mascot frames.
---

# Prompting the image tool

Every call costs money and you cannot see the result, so the prompt has to be right going in.
There is no seed: the same prompt twice gives two different pictures, and a re-roll is a fresh charge rather than a refinement.

## What the tool actually gives you

- `prompt` - the whole of your control surface.
- `references` - up to 4 image paths. Passing any turns generation into editing.
- `aspectRatio` - one of `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`. Nothing else is accepted, and asking for a size in prose does not work.

There is no model, resolution, count or seed argument.
The model is whatever the user set in Fleet's agent settings, which is why the family notes near the bottom matter.

A reference has to be png, jpg, jpeg, webp, gif or svg, under 8 MB, and either inside the working folder or an image this agent generated earlier.
Anything else is refused.

You never see what came back.
Do not describe the image to the user as though you had looked at it - they can already see it.
If you need to know whether it worked, ask, or read the file if judging it is genuinely part of the job.

## The skeleton

Write in this order, on separate lines rather than as one paragraph:

```
Scene / background
Subject
Key details
Use case
Constraints
```

```
A weathered workshop bench under a single incandescent lamp.
A brass sextant, half disassembled, its arc catching the light.
Scratched lacquer, loose screws beside it, sawdust in the grain of the bench.
An editorial product photograph for a magazine feature.
35mm feel, shallow depth of field. No watermark, no text, no extra tools in frame.
```

The **use case** line is the one people leave out and the one that does the most work.
Naming the artifact - "a shipped mobile app screenshot", "a polished campaign image", "a whiteboard sketch" - sets the polish level more reliably than any adjective.

## Say visual facts, not praise

"Stunning", "masterpiece", "highly detailed", "8k", "trending on artstation" do nothing on current models and spend attention that description would use better.
That era is over; these models read the prompt as instructions, not as a bag of tags.

Replace praise with something renderable:

| Instead of                  | Say                                                       |
| --------------------------- | --------------------------------------------------------- |
| beautiful lighting          | soft bounce light from camera left, warm falloff          |
| high quality photo          | 35mm film, f/1.8, shallow depth of field                  |
| minimalist brutalist luxury | cream background, heavy black sans-serif, one hero object |
| a suit jacket               | navy blue tweed with a faint herringbone                  |
| epic fantasy armor          | ornate elven plate, etched with silver leaf patterns      |

Two more rules that follow from the same idea:

- **Describe what you want, not what you do not.** "An empty street" works; "a street with no cars" often produces cars. The exception is a short list of hard exclusions that current models do honour as constraints: `no watermark`, `no extra text`, `no logos`, `no decorative elements`.
- **Do not contradict the medium.** "A photorealistic watercolour" gets you neither. Pick one and describe it.

## Text inside the image

This is where current models beat their predecessors by the widest margin, and where prompt wording matters most.

- **Quote the literal string**, or write it in ALL CAPS. Both read as "render exactly this".
- **Treat typography as a constraint**, not a vibe: family, weight, size, colour, placement. "The word 'GLOW' in a flowing script, centred above the jar, warm gold" beats "with nice text".
- **Spell hard strings letter by letter** when they are proper nouns or invented words.
- **Demand it verbatim**: "render the text exactly, no extra characters".
- **Say what must not appear.** Models volunteer captions, credits and event names uninvited, so clean product shots want "no additional text or decorative elements".
- **Write non-Latin script directly** rather than describing it. `A sign reading 拉麺` works; "a sign with Japanese text" does not.

Long copy is fine now.
Headlines, paragraphs, small UI labels and packaging text all render on current models, so do not artificially cut a string down to a couple of words.

If the copy itself needs thought, write it out in your own reply first, then put the final string in the prompt.

## Editing: name what changes and what must not

The single highest-leverage technique in the whole skill.
Without an explicit preserve list the model treats the entire image as fair game and quietly redraws the face, the background and the lighting along with the thing you asked about.

> Change only X. Keep everything else exactly the same.

Then spell out the preserve set, and **repeat it on every follow-up call** - drift accumulates across a conversation.

```
Change only the clothing.
Preserve the face, facial features, skin tone, hair, hands, body shape, pose,
background and lighting exactly as they are.
```

- **One change per call.** Small single-change edits beat a rewritten prompt.
- For additions, describe only the new element and how it sits in the scene: matching light direction, scale, perspective and shadow are what make a composite read as real.
- For style transfer, say what must stay (composition, layout, proportions) and what must change (medium, palette, texture).

## Reference images

Refer to inputs by index and say how they relate.
An unlabelled pile of references gets averaged into mush.

```
Use image 1 as the structure and image 2 as the surface texture.
Place the result in the setting from image 3, matching its lighting and camera height.
Do not change anything else about image 3.
```

Common roles worth naming outright: structure, texture, style, subject, background, brand reference.
Saying "use the uploaded images as a strict style reference" is meaningfully stronger than "in this style".

**For a character or product across several images**, write a character anchor - a fixed block covering appearance, proportions, outfit, palette and tone - and paste it verbatim into every prompt in the series.
Also hold the aspect ratio fixed across the set.
Rewording the anchor between calls is the usual reason a series drifts.

## Vocabulary that moves the picture

- **Lighting:** three-point softbox, chiaroscuro, rim light, golden hour backlight, overcast diffusion, high-key, low-key, volumetric rays.
- **Camera:** 35mm film, 50mm, f/1.8, macro, wide angle, telephoto, low angle, bird's eye, Dutch angle, eye level.
- **Body:** GoPro for distorted immediacy, Fujifilm for its colour science, disposable camera for raw nostalgic flash. Each shifts the whole look.
- **Grade:** 1980s colour film with slight grain, muted teal cinematic grade, bleach bypass, warm neutral.
- **Composition:** centre-framed, rule of thirds, medium-full shot, extreme close-up, leading lines, generous negative space.

## Which model is behind the tool

The wording above works everywhere. These are the adjustments worth making when you know which family is configured.

**Gemini image (Nano Banana / Nano Banana Pro).**
Open with a strong verb - generate, edit, transform - then subject, action, location, composition, style.
Excellent at text and at real-world knowledge, so naming a real place, object or period gets you accurate detail rather than a guess.

**GPT Image.**
Prefers the labelled-section skeleton above; plain paragraphs, JSON and tag lists all parse, so pick whichever is easiest to read back.
Best-in-class at dense text and small type.
For interfaces, describe the product **as if it already ships** - that returns a real screen instead of a design sketch.

**Grok Imagine.**
Natural language, and capitalisation is its cue for literal text.
It is the most eager to add decorative text and credits of its own, so the exclusion line is close to mandatory.

**Older Stable Diffusion or Midjourney-style models,** if one is configured: shorter, more keyword-shaped phrasing, roughly 40-60 words, and the vocabulary tables above still apply.

## Recipes for the assets that actually get asked for

- **Logo.** "Clean vector-like shapes, strong silhouette, balanced negative space, legible at 16px, monochrome, flat, no text." Expect to vectorise and clean up afterwards.
- **Icon.** Name the system: "Material Design icon, 2px stroke, rounded joins, filled style, single concept, square canvas."
- **App icon.** "Squircle, one focal element, simple gradient ground, no text, reads at 40px."
- **UI mockup.** Screen type, hierarchy, the exact copy in quotes, layout logic, typography behaviour, and `as if it already exists`.
- **Diagram.** Ask for factual accuracy explicitly - "a scientifically accurate cross-section", "label each stage" - and put every label in quotes.
- **Hero image.** Reserve the space: "abstract composition with clear negative space in the centre-left for a headline overlay", plus `16:9` or `21:9`.
- **Mascot frames.** Generate frame 0 first, then pass it as a reference for every later frame so the character holds. Include "solid bright blue #0000FF chroma key background" in each prompt, then follow the sprite pipeline in `CLAUDE.md` to strip the background and assemble the sheet.

## Before you call

1. Is the artifact type stated?
2. Is every literal string quoted, with its typography described?
3. If this is an edit, is the preserve list written out - again?
4. Are the references indexed and given roles?
5. Is the aspect ratio one of the eight allowed values, and does it match the use?
6. Is there any praise language left that could be swapped for a visual fact?
