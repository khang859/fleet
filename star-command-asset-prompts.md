# Star Command — Pixel Art Asset Prompts for fal.ai

## Style Prefix

Prepend this to **every** prompt to maintain consistency:

> `16-bit pixel art, dark sci-fi space station theme, limited color palette of deep navy, teal, cyan, amber, soft red, and white accents, clean pixel edges, no anti-aliasing, retro game aesthetic, deep space black background with stars`

---

## 1. Starbase / Background

### 1a. Starbase — Full View (Hero Asset)
```
{style prefix}, pixel art futuristic space station (Starbase) floating in deep space,
viewed from outside at a slight angle, circular rotating ring divided into Sector
sections with docking arms, central Bridge hub module with antenna arrays and teal
glowing windows, solar panel wings extending outward, small blinking navigation lights
in cyan and amber, stars and distant nebula in background, dark space backdrop,
320x180 pixels, centerpiece asset
```

### 1b. Starbase — Rotation Frames
```
{style prefix}, pixel art futuristic Starbase sprite sheet, same circular ring design
with central Bridge hub and solar panel wings, 8 frames showing the station from
slightly different rotation angles to create a slow spinning animation, consistent
teal window glow and blinking navigation lights across all frames, deep space
background with stars, 320x180 pixels per frame, horizontal sprite sheet
```

### 1c. Starbase — Idle Ambient Animation
```
{style prefix}, pixel art futuristic Starbase detail sprite sheet, 4 frames showing
subtle ambient animation: blinking antenna lights cycling teal-cyan-white, small
satellite dish rotating on the Bridge hull, gentle pulse on the teal window lights,
tiny thruster puff on one side, same station design, 320x180 pixels per frame
```

### 1d. Deep Space Background — Starfield
```
{style prefix}, pixel art deep space background, scattered stars of varying sizes
and brightness, 2-3 distant colorful nebula clouds in muted purple and blue, one
small distant planet or moon on the edge, subtle parallax layers implied with
brighter stars in front and dimmer ones behind, 320x180 pixels, tileable,
no station just the background
```

### 1e. Deep Space Background — Starfield Twinkle Animation
```
{style prefix}, pixel art starfield sprite sheet, 4 frames showing stars twinkling
at different intervals, some stars bright in frame 1 and dim in frame 3, others
opposite, creates a living breathing space backdrop when looped, 320x180 pixels
per frame, deep space colors
```

### 1f. Docking Bay / Crew Arrival Point
```
{style prefix}, pixel art close-up of a Starbase docking port, circular airlock
with teal ring light, open bay doors, small guide lights lining the approach channel,
used as the visual anchor point where new Crew "dock" to the station, 64x64 pixels,
detail sprite
```

### 1g. Crew Pod (Active)
```
{style prefix}, pixel art small module pod attached to Starbase ring, glowing teal
window indicating active Crewmate, small antenna on top transmitting, status light
on the hull showing green, compact cylindrical shape, 32x32 pixels, detail sprite
```

### 1h. Crew Pod (Empty)
```
{style prefix}, pixel art small module pod attached to Starbase ring, dark window
indicating empty pod, no antenna activity, status light on hull showing dim grey,
same cylindrical shape as active variant, 32x32 pixels, detail sprite
```

### 1i. Crew Pod (Error / Lost)
```
{style prefix}, pixel art small module pod attached to Starbase ring, window
flickering red, small sparks and venting gas from a hull crack, status light on hull
showing red, warning stripes visible, same cylindrical shape, 32x32 pixels,
detail sprite
```

---

## 2. Admiral Avatar / Portrait

These are larger, detailed portraits used in the **tab sidebar**, **Comms feed**, and **dashboard header**. The Admiral is the Star Command AI orchestrator.

### 2a. Admiral Portrait — Default
```
{style prefix}, pixel art character portrait, front-facing bust shot, sci-fi Admiral
with a long dark coat, high collar, small teal glowing headset on one ear, confident
calm expression, short dark hair, shoulders visible, military-inspired aesthetic,
dark navy background with subtle teal grid lines, 64x64 pixels, portrait avatar,
clean readable face details
```

### 2b. Admiral Portrait — Transmitting (Active)
```
{style prefix}, pixel art character portrait, front-facing bust shot, same sci-fi
Admiral with long dark coat and teal headset, mouth slightly open mid-speech,
one eyebrow raised, small teal sound wave lines near headset indicating active
Comms, dark navy background, 64x64 pixels, portrait avatar
```

### 2c. Admiral Portrait — Thinking / Processing
```
{style prefix}, pixel art character portrait, front-facing bust shot, same sci-fi
Admiral with long dark coat and teal headset, eyes looking upward in thought,
hand on chin, small ellipsis dots floating near head, dark navy background,
64x64 pixels, portrait avatar
```

