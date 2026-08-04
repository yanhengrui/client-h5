export function createUuidV7(now = Date.now()): string {
  const bytes = new Uint8Array(16)
  const timestamp = BigInt(now)

  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  crypto.getRandomValues(bytes.subarray(6))

  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
