export const NETWORK_EVIDENCE_MESSAGE_TYPES: {
  readonly REQUEST: string
  readonly AVAILABLE: string
}

export const MAX_EVIDENCE_PER_DOCUMENT: number
export const MAX_EVIDENCE_DOCUMENTS: number
export const EVIDENCE_TTL_MS: number
export const MAX_EVIDENCE_URL_LENGTH: number
export const COMPLETE_MEDIA_TYPES: ReadonlyArray<string>

export interface NetworkEvidence {
  url: string
  contentType: string
  container: string
  totalBytes: number
  completeFile: boolean
  statusCode: number
  observedAt: number
}

export interface EvidenceIdentity {
  tabId: number
  frameId: number
  documentId?: string | null
}

export function normalizeEvidenceUrl(value: unknown): string | null
export function normalizeContentType(value: unknown): string | null
export function parseContentRange(
  value: unknown
): { start: number; end: number; total: number | null } | null
export function parseContentLength(value: unknown): number | null
export function evaluateResponseEvidence(
  input: Record<string, unknown>,
  now?: number
):
  | { ok: true; evidence: NetworkEvidence }
  | { ok: false; reason: string }
export function evidenceForMessage(
  evidence: Partial<NetworkEvidence> | null | undefined
): NetworkEvidence | null
export function createNetworkEvidenceStore(options?: {
  now?: () => number
  maximumPerDocument?: number
  maximumDocuments?: number
  ttlMs?: number
}): {
  record(
    input: Record<string, unknown>,
    identity: EvidenceIdentity
  ): NetworkEvidence | null
  get(identity: EvidenceIdentity, rawUrl: unknown): NetworkEvidence | null
  clearTab(tabId: number): void
  clearAll(): void
  count(): number
}
export function requestNetworkEvidenceForSender(
  chromeApi: unknown,
  message: unknown,
  sender: unknown,
  deps: {
    store: ReturnType<typeof createNetworkEvidenceStore>
    enabled: boolean
  }
): Promise<
  | { ok: true; evidence: NetworkEvidence | null }
  | { ok: false; error: { code: string; message: string } }
>
export function installNetworkObservation(
  chromeApi: unknown,
  options?: {
    store?: ReturnType<typeof createNetworkEvidenceStore>
    onEvidence?: (tabId: number, evidence: NetworkEvidence) => void
  }
): {
  store: ReturnType<typeof createNetworkEvidenceStore>
  install(): boolean
  setEnabled(value: boolean): void
  setPermissionGranted(value: boolean): void
  isEnabled(): boolean
  clearTab(tabId: number): void
}
