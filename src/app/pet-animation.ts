import type { FarmSnapshot } from '../api/contract'
import type { FarmState } from '../state/app-state'
import { withEffectiveGrowthStage } from '../api/contract'
import type { EventFrame } from '../realtime/frame-contract'

export type PetHarvestCue = {
  eventId: string
  plotId: number
}

type DetectionInput = {
  hasPet: boolean
  farm: FarmState | null
  ownFarmId?: string
  pendingPlotIds: number[]
  frame: EventFrame
  nowMs: number
}

export function detectPetHarvest(input: DetectionInput): PetHarvestCue | null {
  const { hasPet, farm, ownFarmId, pendingPlotIds, frame, nowMs } = input
  const patch = frame.body.patch
  if (!hasPet || !farm || farm.farm_id !== ownFarmId || patch.state !== 'EMPTY') return null
  if (frame.body.command_type && frame.body.command_type !== 'PET_AUTO_HARVEST') return null
  if (String(frame.body.actor_user_id) !== String(farm.owner_user_id)) return null
  if (pendingPlotIds.includes(patch.plot_id)) return null

  const previousPlot = farm.plots.find((plot) => plot.plot_id === patch.plot_id)
  if (!previousPlot || withEffectiveGrowthStage(previousPlot, nowMs).growth_stage !== 'MATURE') return null
  return { eventId: frame.body.event_id, plotId: patch.plot_id }
}

type SnapshotDetectionInput = {
  hasPet: boolean
  autoHarvestEnabled: boolean
  farm: FarmState | null
  snapshot: FarmSnapshot
  ownFarmId?: string
  pendingPlotIds: number[]
  nowMs: number
}

// Redis Pub/Sub is intentionally best-effort. When a browser misses one event,
// a quiet authoritative snapshot can still identify the single mature plot the
// pet cleared and replay the same visual cue without waiting for another action.
export function detectPetHarvestsFromSnapshot(input: SnapshotDetectionInput): PetHarvestCue[] {
  const { hasPet, autoHarvestEnabled, farm, snapshot, ownFarmId, pendingPlotIds, nowMs } = input
  if (!hasPet || !autoHarvestEnabled || !farm || farm.farm_id !== ownFarmId || snapshot.farm_id !== ownFarmId) return []

  const nextPlots = new Map(snapshot.plots.map((plot) => [plot.plot_id, plot]))
  return farm.plots
    .filter((plot) => {
      const next = nextPlots.get(plot.plot_id)
      return next?.status === 'EMPTY'
        && !pendingPlotIds.includes(plot.plot_id)
        && withEffectiveGrowthStage(plot, nowMs).growth_stage === 'MATURE'
    })
    .sort((a, b) => a.plot_id - b.plot_id)
    .map((plot) => ({
      eventId: `pet-reconcile:${snapshot.farm_id}:${snapshot.version}:${plot.plot_id}`,
      plotId: plot.plot_id,
    }))
}
