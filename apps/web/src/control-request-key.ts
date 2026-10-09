const compatibleKey = /^[A-Za-z0-9._:-]{8,120}$/

/** Keep existing successful operation identities; digest incompatible IDs in full. */
export async function controlRequestKey(requestId: string): Promise<string> {
  if (compatibleKey.test(requestId)) return requestId
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId))
  return `control-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
