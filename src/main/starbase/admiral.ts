import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import { buildAdmiralSystemPrompt } from './admiral-system-prompt'
import { ADMIRAL_TOOLS, dispatchTool } from './admiral-tools'
import type { AdmiralToolDeps } from './admiral-tools'
import type { SectorService } from './sector-service'
import type { MissionService } from './mission-service'
import type { CrewService } from './crew-service'
import type { CommsService } from './comms-service'
import type { ConfigService } from './config-service'

type AdmiralMessage = Anthropic.MessageParam

export type AdmiralChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'done' }
  | { type: 'error'; error: string }

type AdmiralDeps = {
  workspacePath: string
  sectorService: SectorService
  missionService: MissionService
  crewService: CrewService
  commsService: CommsService
  configService: ConfigService
  toolDeps: AdmiralToolDeps
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const MAX_HISTORY_TOKENS_ESTIMATE = 160000
const AVG_CHARS_PER_TOKEN = 4
const MAX_HISTORY_CHARS = MAX_HISTORY_TOKENS_ESTIMATE * AVG_CHARS_PER_TOKEN

export class Admiral {
  private client: Anthropic | null = null
  private lastApiKey: string | undefined
  private history: AdmiralMessage[] = []
  private deps: AdmiralDeps

  constructor(deps: AdmiralDeps) {
    this.deps = deps
  }

  private getClient(): Anthropic {
    // Re-read key each time so config changes take effect without restart
    const configKey = this.deps.configService.get('anthropic_api_key') as string | undefined
    const apiKey = configKey || process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      throw new Error('Set your ANTHROPIC_API_KEY environment variable to use Star Command.')
    }

    // Re-create client if key changed
    if (!this.client || this.lastApiKey !== apiKey) {
      this.client = new Anthropic({ apiKey })
      this.lastApiKey = apiKey
    }
    return this.client
  }

  private getModel(): string {
    return (this.deps.configService.get('admiral_model') as string) || DEFAULT_MODEL
  }

  private buildSystemPrompt(): string {
    const { sectorService, missionService, crewService, commsService, workspacePath } = this.deps
    return buildAdmiralSystemPrompt({
      workspacePath,
      sectors: sectorService.listSectors().map((s) => ({
        id: s.id,
        name: s.name,
        root_path: s.root_path,
        stack: s.stack,
        base_branch: s.base_branch
      })),
      crew: crewService.listCrew().map((c) => ({
        id: c.id,
        sector_id: c.sector_id,
        status: c.status,
        mission_summary: c.mission_summary
      })),
      missions: missionService.listMissions().map((m) => ({
        id: m.id,
        sector_id: m.sector_id,
        status: m.status,
        summary: m.summary
      })),
      unreadComms: commsService.getUnread('admiral').map((c) => ({
        id: c.id,
        from_crew: c.from_crew,
        type: c.type,
        payload: c.payload,
        created_at: c.created_at
      }))
    })
  }

  private trimHistoryIfNeeded(): void {
    const estimatedChars = JSON.stringify(this.history).length
    if (estimatedChars <= MAX_HISTORY_CHARS) return

    // Keep the last ~75% of messages, summarize the rest
    const keepCount = Math.max(2, Math.floor(this.history.length * 0.75))
    const toSummarize = this.history.slice(0, this.history.length - keepCount)
    const kept = this.history.slice(this.history.length - keepCount)

    const summaryParts: string[] = []
    for (const msg of toSummarize) {
      if (typeof msg.content === 'string') {
        summaryParts.push(`${msg.role}: ${msg.content.slice(0, 200)}`)
      }
    }

    this.history = [
      {
        role: 'user',
        content: `[Session summary of earlier conversation:\n${summaryParts.join('\n')}\n...end summary]`
      },
      {
        role: 'assistant',
        content: 'Understood. I have the context from our earlier conversation.'
      },
      ...kept
    ]
  }

  async *sendMessage(content: string): AsyncGenerator<AdmiralChunk> {
    const client = this.getClient()
    const model = this.getModel()
    const systemPrompt = this.buildSystemPrompt()

    this.history.push({ role: 'user', content })
    this.trimHistoryIfNeeded()

    let continueLoop = true

    while (continueLoop) {
      continueLoop = false

      let response: Anthropic.Message
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          tools: ADMIRAL_TOOLS,
          messages: this.history
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown API error'

        // Handle rate limiting
        if (err instanceof Anthropic.RateLimitError) {
          yield { type: 'error', error: 'Admiral is rate-limited. Please try again in a moment.' }
          return
        }

        yield { type: 'error', error: errorMsg }
        return
      }

      // Build the assistant message content for history
      const assistantContent: Anthropic.ContentBlockParam[] = []
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of response.content) {
        if (block.type === 'text') {
          assistantContent.push({ type: 'text', text: block.text })
          yield { type: 'text', text: block.text }
        } else if (block.type === 'tool_use') {
          assistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>
          })
          yield {
            type: 'tool_use',
            name: block.name,
            input: block.input as Record<string, unknown>
          }

          // Execute tool
          let toolResult: string
          try {
            toolResult = await dispatchTool(
              block.name,
              block.input as Record<string, unknown>,
              this.deps.toolDeps
            )
          } catch (err) {
            toolResult = JSON.stringify({
              error: err instanceof Error ? err.message : 'Tool execution failed'
            })
          }

          yield { type: 'tool_result', name: block.name, result: toolResult }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: toolResult
          })
        }
      }

      // Add assistant message to history
      this.history.push({ role: 'assistant', content: assistantContent })

      // If there were tool calls, feed results back and continue
      if (toolResults.length > 0) {
        this.history.push({ role: 'user', content: toolResults })
        continueLoop = response.stop_reason === 'tool_use'
      }
    }

    yield { type: 'done' }
  }

  /**
   * Review a PR using the Anthropic API.
   * Fetches the PR diff, evaluates it against acceptance criteria,
   * and returns a verdict (pass, request-changes, or reject).
   */
  async reviewPR(opts: {
    prNumber: number
    missionId: number
    sectorPath: string
  }): Promise<{ verdict: 'pass' | 'request-changes' | 'reject'; notes: string }> {
    const { prNumber, missionId, sectorPath } = opts
    const client = this.getClient()
    const model = this.getModel()
    const { missionService } = this.deps

    // 1. Fetch PR diff (truncate to fit context)
    let diff = ''
    try {
      diff = execSync(`gh pr diff ${prNumber}`, {
        cwd: sectorPath,
        stdio: 'pipe',
        timeout: 30_000
      }).toString()
      if (diff.length > 10000) {
        diff = diff.slice(0, 10000) + '\n... [truncated]'
      }
    } catch {
      diff = '[Failed to fetch PR diff]'
    }

    // 2. Get acceptance criteria from mission
    const mission = missionService.getMission(missionId)
    const acceptanceCriteria = mission?.acceptance_criteria || 'No acceptance criteria specified.'

    // 3. Call Anthropic API for evaluation
    const reviewPrompt = `You are reviewing a pull request for code quality and correctness.

## Acceptance Criteria
${acceptanceCriteria}

## PR Diff
\`\`\`
${diff}
\`\`\`

Evaluate the PR diff against the acceptance criteria. For each criterion, state whether it is met or not.

Then provide your overall verdict as one of:
- "pass" — all criteria met, code looks good
- "request-changes" — mostly good but needs specific fixes
- "reject" — fundamentally wrong approach or major issues

Respond in this exact JSON format:
{
  "verdict": "pass" | "request-changes" | "reject",
  "notes": "Your detailed review notes here"
}`

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: reviewPrompt }]
      })

      // Parse response
      let responseText = ''
      for (const block of response.content) {
        if (block.type === 'text') {
          responseText += block.text
        }
      }

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*"verdict"[\s\S]*"notes"[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { verdict: string; notes: string }
        const verdict = (
          ['pass', 'request-changes', 'reject'].includes(parsed.verdict)
            ? parsed.verdict
            : 'request-changes'
        ) as 'pass' | 'request-changes' | 'reject'

        // 4. Store verdict in mission
        missionService.setReviewVerdict(missionId, verdict, parsed.notes)

        // 5. Apply verdict via gh CLI
        try {
          if (verdict === 'pass') {
            execSync(
              `gh pr review ${prNumber} --approve --body "Admiral review: approved. ${parsed.notes.slice(0, 200)}"`,
              {
                cwd: sectorPath,
                stdio: 'pipe'
              }
            )
            missionService.setStatus(missionId, 'completed')
          } else if (verdict === 'request-changes') {
            execSync(
              `gh pr review ${prNumber} --request-changes --body "${parsed.notes.replace(/"/g, '\\"').slice(0, 2000)}"`,
              {
                cwd: sectorPath,
                stdio: 'pipe'
              }
            )
            missionService.setStatus(missionId, 'changes-requested')
          } else {
            execSync(
              `gh pr close ${prNumber} --comment "Admiral review: rejected. ${parsed.notes.replace(/"/g, '\\"').slice(0, 500)}"`,
              {
                cwd: sectorPath,
                stdio: 'pipe'
              }
            )
            missionService.setStatus(missionId, 'rejected')
          }
        } catch {
          // gh command failed — verdict is still stored in DB
        }

        return { verdict, notes: parsed.notes }
      }

      // Failed to parse — default to request-changes
      const fallbackNotes = `Could not parse review response. Raw: ${responseText.slice(0, 500)}`
      missionService.setReviewVerdict(missionId, 'request-changes', fallbackNotes)
      return { verdict: 'request-changes', notes: fallbackNotes }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      missionService.setReviewVerdict(missionId, 'request-changes', `Review failed: ${errorMsg}`)
      return { verdict: 'request-changes', notes: `Review failed: ${errorMsg}` }
    }
  }

  getHistory(): AdmiralMessage[] {
    return [...this.history]
  }

  resetSession(): void {
    this.history = []
  }
}
