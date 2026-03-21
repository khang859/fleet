#!/usr/bin/env npx tsx
/**
 * Image generation script using fal.ai Nano Banana 2
 * - No --reference: uses text-to-image endpoint
 * - With --reference: uses image edit endpoint (fal-ai/nano-banana-2/edit)
 *
 * Usage:
 *   npx tsx scripts/generate-image.ts "prompt" --output ships/parent-1-arrow-idle-1.png
 *   npx tsx scripts/generate-image.ts "edit prompt" --output ships/parent-1-arrow-thrust-1.png --reference ships/parent-1-arrow-idle-1.png
 *   (FAL_KEY loaded from .env)
 *
 * Options:
 *   --output <subdir/name.png>      Required. Path relative to sprites-staging/
 *   --reference <subdir/name.png>   Reference image from sprites-staging/ — switches to edit endpoint
 *   --aspect-ratio <ratio>          1:1, 16:9, 9:16, auto (default: 1:1)
 *   --resolution <res>              0.5K, 1K, 2K, 4K (default: 0.5K)
 *   --seed <number>                 For reproducible results
 *   --thinking high                 Thinking level: minimal or high
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: join(__dirname, "../.env") });

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("Error: FAL_KEY environment variable is required");
  process.exit(1);
}

const SPRITES_STAGING = join(__dirname, "../sprites-staging");

interface ApiOptions {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  seed?: number;
  thinking_level?: string;
}

interface GenerateResponse {
  images: { url: string }[];
  description: string;
}

function isGenerateResponse(value: unknown): value is GenerateResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("images" in value) || !Array.isArray(value.images)) return false;
  for (const img of value.images) {
    if (typeof img !== "object" || img === null) return false;
    if (!("url" in img) || typeof img.url !== "string") return false;
  }
  return true;
}

function toDataUri(filepath: string): string {
  const data = readFileSync(filepath);
  const ext = extname(filepath).slice(1).toLowerCase();
  const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

async function generateText2Image(options: ApiOptions): Promise<GenerateResponse> {
  const response = await fetch("https://fal.run/fal-ai/nano-banana-2", {
    method: "POST",
    headers: {
      "Authorization": `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: options.prompt,
      num_images: 1,
      aspect_ratio: options.aspect_ratio ?? "1:1",
      resolution: options.resolution ?? "0.5K",
      output_format: "png",
      sync_mode: true,
      ...(options.seed !== undefined && { seed: options.seed }),
      ...(options.thinking_level && { thinking_level: options.thinking_level }),
    }),
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const data: unknown = await response.json();
  if (!isGenerateResponse(data)) {
    throw new Error("Unexpected response format from text-to-image API");
  }
  return data;
}

async function generateEdit(imageUrl: string, options: ApiOptions): Promise<GenerateResponse> {
  const response = await fetch("https://fal.run/fal-ai/nano-banana-2/edit", {
    method: "POST",
    headers: {
      "Authorization": `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: options.prompt,
      image_urls: [imageUrl],
      num_images: 1,
      aspect_ratio: options.aspect_ratio ?? "1:1",
      resolution: options.resolution ?? "0.5K",
      output_format: "png",
      sync_mode: true,
      ...(options.seed !== undefined && { seed: options.seed }),
      ...(options.thinking_level && { thinking_level: options.thinking_level }),
    }),
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const data: unknown = await response.json();
  if (!isGenerateResponse(data)) {
    throw new Error("Unexpected response format from edit API");
  }
  return data;
}

async function downloadImage(url: string, filepath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  writeFileSync(filepath, Buffer.from(await response.arrayBuffer()));
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: npx tsx scripts/generate-image.ts <prompt> --output <subdir/name.png> [options]");
    console.log("\nExamples:");
    console.log('  # Base idle frame (text-to-image)');
    console.log('  npx tsx scripts/generate-image.ts "pixel art spaceship..." --output ships/parent-1-arrow-idle-1.png');
    console.log('');
    console.log('  # Animation frame (image edit — uses edit endpoint)');
    console.log('  npx tsx scripts/generate-image.ts "same ship, engines blazing..." \\');
    console.log('    --output ships/parent-1-arrow-thrust-1.png \\');
    console.log('    --reference ships/parent-1-arrow-idle-1.png');
    console.log("\nOptions:");
    console.log("  --output <path>        Required. Path relative to sprites-staging/");
    console.log("  --reference <path>     Reference image from sprites-staging/ (uses edit endpoint)");
    console.log("  --aspect-ratio <ratio> 1:1, 16:9, 9:16, auto (default: 1:1)");
    console.log("  --resolution <res>     0.5K, 1K, 2K, 4K (default: 0.5K)");
    console.log("  --seed <number>        Reproducible seed");
    console.log("  --thinking high        Use high thinking level");
    process.exit(0);
  }

  const prompt = args[0];
  const parsed: ApiOptions & { output: string; reference?: string } = { prompt, output: "" };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--output":       parsed.output = args[++i]; break;
      case "--reference":    parsed.reference = args[++i]; break;
      case "--aspect-ratio": parsed.aspect_ratio = args[++i]; break;
      case "--resolution":   parsed.resolution = args[++i]; break;
      case "--seed":         parsed.seed = parseInt(args[++i]); break;
      case "--thinking":     parsed.thinking_level = args[++i]; break;
    }
  }

  if (!parsed.output) {
    console.error("Error: --output <subdir/name.png> is required");
    process.exit(1);
  }

  return parsed;
}

async function main() {
  const { output, reference, ...options } = parseArgs();

  const filepath = join(SPRITES_STAGING, output);
  mkdirSync(dirname(filepath), { recursive: true });

  let result: GenerateResponse;

  if (reference) {
    const refPath = join(SPRITES_STAGING, reference);
    if (!existsSync(refPath)) {
      console.error(`Reference image not found: sprites-staging/${reference}`);
      process.exit(1);
    }
    console.log(`Generating (edit): ${output}`);
    result = await generateEdit(toDataUri(refPath), options);
  } else {
    console.log(`Generating: ${output}`);
    result = await generateText2Image(options);
  }

  if (result.description) console.log("Description:", result.description);
  await downloadImage(result.images[0].url, filepath);
  console.log(`Saved → sprites-staging/${output}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
