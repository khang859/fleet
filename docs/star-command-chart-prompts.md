# Star Command — Chart Image Generation Prompts

Prompts for generating polished system architecture diagrams. Use with fal.ai, Midjourney, or similar image generation tools. These are designed to produce clean, technical diagrams with a sci-fi aesthetic that matches the Star Command brand.

## System Architecture Overview (Hero Diagram)

```
A clean, professional technical architecture diagram for a software system called "Star Command", dark navy background (#0d1b2a) with a deep space theme, subtle star field in background. The diagram shows a central space station icon labeled "Fleet (Electron)" at the top, connected by glowing teal (#00ffff) lines to three satellite pod icons labeled "Hull A", "Hull B", "Hull C" below it. Each Hull connects down to a smaller icon labeled "Crewmate". A cylindrical database icon labeled "Starbase DB (SQLite)" sits in the center, with dotted teal lines connecting to all Hulls and the main station. On the right side, icons for "Git Remote" and "GitHub API" connect to the Hulls. Inside the station, three sub-sections are labeled "Visualizer", "Admiral Terminal", "Sub-Tabs". Clean sans-serif typography, no anti-aliasing on icons, pixel art style iconography, muted amber (#f0c040) accent color for labels, technical blueprint aesthetic, 16:9 aspect ratio, high resolution, no photographic elements, pure diagram illustration
```

## Supervision Tree (Let It Crash)

```
A minimal technical tree diagram on a dark navy (#0d1b2a) background, sci-fi theme with subtle stars. At the top, a glowing teal hexagon labeled "Fleet (Main Process)". Below it, connected by a solid teal line, an amber hexagon labeled "Sentinel (Watchdog)". Below that, three teal rectangles in a row labeled "Hull A", "Hull B", "Hull C", each connected to the Sentinel by solid lines. Below each Hull, a smaller grey rectangle labeled "Crewmate" connected by a thinner line. Dotted lines from each Hull lead to a central database cylinder icon. Clean, geometric, blueprint-style technical diagram, sans-serif labels, pixel-art inspired iconography, no photographic elements, 16:9 aspect ratio
```

## Quality Gates Pipeline

```
A horizontal flowchart pipeline diagram on dark navy (#0d1b2a) background with subtle star field. Three large rounded rectangles in sequence, connected by thick glowing arrows. First gate on the left is teal (#00ffff) labeled "Gate 1: Mission Brief" with a checklist icon. Middle gate is amber (#f0c040) labeled "Gate 2: Hull Verification" with a terminal/console icon. Right gate is green (#00ff88) labeled "Gate 3: Admiral Review" with an eye/review icon. Below each gate, smaller text shows what it checks. Between gates, branching paths show "fail" routes going down to red boxes labeled "Re-queue" and "Failed". The main happy path goes left to right with a final green checkmark. Clean technical diagram style, sans-serif typography, sci-fi aesthetic, no photographic elements, 16:9 aspect ratio, high resolution
```

## Mission Lifecycle State Machine

```
A state machine diagram on dark navy (#0d1b2a) background with subtle stars. Central cluster of rounded rectangles representing states: "Queued" (grey), "Active" (teal glow), "Hailing" (amber pulse), "Completed" (green), "Failed" (red), "Timeout" (orange). Directed arrows between states with small labels on each transition. The "Active" state is the largest and brightest, shown as a glowing pod-like shape. "Completed" has a checkmark icon, "Failed" has an X icon. Arrows from failed states loop back to "Queued" with a "re-deploy" label. Clean, geometric, technical diagram style, sans-serif labels, sci-fi space station aesthetic, no photographic elements, 16:9 aspect ratio
```

## Cross-Sector Coordination

```
A network diagram on dark navy (#0d1b2a) background with star field. Three glowing circular nodes arranged in a triangle: teal node labeled "API Sector", green node labeled "Web Sector", amber node labeled "Docs Sector". Glowing beam lines connect API to Web and API to Docs, with small animated-looking data orb icons traveling along the beams labeled "Cargo". Each sector node contains 1-2 smaller pod icons representing active Crewmates. A central star icon labeled "Admiral" sits in the middle, with thin dotted lines to all three sectors. Small mission card icons float near each sector showing task names. Clean technical diagram, sci-fi space station theme, pixel art inspired iconography, sans-serif typography, no photographic elements, 16:9 aspect ratio
```

## Deploy Sequence (Timeline)

```
A vertical sequence/timeline diagram on dark navy (#0d1b2a) background, sci-fi theme. Left column shows actor icons stacked vertically: "You" (person icon), "Admiral" (commander icon, teal), "Hull" (shield icon), "Crewmate" (pod icon), "Git" (branch icon), "GitHub" (logo). Horizontal arrows flow between actors showing the sequence: You speaks to Admiral, Admiral creates Mission, Admiral tells Fleet to deploy, Hull creates worktree, Hull spawns Crewmate, Crewmate works and sends hailing message, Admiral relays to You, You responds, Crewmate completes, Hull verifies and pushes, Hull creates PR. Each arrow has a small label. Timeline flows top to bottom. Clean, technical, UML-sequence-diagram style with sci-fi coloring, sans-serif typography, no photographic elements, 16:9 aspect ratio
```

## Tips for Best Results

- **Aspect ratio:** 16:9 works best for documentation and presentations
- **Style modifiers to add:** "vector illustration", "flat design", "infographic style", "technical blueprint"
- **Style modifiers to avoid:** "3D render", "photorealistic", "cinematic", anything that makes it look like a photo
- **If the output is too busy:** Add "minimal, clean, lots of whitespace, simple geometric shapes"
- **If labels are illegible:** Generate without text labels, then add them in Figma/Canva afterward — AI image generators are notoriously bad at text
- **For consistency across charts:** Prepend each prompt with: `In the style of a dark sci-fi technical blueprint with teal (#00ffff) and amber (#f0c040) accents on navy (#0d1b2a) background,`