### 2d. Admiral Portrait — Alert / Red Alert
```
{style prefix}, pixel art character portrait, front-facing bust shot, same sci-fi
Admiral with long dark coat and teal headset, serious focused expression, eyes
narrowed, headset glowing amber instead of teal indicating alert mode, small amber
warning triangle near shoulder, dark navy background with red tint,
64x64 pixels, portrait avatar
```

### 2e. Admiral Portrait — Standby
```
{style prefix}, pixel art character portrait, front-facing bust shot, same sci-fi
Admiral with long dark coat and teal headset, relaxed neutral expression, eyes
half-lidded, headset glow dimmed, subtle "standby" text or power symbol near collar,
dark navy background slightly darker than default, 64x64 pixels, portrait avatar
```

### 2f. Star Command Logo / Insignia
```
{style prefix}, pixel art logo icon, five-pointed star shape with circuit board trace
lines running through it, teal and cyan glowing edges, small command console silhouette
integrated into the star center, dark navy background, clean symmetrical design,
32x32 pixels, app icon style, also generate 16x16 variant for tab favicon
```

## 2b. First Officer Avatar / Portrait

These are portraits for the First Officer — the automated triage officer who handles failed missions. Same style as Admiral but with amber ops accents and a data-pad.

### 2b-a. First Officer Portrait — Default
```
{style prefix}, pixel art character portrait, front-facing bust shot,
female First Officer with sharp features, short practical hair, small
tactical headset with amber LED accent on one ear, holding a glowing
data-pad at chest level, confident focused expression, fitted dark coat
with high collar similar to Admiral but with amber rank stripe on shoulder,
dark navy background with subtle teal grid lines, 64x64 pixels, portrait
avatar, clean readable face details
```

### 2b-b. First Officer Portrait — Working
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
eyes focused down on glowing data-pad, small teal processing indicators
near headset, concentrated expression, dark navy background,
64x64 pixels, portrait avatar
```

### 2b-c. First Officer Portrait — Escalation
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
looking up from data-pad with alert expression, headset flashing amber,
one hand raised slightly as if flagging attention, dark navy background
with subtle amber tint, 64x64 pixels, portrait avatar
```

### 2b-d. First Officer Portrait — Idle
```
{style prefix}, pixel art character portrait, front-facing bust shot,
same female First Officer with short practical hair and tactical headset,
relaxed neutral expression, data-pad lowered to side, headset glow dimmed,
dark navy background slightly darker than default, 64x64 pixels,
portrait avatar
```

---

## 3. Crew Avatars / Portraits

Matching portrait style for each Crew variant, used in Comms feeds and tab sidebar.

### 3a. Crew Variant — Hoodie Dev
```
{style prefix}, pixel art character portrait, front-facing bust shot, Crewmate wearing
a dark hoodie with hood down, relaxed friendly expression, messy hair, subtle teal
glow from off-screen monitor reflecting on face, dark navy background,
64x64 pixels, portrait avatar
```

### 3b. Crew Variant — Headphones Dev
```
{style prefix}, pixel art character portrait, front-facing bust shot, Crewmate wearing
large over-ear headphones with teal LED accents, focused determined expression,
short hair, dark navy background, 64x64 pixels, portrait avatar
```

### 3c. Crew Variant — Robot Crewmate
```
{style prefix}, pixel art character portrait, front-facing bust shot, cute small robot
Crewmate with round screen face showing two dot eyes and a line mouth, small antenna
on top with teal blinking light, metallic body with rivets, dark navy background,
64x64 pixels, portrait avatar
```

### 3d. Crew Variant — Cap Dev
```
{style prefix}, pixel art character portrait, front-facing bust shot, Crewmate wearing
a backwards baseball cap, slight smirk, casual confident expression, dark navy
background, 64x64 pixels, portrait avatar
```

### 3e. Crew Variant — Glasses Dev
```
{style prefix}, pixel art character portrait, front-facing bust shot, Crewmate with
large round glasses with teal lens reflection, studious thoughtful expression,
slightly hunched shoulders, dark navy background, 64x64 pixels, portrait avatar
```

---

## 4. Starbase Animations / Crew Lifecycle

These are animations on the Starbase itself that reflect Crew state — pods lighting up, shuttles docking, etc.

### 4a. Crew Docking — Shuttle Arrival
```
{style prefix}, pixel art small shuttle or escape pod approaching a Starbase docking
port, sprite sheet with 6 frames: frame 1 tiny dot approaching from distance,
frame 2 shuttle shape visible with engine glow, frame 3 closer with teal thrust trail,
frame 4 aligning with docking port, frame 5 connecting with small clamp animation,
frame 6 docked with green status light, 64x64 pixels per frame, horizontal sprite sheet
```

