import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Session } from '@deepseek-ai/dsh-session'

export type NativeCheckpointCapture =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unmanaged'; readonly isCurrent?: () => boolean }
  | { readonly kind: 'managed'; readonly summary: string; readonly isCurrent: () => boolean }

export interface NativeCheckpointPolicy {
  /** Commit the exact application checkpoint before returning a managed decision. */
  capture(session: Session, operation: 'compact' | 'prune'): NativeCheckpointCapture
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshpaCheckpointPolicy: NativeCheckpointPolicy
    dshpaCheckpointCompactionReady: true
    dshpaCheckpointPrunerReady: true
  }
}

type CurrentCapture = Exclude<NativeCheckpointCapture, { kind: 'unavailable' }>
const MAX_SUMMARY_BYTES = 8_192

function unavailable(): ManualCompactionError {
  return new ManualCompactionError('persistence', 'The personal context checkpoint is unavailable')
}

function assertCurrent(capture: CurrentCapture): void {
  try {
    if (capture.isCurrent === undefined || capture.isCurrent() === true) return
  } catch { /* A failed scope check closes this compaction path. */ }
  throw unavailable()
}

export function captureNativeCheckpoint(
  ctx: Context, session: Session, operation: 'compact' | 'prune',
): CurrentCapture {
  let decision: NativeCheckpointCapture | undefined
  try { decision = ctx.get('dshpaCheckpointPolicy')?.capture(session, operation) } catch { throw unavailable() }
  if (decision?.kind !== 'unmanaged' && (decision?.kind !== 'managed' || typeof decision.isCurrent !== 'function'
    || typeof decision.summary !== 'string' || !decision.summary.trim() || Buffer.byteLength(decision.summary) > MAX_SUMMARY_BYTES)) {
    throw unavailable()
  }
  assertCurrent(decision)
  return decision
}

interface CompactionRun {
  readonly session: Session
  readonly capture: CurrentCapture
}

/** Replacement for the pinned profile's native `compaction-basic` row. */
export class CheckpointedCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'dshpaCheckpointPolicy']

  private readonly checkpointRuns = new AsyncLocalStorage<CompactionRun>()

  constructor(...args: ConstructorParameters<typeof BasicCompactionEngine>) {
    super(...args)
    args[0].provide('dshpaCheckpointCompactionReady', true)
  }

  override compactNow(...args: Parameters<BasicCompactionEngine['compactNow']>) {
    const [agent, signal] = args
    return this.withCheckpoint(agent, signal, () => super.compactNow(...args))
  }

  override async compactRegion(...args: Parameters<BasicCompactionEngine['compactRegion']>) {
    const [, , agent, signal] = args
    return this.withCheckpoint(agent, signal, () => super.compactRegion(...args))
  }

  private withCheckpoint<T>(agent: Agent, signal: AbortSignal | undefined, invoke: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const { session } = agent
    const capture = captureNativeCheckpoint(this.ctx, session, 'compact')
    signal?.throwIfAborted()
    // Basic reserves manual maintenance synchronously. Keep the checkpoint
    // write and that reservation in the same call before returning its promise.
    return this.checkpointRuns.run({ session, capture }, invoke)
  }

  protected override async summarize(
    ...args: Parameters<BasicCompactionEngine['summarize']>
  ): ReturnType<BasicCompactionEngine['summarize']> {
    const [, agent, signal] = args
    signal?.throwIfAborted()
    const run = this.checkpointRuns.getStore()
    if (!run || run.session !== agent.session) throw unavailable()
    assertCurrent(run.capture)
    if (run.capture.kind === 'unmanaged') return super.summarize(...args)
    return {
      summary: [{ type: 'text' as const, text: run.capture.summary }],
      provider: 'dshpa-local', model: 'structured-checkpoint-v1',
    }
  }
}

export default CheckpointedCompactionEngine
