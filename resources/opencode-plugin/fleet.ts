import { createConnection } from "node:net"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const z = tool.schema

const SOCK_PATH = join(homedir(), ".fleet", "fleet.sock")
const DEV_SOCK_PATH = join(homedir(), ".fleet", "fleet-dev.sock")
const TIMEOUT_MS = 30_000

interface FleetResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

interface FleetError {
  message: string
  code?: string
}

function isFleetResponse(v: unknown): v is FleetResponse {
  return (
    v != null &&
    typeof v === "object" &&
    "ok" in v &&
    typeof (v as { ok?: unknown }).ok === "boolean"
  )
}

function resolveSocketPath(): string {
  if (existsSync(SOCK_PATH)) return SOCK_PATH
  if (existsSync(DEV_SOCK_PATH)) return DEV_SOCK_PATH
  return SOCK_PATH
}

const COMMAND_MAP: Record<string, string> = {
  "images.generate": "image.generate",
  "images.edit": "image.edit",
  "images.status": "image.status",
  "images.list": "image.list",
  "images.retry": "image.retry",
  "images.config": "image.config.get",
  "images.action": "image.action",
  "images.actions": "image.actions.list",
  "annotate.start": "annotate.start",
}

function mapCmd(cliCommand: string): string {
  return COMMAND_MAP[cliCommand] ?? cliCommand
}

async function sendCommand(
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = TIMEOUT_MS,
): Promise<FleetResponse> {
  const cmd = mapCmd(command)
  const sockPath = resolveSocketPath()

  if (!existsSync(sockPath)) {
    return {
      id: "",
      ok: false,
      error: `Fleet app is not running (no socket at ${sockPath}). Start Fleet first.`,
    }
  }

  return new Promise((resolve, reject) => {
    const id = randomUUID()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (response: FleetResponse): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(response)
    }

    try {
    timer = setTimeout(() => {
      settle({ id, ok: false, error: `Timeout after ${timeoutMs}ms` })
      try { socket.destroy() } catch { /* ignore */ }
    }, timeoutMs)

    const socket = createConnection(sockPath, () => {
      socket.write(JSON.stringify({ id, command: cmd, args }) + "\n")
    })

    let buffer = ""

    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          socket.end()
          settle(isFleetResponse(parsed) ? parsed : { id, ok: false, error: "Invalid response from Fleet" })
        } catch {
          socket.end()
          settle({ id, ok: false, error: "Invalid JSON response from Fleet" })
        }
      }
    })

    socket.on("error", (err: FleetError) => {
      if (err.code === "ENOENT") {
        settle({ id, ok: false, error: "Fleet app is not running. Start Fleet first." })
      } else {
        settle({ id, ok: false, error: err.message })
      }
    })

    socket.on("close", () => {
      settle({ id, ok: false, error: "Connection closed without response" })
    })
    } catch (err: unknown) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function formatResponse(response: FleetResponse): string {
  if (!response.ok) return response.error || "Unknown error"
  if (response.data === undefined) return "ok"
  if (typeof response.data === "string") return response.data
  try {
    return JSON.stringify(response.data, null, 2)
  } catch {
    return String(response.data)
  }
}

async function sendAndFormat(
  command: string,
  args: Record<string, unknown> = {},
): Promise<{ output: string }> {
  const response = await sendCommand(command, args)
  return { output: formatResponse(response) }
}

const IMAGE_PROVIDERS = z.string().optional().describe("Provider ID")
const IMAGE_MODEL = z.string().optional().describe("Model to use")
const IMAGE_RESOLUTION = z.string().optional().describe("Resolution: 0.5K, 1K, 2K, or 4K")
const IMAGE_ASPECT = z.string().optional().describe("Aspect ratio, e.g. 1:1, 16:9, 9:16")
const IMAGE_FORMAT = z.string().optional().describe("Output format: png, jpeg, or webp")
const IMAGE_NUM = z.number().optional().describe("Number of images: 1-4")

