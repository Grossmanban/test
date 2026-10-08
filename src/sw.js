/* Service worker of «Домашняя бухгалтерия» (PWA build only).
   tools/build.mjs fills in the two placeholders below: the build version (it changes whenever any
   shipped byte changes) and the app-shell files to precache, as URLs relative to the scope ("./").
   The app is served from a subpath (https://<user>.github.io/<repo>/), so every URL is resolved
   against the registration scope, never against the origin root.

   Strategy
   - install:  precache the whole shell into a cache named after VERSION (bypassing the HTTP cache)
               and check that the cached index.html only needs scripts/styles of this version.
               No automatic skipWaiting: the page asks for it ({type: "SKIP_WAITING"}) when the user
               accepts the update, so a running app never mixes files of two versions.
   - activate: delete this app's caches of other versions, then clients.claim().
   - fetch:    only same-origin GET requests are handled; Supabase (API, auth, realtime) and any other
               cross-origin request is left to the browser untouched.
               · navigations to the app → cached index.html first, network as a fallback; in the
                 background the network copy is compared with the cached one and, if it differs,
                 registration.update() fetches the new service worker, which precaches the new
                 shell as a whole (the cached copy is never patched in place: a newer index.html
                 would point at hashed files this version does not have, and break offline use)
               · precached files → cache first
               · anything else in scope → network first, cache as a fallback
   - message:  {type: "SKIP_WAITING"} → skipWaiting();
               {type: "GET_VERSION"} with a MessagePort → replies {version} on that port */
(() => {
  "use strict";

  const VERSION = "__BUILD_VERSION__";
  const PRECACHE = __PRECACHE_LIST__;

  const SCOPE = self.registration.scope;                    // e.g. https://grossmanban.github.io/test/
  const SCOPE_PATH = new URL(SCOPE).pathname;               // e.g. /test/
  // CacheStorage is shared by the whole origin (all GitHub Pages projects of a user), so cache names
  // carry the scope, and only caches of this app are ever deleted.
  const APP = `budget-pwa:${SCOPE_PATH}`;
  const CACHE = `${APP}:${VERSION}`;
  const abs = u => new URL(u, SCOPE).href;
  const SHELL = abs("./index.html");
  const ROOT = abs("./");
  const PRECACHED = new Set(PRECACHE.map(abs));
  const MATCH = { ignoreVary: true };

  const cacheable = res => !!res && res.status === 200 && res.type === "basic";

  // Safari refuses redirected responses for navigations: re-wrap them
  function clean(res) {
    if (!res || !res.redirected) return res;
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  function offlinePage() {
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Домашняя бухгалтерия</title>
<body style="margin:0;padding:32px 24px;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#edf1ef;color:#101c18">
<h1 style="font-size:20px;margin:0 0 8px">Нет соединения</h1>
<p style="margin:0">Приложение ещё не сохранено на этом устройстве. Откройте его один раз при подключении к интернету — дальше оно будет работать и без сети.</p>
</body></html>`;
    return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  self.addEventListener("install", event => {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      // cache: "reload" — GitHub Pages sends max-age=600; a stale index.html from the HTTP cache
      // would reference asset hashes of the previous version
      await cache.addAll(PRECACHE.map(u => new Request(abs(u), { cache: "reload" })));
      // never activate a shell whose index.html needs scripts/styles this version does not have
      // (e.g. a CDN edge still serving the previous index.html during a deploy): fail the install,
      // the browser retries on its next update check
      const shell = await cache.match(SHELL, MATCH);
      const missing = shellAssets(shell ? await shell.text() : "").filter(u => !PRECACHED.has(u));
      if (!shell || missing.length) throw new Error(`inconsistent app shell, missing: ${missing.join(", ") || "index.html"}`);
    })());
  });

  // same-origin <script src> and <link rel="stylesheet" href> of an HTML document, as absolute URLs
  function shellAssets(html) {
    const urls = [];
    for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const attr = name => (tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1];
      const url = /^<script/i.test(tag) ? attr("src") : /(^|\s)stylesheet(\s|$)/i.test(attr("rel") || "") ? attr("href") : null;
      if (!url) continue;
      const href = new URL(url, SCOPE);
      if (href.origin === self.location.origin) urls.push(href.origin + href.pathname + href.search);
    }
    return urls;
  }

  self.addEventListener("activate", event => {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith(`${APP}:`) && k !== CACHE).map(k => caches.delete(k)));
      await self.clients.claim();
    })());
  });

  self.addEventListener("message", event => {
    const data = event.data || {};
    if (data.type === "SKIP_WAITING") self.skipWaiting();
    else if (data.type === "GET_VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
  });

  self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;               // Supabase & co: not ours
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
    if (req.headers.has("range")) return;
    if (req.mode === "navigate") { event.respondWith(navigation(event, url)); return; }
    const key = url.origin + url.pathname + url.search;
    if (PRECACHED.has(key)) { event.respondWith(cacheFirst(event, key)); return; }
    if (!url.href.startsWith(SCOPE)) return;                        // other projects on the same origin
    event.respondWith(networkFirst(event));
  });

  async function navigation(event, url) {
    const cache = await caches.open(CACHE);
    const isApp = url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`;
    if (isApp) {
      const cached = (await cache.match(SHELL, MATCH)) || (await cache.match(ROOT, MATCH));
      if (cached) {
        event.waitUntil(revalidate(cached.clone()));
        return clean(cached);
      }
      try { return await fetch(event.request); } catch { return offlinePage(); }
    }
    // any other page inside the scope (e.g. LICENSES.md): network, then cache, then the app itself
    try {
      return await fetch(event.request);
    } catch {
      return clean((await cache.match(event.request, MATCH)) || (await cache.match(SHELL, MATCH))) || offlinePage();
    }
  }

  async function revalidate(cached) {
    if (self.navigator && self.navigator.onLine === false) return;
    try {
      const fresh = await fetch(SHELL, { cache: "no-cache" });
      if (!cacheable(fresh)) return;
      const [a, b] = await Promise.all([cached.text(), fresh.text()]);
      if (a !== b) await self.registration.update();
    } catch {
      // offline or the server is unreachable: the cached shell stays in charge
    }
  }

  async function cacheFirst(event, key) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key, MATCH);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (cacheable(res)) event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    return res;
  }

  async function networkFirst(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (cacheable(res)) event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    } catch (err) {
      const hit = await cache.match(req, MATCH);
      if (hit) return hit;
      throw err;
    }
  }
})();
