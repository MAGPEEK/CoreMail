import { registerMethod } from '../dispatcher.js';
import { CAP_CORE } from '../capabilities.js';

/** Core/echo (RFC 8620 §4) — gibt die Argumente unverändert zurück. */
registerMethod('Core/echo', CAP_CORE, async (args) => args);
