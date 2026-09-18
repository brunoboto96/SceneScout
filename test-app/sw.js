// Fixture service worker: an offline-sync style worker that performs a write on
// the page's behalf. The request below is issued BY the worker, not by the page,
// which is what makes it invisible to page-level request interception.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data === "sync") {
    event.waitUntil(fetch("/api/items/999", { method: "DELETE" }));
  }
});
