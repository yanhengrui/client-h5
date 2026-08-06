import type { AckFrame, ClientFrame, CommandFrame, EventFrame, PlotPatch, ServerFrame, SubscribeFarmFrame } from './frame-contract'
import { parseServerFrame } from './frame-contract'
import { createUuidV7 } from '../shared/uuid-v7'

export type SocketPhase = 'idle' | 'connecting' | 'open' | 'backoff' | 'closed'
export type WsLog = {
  id: string
  at: string
  direction: 'in' | 'out' | 'system'
  type: string
  detail: string
}

type SocketCallbacks = {
  onPhase: (phase: SocketPhase) => void
  onAck: (frame: AckFrame) => void
  onEvent: (frame: EventFrame) => void
  onLog: (log: WsLog) => void
  onOpen: () => void
}

const delays = [250, 500, 1000, 2000, 5000]

export class FarmSocket {
  private socket: WebSocket | null = null
  private reconnectTimer?: number
  private attempts = 0
  private manuallyClosed = false
  private clientSeq = 0
  private token = ''

  constructor(private readonly callbacks: SocketCallbacks) {}

  get sequence() { return this.clientSeq }
  get isOpen() { return this.socket?.readyState === WebSocket.OPEN }

  connect(token: string) {
    this.token = token
    this.manuallyClosed = false
    window.clearTimeout(this.reconnectTimer)
    if (this.socket) {
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null
      this.socket.close()
    }
    this.callbacks.onPhase('connecting')
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempts = 0
      this.callbacks.onPhase('open')
      this.log('system', 'OPEN', 'WebSocket 已连接')
      this.callbacks.onOpen()
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      const frame = parseServerFrame(String(event.data))
      if (!frame) {
        this.log('in', 'INVALID', '无法解析的服务端帧')
        return
      }
      this.logFrame('in', frame)
      if (frame.meta.type === 'ACK') this.callbacks.onAck(frame as AckFrame)
      else this.callbacks.onEvent(frame as EventFrame)
    }
    socket.onerror = () => {
      if (this.socket === socket) this.log('system', 'ERROR', 'WebSocket 连接异常')
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.callbacks.onPhase('closed')
      this.log('system', `CLOSE ${event.code}`, event.reason || '连接关闭')
      if (!this.manuallyClosed && event.code !== 4005) this.scheduleReconnect()
    }
  }

  disconnect() {
    this.manuallyClosed = true
    window.clearTimeout(this.reconnectTimer)
    if (this.socket) {
      this.socket.onclose = null
      this.socket.close(1000, 'manual close')
    }
    this.socket = null
    this.callbacks.onPhase('closed')
  }

  reconnect() {
    this.disconnect()
    this.manuallyClosed = false
    this.connect(this.token)
  }

  command(method: string, farmId: string, baseVersion: string, body: Record<string, unknown>): string {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('实时连接未就绪')
    this.clientSeq += 1
    const cmdId = createCommandId()
    const frame: CommandFrame = {
      meta: {
        type: 'COMMAND',
        method,
        client_seq: this.clientSeq,
        cmd_id: cmdId,
        farm_id: farmId,
        base_version: baseVersion,
        protocol_version: '1',
      },
      body,
    }
    this.socket.send(JSON.stringify(frame))
    this.logFrame('out', frame)
    return cmdId
  }

  subscribeFarm(farmId: string, snapshotVersion: string): string {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('实时连接尚未就绪')
    this.clientSeq += 1
    const cmdId = createCommandId()
    const frame = createSubscribeFarmFrame(farmId, snapshotVersion, this.clientSeq, cmdId)
    this.socket.send(JSON.stringify(frame))
    this.logFrame('out', frame)
    return cmdId
  }

  private scheduleReconnect() {
    const delay = delays[Math.min(this.attempts, delays.length - 1)]
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4))
    this.attempts += 1
    this.callbacks.onPhase('backoff')
    this.reconnectTimer = window.setTimeout(() => this.connect(this.token), jittered)
  }

  private log(direction: WsLog['direction'], type: string, detail: string) {
    this.callbacks.onLog({ id: crypto.randomUUID(), at: new Date().toISOString(), direction, type, detail })
  }

  private logFrame(direction: 'in' | 'out', frame: ServerFrame | ClientFrame) {
    const patch = (frame.body as { patch?: PlotPatch }).patch
    const detail = [frame.meta.cmd_id && `cmd ${frame.meta.cmd_id.slice(0, 8)}`, frame.meta.server_seq && `seq ${frame.meta.server_seq}`, patch && `plot ${patch.plot_id}`].filter(Boolean).join(' · ')
    this.log(direction, frame.meta.type, detail || 'frame')
  }
}

export function createCommandId(): string {
  return createUuidV7()
}

export function createSubscribeFarmFrame(farmId: string, snapshotVersion: string, clientSeq?: number, cmdId?: string): SubscribeFarmFrame {
  return {
    meta: {
      type: 'SUBSCRIBE_FARM',
      farm_id: farmId,
      protocol_version: '1',
      ...(clientSeq === undefined ? {} : { client_seq: clientSeq }),
      ...(cmdId === undefined ? {} : { cmd_id: cmdId }),
    },
    body: { snapshot_version: snapshotVersion },
  }
}
