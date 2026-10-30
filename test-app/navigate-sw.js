// Fixture service worker: moves the page that asks it to another address, from outside the page's own thread, so the
// navigation goes out while the page is busy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data && typeof event.data.to === "string") event.waitUntil(event.source.navigate(event.data.to));
});