export const Fleet: Plugin = async () => {
  if (!process.env.FLEET_SESSION && !existsSync(SOCK_PATH) && !existsSync(DEV_SOCK_PATH)) return { tool: {} }
  return {
    tool: {
      fleet_images_generate: tool({
        description: "Generate images from a text prompt using Fleet's AI image providers (fal.ai, etc.). Returns a generation ID to check with fleet_images_status.",
        args: {
          prompt: z.string().describe("Text description of the image to generate"),
          provider: IMAGE_PROVIDERS,
          model: IMAGE_MODEL,
          resolution: IMAGE_RESOLUTION,
          aspectRatio: IMAGE_ASPECT,
          format: IMAGE_FORMAT,
          numImages: IMAGE_NUM,
        },
        execute: (args) => sendAndFormat("images.generate", {
          prompt: args.prompt,
          provider: args.provider,
          model: args.model,
          resolution: args.resolution,
          "aspect-ratio": args.aspectRatio,
          format: args.format,
          "num-images": args.numImages,
        }),
      }),

      fleet_images_edit: tool({
        description: "Edit images using a text prompt via Fleet's AI image providers. Requires at least one image file path.",
        args: {
          prompt: z.string().describe("Text description of the edit to apply"),
          images: z.array(z.string()).describe("One or more image file paths to edit"),
          provider: IMAGE_PROVIDERS,
          model: IMAGE_MODEL,
          resolution: IMAGE_RESOLUTION,
          aspectRatio: IMAGE_ASPECT,
          format: IMAGE_FORMAT,
          numImages: IMAGE_NUM,
        },
        execute: (args) => sendAndFormat("images.edit", {
          prompt: args.prompt,
          images: args.images,
          provider: args.provider,
          model: args.model,
          resolution: args.resolution,
          "aspect-ratio": args.aspectRatio,
          format: args.format,
          "num-images": args.numImages,
        }),
      }),

      fleet_images_status: tool({
        description: "Check the status of an image generation by its ID.",
        args: {
          generationId: z.string().describe("The generation ID from fleet_images_generate or fleet_images_edit"),
        },
        execute: (args) => sendAndFormat("images.status", { id: args.generationId }),
      }),

      fleet_images_list: tool({
        description: "List all image generations and their statuses.",
        args: {},
        execute: () => sendAndFormat("images.list", {}),
      }),

      fleet_images_retry: tool({
        description: "Retry a failed image generation.",
        args: {
          generationId: z.string().describe("The generation ID of a failed generation"),
        },
        execute: (args) => sendAndFormat("images.retry", { id: args.generationId }),
      }),

      fleet_images_action: tool({
        description: "Run an action on an image (e.g. remove-background). Use fleet_images_actions to see available actions.",
        args: {
          actionType: z.string().describe("Action type, e.g. remove-background"),
          source: z.string().describe("Image file path, URL, or generation reference (<genId>/image-001.png)"),
          provider: IMAGE_PROVIDERS,
        },
        execute: (args) => sendAndFormat("images.action", {
          action: args.actionType,
          source: args.source,
          provider: args.provider,
        }),
      }),

      fleet_images_actions: tool({
        description: "List available image actions for a provider.",
        args: {
          provider: IMAGE_PROVIDERS,
        },
        execute: (args) => sendAndFormat("images.actions", { provider: args.provider }),
      }),

      fleet_images_config: tool({
        description: "Read or write Fleet image configuration. Call with no arguments to read current config. Provide flags to set configuration values.",
        args: {
          apiKey: z.string().optional().describe("Set fal.ai API key"),
          defaultModel: z.string().optional().describe("Set default model"),
          defaultResolution: z.string().optional().describe("Set default resolution"),
          defaultOutputFormat: z.string().optional().describe("Set default output format"),
          defaultAspectRatio: z.string().optional().describe("Set default aspect ratio"),
          provider: z.string().optional().describe("Which provider to configure"),
          action: z.string().optional().describe("Action type to configure model for"),
          model: z.string().optional().describe("Model for the specified action"),
        },
        execute: async (args) => {
          const hasSetFlag = args.apiKey || args.defaultModel || args.defaultResolution ||
            args.defaultOutputFormat || args.defaultAspectRatio || args.action || args.model
          if (hasSetFlag) {
            return sendAndFormat("image.config.set", {
              "api-key": args.apiKey,
              "default-model": args.defaultModel,
              "default-resolution": args.defaultResolution,
              "default-output-format": args.defaultOutputFormat,
              "default-aspect-ratio": args.defaultAspectRatio,
              provider: args.provider,
              action: args.action,
              model: args.model,
            })
          }
          return sendAndFormat("images.config", { provider: args.provider })
        },
      }),

      // --- Kanban ---

      fleet_kanban_create: tool({
        description: "Create a new task on the Fleet Kanban board.",
        args: {
          title: z.string().describe("Task title"),
          body: z.string().optional().describe("Task description/body"),
          assignee: z.string().optional().describe("Assignee profile name"),
          priority: z.number().optional().describe("Priority number"),
          workspace: z.string().optional().describe("Workspace kind: scratch, dir, or worktree"),
          repo: z.string().optional().describe("Repository path (required when workspace is worktree)"),
        },
        execute: (args) => sendAndFormat("kanban.create", {
          title: args.title,
          body: args.body,
          assignee: args.assignee,
          priority: args.priority,
          workspace: args.workspace,
          repo: args.repo,
        }),
      }),

      fleet_kanban_swarm: tool({
        description: "Create a multi-worker swarm (task graph) on the Kanban board. Each worker runs in parallel. Workers format: [{profile, title, skills?}]. A verifier reviews results, a synthesizer merges them.",
        args: {
          goal: z.string().describe("The goal description for the swarm"),
          workers: z.array(z.object({
            profile: z.string().describe("Worker profile name"),
            title: z.string().describe("Worker task title"),
            skills: z.array(z.string()).optional().describe("Skills for this worker"),
          })).describe("Array of worker specs"),
          verifier: z.string().describe("Verifier assignee profile"),
          synthesizer: z.string().describe("Synthesizer assignee profile"),
          repo: z.string().optional().describe("Repository path (enables worktree workspace)"),
        },
        execute: async (args) => {
          const workerSpecs = args.workers.map((w) => {
            const skills = w.skills?.join(",") ?? ""
            return skills ? `${w.profile}:${w.title}:${skills}` : `${w.profile}:${w.title}`
          })
          return sendAndFormat("kanban.swarm", {
            goal: args.goal,
            worker: workerSpecs,
            verifier: args.verifier,
            synthesizer: args.synthesizer,
            repo: args.repo,
          })
        },
      }),

      fleet_kanban_list: tool({
        description: "List tasks on the Fleet Kanban board, optionally filtered by status.",
        args: {
          status: z.string().optional().describe("Filter by status: triage, todo, ready, running, blocked, review, done, archived"),
        },
        execute: (args) => sendAndFormat("kanban.list", { status: args.status }),
      }),

      fleet_kanban_show: tool({
        description: "Show details for a specific Kanban task including body, assignee, status, links, and comments.",
        args: {
          taskId: z.string().describe("The task ID"),
        },
        execute: (args) => sendAndFormat("kanban.show", { id: args.taskId }),
      }),

      fleet_kanban_assign: tool({
        description: "Assign a Kanban task to a profile.",
        args: {
          taskId: z.string().describe("The task ID"),
          profile: z.string().describe("Profile name to assign"),
        },
        execute: (args) => sendAndFormat("kanban.assign", { id: args.taskId, profile: args.profile }),
      }),

      fleet_kanban_ready: tool({
        description: "Mark a Kanban task as ready for dispatch.",
        args: {
          taskId: z.string().describe("The task ID"),
        },
        execute: (args) => sendAndFormat("kanban.ready", { id: args.taskId }),
      }),

      fleet_kanban_block: tool({
        description: "Block a Kanban task with a reason.",
        args: {
          taskId: z.string().describe("The task ID"),
          reason: z.string().describe("Reason for blocking"),
        },
        execute: (args) => sendAndFormat("kanban.block", { id: args.taskId, reason: args.reason }),
      }),

      fleet_kanban_unblock: tool({
        description: "Unblock a previously blocked Kanban task.",
        args: {
          taskId: z.string().describe("The task ID"),
        },
        execute: (args) => sendAndFormat("kanban.unblock", { id: args.taskId }),
      }),

      fleet_kanban_archive: tool({
        description: "Archive a Kanban task.",
        args: {
          taskId: z.string().describe("The task ID"),
        },
        execute: (args) => sendAndFormat("kanban.archive", { id: args.taskId }),
      }),

      fleet_kanban_complete: tool({
        description: "Mark a Kanban task as complete with a result summary.",
        args: {
          taskId: z.string().describe("The task ID"),
          result: z.string().describe("Completion result/summary"),
        },
        execute: (args) => sendAndFormat("kanban.complete", { id: args.taskId, result: args.result }),
      }),

      fleet_kanban_comment: tool({
        description: "Add a comment to a Kanban task.",
        args: {
          taskId: z.string().describe("The task ID"),
          comment: z.string().describe("Comment text"),
        },
        execute: (args) => sendAndFormat("kanban.comment", { id: args.taskId, body: args.comment }),
      }),

      fleet_kanban_link: tool({
        description: "Link a parent task to a child task (creates a dependency).",
        args: {
          parentId: z.string().describe("Parent task ID"),
          childId: z.string().describe("Child task ID"),
        },
        execute: (args) => sendAndFormat("kanban.link", { parentId: args.parentId, childId: args.childId }),
      }),

      fleet_kanban_unlink: tool({
        description: "Remove a link between a parent and child task.",
        args: {
          parentId: z.string().describe("Parent task ID"),
          childId: z.string().describe("Child task ID"),
        },
        execute: (args) => sendAndFormat("kanban.unlink", { parentId: args.parentId, childId: args.childId }),
      }),

      fleet_kanban_log: tool({
        description: "Show the event log for a Kanban task.",
        args: {
          taskId: z.string().describe("The task ID"),
        },
        execute: (args) => sendAndFormat("kanban.log", { id: args.taskId }),
      }),

      fleet_kanban_dispatch: tool({
        description: "Trigger the kanban dispatcher to process the queue and start ready tasks.",
        args: {},
        execute: () => sendAndFormat("kanban.dispatch", {}),
      }),

      fleet_kanban_decompose: tool({
        description: "Decompose a triage task into a child-task graph using AI planning.",
        args: {
          taskId: z.string().describe("The triage task ID to decompose"),
        },
        execute: (args) => sendAndFormat("kanban.decompose", { id: args.taskId }),
      }),

      fleet_kanban_specify: tool({
        description: "Rewrite a triage task body into a fuller, more detailed specification.",
        args: {
          taskId: z.string().describe("The triage task ID to specify"),
        },
        execute: (args) => sendAndFormat("kanban.specify", { id: args.taskId }),
      }),

      // --- Open & Annotate ---

      fleet_open: tool({
        description: "Open files in Fleet tabs. Supports code files, images (png, jpg, gif, webp, svg, bmp, ico), markdown, and PDFs. Each file opens in the appropriate viewer.",
        args: {
          paths: z.array(z.string()).describe("One or more file paths to open"),
        },
        execute: async (args) => {
          const files = args.paths.map((p) => {
            const ext = p.toLowerCase().split(".").pop() ?? ""
            let paneType = "file"
            if (new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]).has(ext)) paneType = "image"
            else if (ext === "md" || ext === "markdown") paneType = "markdown"
            else if (ext === "pdf") paneType = "pdf"
            return { path: p, paneType, label: p.split("/").pop() ?? p }
          })
          return sendAndFormat("file.open", { files })
        },
      }),

      fleet_annotate: tool({
        description: "Open a browser window for visual web page annotation. Click elements, add comments, and capture annotated screenshots. Results written to a JSON file.",
        args: {
          url: z.string().optional().describe("URL to annotate. Omit for a blank page."),
          timeout: z.number().optional().describe("Max seconds to wait for annotation (default 300)"),
        },
        execute: (args) => sendAndFormat("annotate.start", { url: args.url, timeout: args.timeout }),
      }),
    },
  }
}