### 4b. Crew Undocking — Shuttle Departure
```
{style prefix}, pixel art small shuttle detaching from Starbase docking port,
sprite sheet with 4 frames: frame 1 clamps releasing with small spark, frame 2 shuttle
drifting away from port, frame 3 engines firing with cyan thrust trail,
frame 4 shuttle shrinking into distance, 64x64 pixels per frame, horizontal sprite sheet
```

### 4c. Pod Status — Active (Teal Glow)
```
{style prefix}, pixel art Starbase Crew pod, sprite sheet with 4 frames showing
teal window glow pulsing brighter and dimmer in a steady rhythm, small data stream
particles flowing from the pod antenna, active and busy, 32x32 pixels per frame
```

### 4d. Pod Status — Hailing (Amber Warning)
```
{style prefix}, pixel art Starbase Crew pod, window glowing amber instead of teal,
small flashing warning beacon on top of pod cycling on and off, Crewmate is hailing
Star Command for help, sprite sheet with 4 frames, 32x32 pixels per frame
```

### 4e. Pod Status — Error (Red Alert)
```
{style prefix}, pixel art Starbase Crew pod, window flickering red, small sparks
and venting gas particles from hull, emergency light flashing, sprite sheet with 4
frames showing escalating damage effects, 32x32 pixels per frame
```

### 4f. Pod Status — Idle (Dim)
```
{style prefix}, pixel art Starbase Crew pod, window very dimly lit with faint teal,
no antenna activity, minimal power state, single static frame, 32x32 pixels
```

### 4g. Pod Status — Mission Complete (Green Flash)
```
{style prefix}, pixel art Starbase Crew pod, sprite sheet with 4 frames: window
flashes bright green, green checkmark hologram appears above pod briefly, then pod
settles to a calm green glow with a small completion badge, 32x32 pixels per frame
```

### 4h. Starbase Alert Mode
```
{style prefix}, pixel art full Starbase in alert mode, sprite sheet with 4 frames,
red warning lights flashing along the station ring, rotating beacon on Bridge hub,
teal lights switched to amber across all windows, tense atmosphere,
320x180 pixels per frame
```

---

## 5. Comms / Transmission Effect Sprites

### 5a. Transmission — Crew to Admiral
```
{style prefix}, small pixel art data packet, glowing teal orb with trailing particles,
traveling along a faint beam line toward the Bridge hub, sprite sheet with 3 frames
showing movement from right to left, 8x8 pixels per frame, tiny effect sprite
```

### 5b. Transmission — Admiral to Crew
```
{style prefix}, small pixel art command signal, glowing amber orb with trailing
particles, traveling along a faint beam line toward a Crew pod, sprite sheet with 3
frames showing movement from left to right, 8x8 pixels per frame, tiny effect sprite
```

### 5c. Comms Beam — Active Link
```
{style prefix}, pixel art thin laser-like data beam connecting Bridge hub to a Crew
pod, teal color with subtle pulse traveling along it, sprite sheet with 4 frames
showing the pulse moving from one end to the other, 64x8 pixels per frame, tileable
horizontally, effect sprite
```

### 5d. Supply Route Beam — Cross-Sector Cargo Transfer
```
{style prefix}, pixel art thicker data beam arcing between two Sector sections of the
Starbase ring, amber and teal mixed colors with larger data packets traveling along it,
sprite sheet with 4 frames, 128x32 pixels per frame, effect sprite
```

### 5e. Speech Bubble — Hailing (Question)
```
{style prefix}, small pixel art speech bubble with question mark inside, white bubble
with dark outline, 16x12 pixels, UI sprite
```

### 5f. Speech Bubble — Directive (Exclamation)
```
{style prefix}, small pixel art speech bubble with exclamation mark inside, white
bubble with dark outline, 16x12 pixels, UI sprite
```

### 5g. Speech Bubble — Processing (Ellipsis)
```
{style prefix}, small pixel art thought bubble with three dots inside, animated sprite
sheet with 3 frames showing dots appearing one by one, white bubble,
16x12 pixels per frame, UI sprite
```

### 5h. Status Icon — Mission Complete (Checkmark)
```
{style prefix}, tiny pixel art green checkmark icon with small sparkle, 8x8 pixels,
clean and readable, UI sprite
```

### 5i. Status Icon — Error (Red X)
```
{style prefix}, tiny pixel art red X icon with small spark effect, 8x8 pixels,
clean and readable, UI sprite
```

### 5j. Status Icon — Hailing (Amber Clock)
```
{style prefix}, tiny pixel art amber hourglass or clock icon, 8x8 pixels,
clean and readable, UI sprite
```

