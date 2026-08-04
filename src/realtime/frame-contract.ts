export type PlotPatch = {
  plot_id: number
  state?: string
  crop_id?: string
  planted_at?: string
  mature_at?: string
  growth_stage?: string
  remaining_yield?: number
  yield?: number
}

type Meta = {
  type: 'COMMAND' | 'SUBSCRIBE_FARM' | 'ACK' | 'EVENT'
  method?: string
  client_seq?: number
  server_seq?: number
  cmd_id?: string
  farm_id?: string
  base_version?: string
  protocol_version?: string
}

export type CommandFrame = { meta: Meta & { type: 'COMMAND' }; body: Record<string, unknown> }
export type SubscribeFarmFrame = {
  meta: Meta & { type: 'SUBSCRIBE_FARM'; farm_id: string }
  body: { snapshot_version: string }
}
export type AckFrame = {
  meta: Meta & { type: 'ACK'; cmd_id?: string }
  body: { result: string; new_version?: string; patch?: PlotPatch; replayed?: boolean; retry_after_ms?: number }
}
export type EventFrame = {
  meta: Meta & { type: 'EVENT' }
  body: { event_id: string; version: string; patch: PlotPatch; actor_user_id: string; command_type?: string }
}
export type ClientFrame = CommandFrame | SubscribeFarmFrame
export type ServerFrame = AckFrame | EventFrame

export function parseServerFrame(raw: string): ServerFrame | null {
  try {
    const value = JSON.parse(raw) as Partial<ServerFrame>
    if (!value.meta || !value.body || (value.meta.type !== 'ACK' && value.meta.type !== 'EVENT')) return null
    return value as ServerFrame
  } catch {
    return null
  }
}
