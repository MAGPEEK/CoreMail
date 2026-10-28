/** Server limits for the session (RFC 8620 §2) — no DB dependency so tests can load them. */
export interface JmapLimits {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  maxSizeAttachmentsPerEmail: number;
}

export const LIMITS: JmapLimits = {
  maxSizeUpload: 50 * 1024 * 1024,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxCallsInRequest: 64,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxSizeAttachmentsPerEmail: 25 * 1024 * 1024,
};