### 5k. Lifesign Pulse
```
{style prefix}, small pixel art signal wave icon, sprite sheet with 4 frames pulsing
from dim to bright to dim, teal/cyan color, represents a Crewmate's Lifesign heartbeat,
8x8 pixels per frame, effect sprite
```

---

## 6. Particle Effects

### 6a. Thruster Flame — Shuttle
```
{style prefix}, pixel art small spaceship thruster flame, sprite sheet with 4 frames,
cyan-white engine glow flickering, used for shuttle docking and undocking,
8x8 pixels per frame, transparent background effect sprite
```

### 6b. Docking Sparkle
```
{style prefix}, pixel art sparkle burst effect, sprite sheet with 6 frames,
small diamond shapes and light particles appearing and fading, cyan and white,
plays when a shuttle successfully docks at the Starbase, 16x16 pixels per frame,
effect sprite
```

### 6c. Hull Sparks — Crew Error
```
{style prefix}, pixel art electric spark effect on Starbase metal hull, sprite sheet
with 4 frames, small jagged lightning bolts and orange sparks flying off a Crew pod,
red and orange colors, 8x8 pixels per frame, transparent background effect sprite
```

### 6d. Gas Vent — Crew Lost
```
{style prefix}, pixel art gas venting from a Starbase Crew pod hull breach, sprite
sheet with 5 frames, white-grey gas cloud expanding and dissipating into space vacuum,
small debris particles mixed in, 16x16 pixels per frame, effect sprite
```

### 6e. Data Stream Particles
```
{style prefix}, pixel art tiny glowing data particles flowing in a line, teal and
cyan colored dots of varying size, sprite sheet with 4 frames showing particles
moving along a Comms path between pods and Bridge hub,
8x8 pixels per frame, effect sprite
```

### 6f. Explosion — Pod Critical Failure
```
{style prefix}, pixel art small contained explosion, sprite sheet with 6 frames,
bright white flash expanding to orange fireball then dissipating with debris,
used when a Crew pod critically fails, 32x32 pixels per frame, effect sprite
```

---

## 7. UI Chrome

### 7a. Bridge Console Frame / CRT Border
```
{style prefix}, pixel art CRT monitor frame border styled as a Starbase Bridge console,
rounded rectangle with thick beveled edge, slight screen curvature implied, dark metal
frame with small screws in corners, teal power LED in bottom right, designed as
9-slice scalable border, transparent center
```

### 7b. Status Bar — Bridge Panel
```
{style prefix}, pixel art horizontal panel bar styled as a Starbase Bridge control
panel, dark metal texture with rivets, subtle teal backlit edge glow, tileable
horizontally, 320x16 pixels, UI panel background
```

### 7c. Crew Status Chip
```
{style prefix}, small pixel art rounded rectangle badge for Crew status, dark
background with colored dot indicator on left and space for text on right, 4 color
variants: teal (active), amber (hailing), red (error/lost), grey (idle),
48x12 pixels each, UI element
```

### 7d. Sector Label
```
{style prefix}, small pixel art label tag for Sector names on the Starbase ring,
dark background with teal border and glow, space for short text, angular sci-fi
shape like a nameplate, 64x12 pixels, UI element
```

---

## Consistency Tips

1. **Always include the style prefix** — it locks the palette, perspective, and rendering style
2. **Generate the Starbase hero asset first** (1a) — then use it as reference in subsequent prompts by mentioning "matching the Starbase style"
3. **Generate pod variants together** — active, empty, and error pods should be generated in one session so they match
4. **Keep sprite sizes consistent** — 320x180 for full Starbase scenes, 64x64 for portraits and docking details, 32x32 for pods, 8x8 for icons/particles
5. **Post-process** — you'll likely need to clean up edges and ensure exact pixel sizes in Aseprite or Piskel after generation. fal.ai gets the vibe right but pixel-perfect alignment usually needs a manual pass
6. **Color extraction** — after generating the first few assets, extract the exact hex values fal.ai chose and add them to subsequent prompts (e.g. "use #0A1628 for navy, #2DD4BF for teal") to lock the palette tighter
7. **Rotation frames** — for the Starbase rotation, generate all 8 frames referencing the same prompt with only the angle description changing, to keep the design consistent across frames
8. **Avatar vs Starbase separation** — the portraits (sections 2-3) are UI elements overlaid on the scene, so they don't need to match the Starbase's perspective — front-facing bust shots work fine alongside a side-view station
9. **Use the glossary** — keep naming consistent with the spec: Starbase (workspace), Sectors (projects), Crew (agents), Admiral (commander), Comms (messages), Cargo (artifacts), Bridge (central hub), Hailing (blocked), Lifesigns (heartbeat)
