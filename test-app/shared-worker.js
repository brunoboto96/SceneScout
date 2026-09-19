// Fixture shared worker: performs a write on the page's behalf. The request is
// issued BY the worker, and no browser lets the driver intercept it.
self.addEventListener("connect", (event) => {
  const port = event.ports[0];
  port.addEventListener("message", (message) => {
    if (message.data === "sync") {
      fetch("/api/items/998", { method: "DELETE" }).then(
        () => port.postMessage("sent"),
        () => port.postMessage("failed"),
      );
    }
  });
  port.start();
});
