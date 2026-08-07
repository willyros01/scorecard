/* Single source of truth for the version.
 *
 * Loaded as a classic script by index.html AND by sw.js via importScripts, so
 * bumping this one line updates the Summary screen and busts the offline cache
 * at the same time. It is the only place you need to edit when you ship a change.
 */
self.APP_VERSION = "1.2.2";
self.APP_BUILD = "2026-08-06";
