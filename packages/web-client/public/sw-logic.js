/*
 * 9.4 service worker logic of the webmail (pure; loaded by sw.js with
 * importScripts, unit-tested in src/lib/swLogic.test.ts through node:vm).
 * Classic script — no modules, no build step: it is served as is.
 */
(function (scope) {
  'use strict';

  var FALLBACK_TITLE = 'Neue Nachricht';
  var FALLBACK_URL = '/mail';
  var DEFAULT_ICON = '/favicon.svg';

  /**
   * A same-origin path ("/…")? Never "//host" or "/\host", and no whitespace,
   * control characters or backslashes anywhere: URL parsing drops tabs and line
   * breaks, so "/<TAB>/host" would otherwise turn into "//host".
   */
  var BACKSLASH = 0x5c;

  function isSafePath(url) {
    if (typeof url !== 'string' || url.length > 2048 || url.charAt(0) !== '/' || url.charAt(1) === '/') return false;
    for (var i = 0; i < url.length; i++) {
      var c = url.charCodeAt(i);
      if (c <= 0x20 || c === 0x7f || c === BACKSLASH) return false; // whitespace, control, backslash
    }
    return true;
  }

  function safePath(url) {
    return isSafePath(url) ? url : FALLBACK_URL;
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  /** Title + showNotification() options for a push payload (JSON text from the gateway). */
  function notificationFromPush(text) {
    var p = {};
    try { p = JSON.parse(text) || {}; } catch (e) { p = {}; }
    if (typeof p !== 'object' || Array.isArray(p)) p = {};
    var options = {
      body: str(p.body),
      icon: isSafePath(p.icon) ? p.icon : DEFAULT_ICON,
      data: { url: safePath(p.url) },
    };
    if (str(p.tag)) options.tag = p.tag;
    return { title: str(p.title) || FALLBACK_TITLE, options: options };
  }

  /** Where a click on the notification leads. */
  function clickTarget(data) {
    return safePath(data && data.url);
  }

  /** The webmail window to reuse: focused, else visible, else the first one. */
  function pickClient(clients) {
    var list = (clients || []).filter(function (c) { return c && c.type === 'window'; });
    for (var i = 0; i < list.length; i++) if (list[i].focused) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].visibilityState === 'visible') return list[j];
    return list[0] || null;
  }

  scope.CoreMailSw = {
    OPEN_MESSAGE_TYPE: 'coremail:open',
    notificationFromPush: notificationFromPush,
    clickTarget: clickTarget,
    pickClient: pickClient,
  };
})(self);
