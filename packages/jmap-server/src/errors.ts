/**
 * JMAP errors (RFC 8620 §3.6).
 *  - RequestError: request level, HTTP status + problem+json (RFC 7807)
 *  - MethodError:  method level, as ["error", {type, …}, callId]
 *  - SetError:     per object in notCreated/notUpdated/notDestroyed
 */
import type { JsonObject } from './types.js';

export class RequestError extends Error {
  constructor(
    public readonly type: string,
    public readonly status: number,
    public readonly detail?: string,
    public readonly extra: JsonObject = {},
  ) {
    super(detail ?? type);
  }
  toJson(): JsonObject {
    return {
      type: `urn:ietf:params:jmap:error:${this.type}`,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...this.extra,
    };
  }
}

export class MethodError extends Error {
  constructor(
    public readonly type: string,
    public readonly description?: string,
    public readonly extra: JsonObject = {},
  ) {
    super(description ?? type);
  }
  toJson(): JsonObject {
    return {
      type: this.type,
      ...(this.description ? { description: this.description } : {}),
      ...this.extra,
    };
  }
}

export interface SetError extends JsonObject {
  type: string;
  description?: string;
  properties?: string[];
}

export function setError(type: string, description?: string, properties?: string[]): SetError {
  return {
    type,
    ...(description ? { description } : {}),
    ...(properties ? { properties } : {}),
  };
}

export const invalidArguments = (d?: string): MethodError => new MethodError('invalidArguments', d);
export const forbidden = (d?: string): MethodError => new MethodError('forbidden', d);
export const accountReadOnly = (): MethodError => new MethodError('accountReadOnly');
export const cannotCalculateChanges = (): MethodError => new MethodError('cannotCalculateChanges');
export const stateMismatch = (): MethodError => new MethodError('stateMismatch');
export const unsupportedFilter = (d?: string): MethodError => new MethodError('unsupportedFilter', d);
export const unsupportedSort = (d?: string): MethodError => new MethodError('unsupportedSort', d);
export const requestTooLarge = (): MethodError => new MethodError('requestTooLarge');
export const anchorNotFound = (): MethodError => new MethodError('anchorNotFound');
