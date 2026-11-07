import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { Session } from '@deepseek-ai/dsh-session'
import { captureNativeCheckpoint } from './checkpoint-compaction.js'

/** Replacement for the pinned profile's native `tool-result-pruner` row. */
export class CheckpointedToolResultPruner extends ToolResultPruner {
  static override inject = [...ToolResultPruner.inject, 'dshpaCheckpointPolicy']

  private readonly openTurns = new WeakSet<Session>()

  constructor(...args: ConstructorParameters<typeof ToolResultPruner>) {
    super(...args)
    const [ctx] = args
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') this.openTurns.add(session)
      if (event.type === 'turn/end' || event.type === 'session/end-seed') this.openTurns.delete(session)
    })
    ctx.provide('dshpaCheckpointPrunerReady', true)
  }

  override pruneSession(session: Session) {
    // V4 replay requires a turn around a tool-result replacement.
    if (!this.openTurns.has(session)) throw new ManualCompactionError('busy', 'Tool-result pruning requires an open turn')
    captureNativeCheckpoint(this.ctx, session, 'prune')
    return super.pruneSession(session)
  }
}

export default CheckpointedToolResultPruner
