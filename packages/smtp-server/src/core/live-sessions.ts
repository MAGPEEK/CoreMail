/**
 * v7.1.0: authenticated SMTP submission sessions end (421 4.7.0) when the
 * credentials they used become invalid — see LiveConnectionRegistry in
 * @coremail/core. server.ts attaches the registry to the auth bus.
 */
import { LiveConnectionRegistry } from '@coremail/core';

export const smtpLiveSessions = new LiveConnectionRegistry('smtp');
