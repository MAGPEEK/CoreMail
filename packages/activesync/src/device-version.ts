/**
 * The protocol version a request is served with, per device: negotiation
 * (protocol-version.ts), the device's remembered version, and a warning — once per device —
 * when a client names a version this server does not announce (served as the highest one).
 *
 * I/O through injected deps (server.ts wires Prisma and the logger).
 */
import { negotiateVersion, type EasVersion } from './protocol-version.js';

/** The device row as far as the version is concerned (null = not registered yet). */
export interface DeviceVersionRow {
  id: string;
  protocolVersion: string | null;
}

export interface DeviceVersionDeps {
  /** Stores the version on the device row (fallback for its requests without a version). */
  saveVersion: (deviceRowId: string, version: EasVersion) => Promise<unknown>;
  warn: (fields: Record<string, unknown>, message: string) => void;
  /** Remembers which devices were warned about already. */
  warned: { first: (key: string) => boolean };
}

/**
 * `first(key)` is true the first time a key is seen — e.g. "warn once per device". At most
 * `capacity` keys are remembered; when full, the memory starts over (a key may then be
 * reported again), so client-chosen keys cannot grow it without bound.
 */
export function oncePerKey(capacity: number): { first: (key: string) => boolean } {
  const seen = new Set<string>();
  return {
    first(key) {
      if (seen.has(key)) return false;
      if (seen.size >= capacity) seen.clear();
      seen.add(key);
      return true;
    },
  };
}

/** Devices remembered for the once-per-device warning (bounded: device ids are client input). */
const WARNED_DEVICES_CAPACITY = 10_000;
export const warnedDevices = oncePerKey(WARNED_DEVICES_CAPACITY);
/** The requested version is client input: logged at most this long. */
const LOGGED_VERSION_MAX = 32;

export async function versionForDevice(
  request: { userId: string; deviceId: string; requested: string },
  device: DeviceVersionRow | null,
  deps: DeviceVersionDeps,
): Promise<EasVersion> {
  const { version, unannounced } = negotiateVersion(request.requested, device?.protocolVersion);
  if (unannounced && deps.warned.first(`${request.userId}\n${request.deviceId}`)) {
    deps.warn(
      { userId: request.userId, deviceId: request.deviceId, requested: unannounced.slice(0, LOGGED_VERSION_MAX), servedAs: version },
      'EAS protocol version not announced by this server — served as the highest announced version (logged once per device)',
    );
  }
  if (device && device.protocolVersion !== version) await deps.saveVersion(device.id, version);
  return version;
}
