// Shared by every page with a header: says who is signed in, and gives pages
// small helpers for escaping text and formatting dates.
window.fernbrook = {
  me: fetch("/api/me").then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))),
  esc(text) {
    const d = document.createElement("div");
    d.textContent = String(text);
    return d.innerHTML;
  },
  date(iso) {
    return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  },
  today() {
    return new Date().toISOString().slice(0, 10);
  },
};
window.fernbrook.me
  .then(({ role, member }) => {
    const el = document.getElementById("who");
    if (el) el.textContent = role === "member" ? "member " + member : role;
    document.body.dataset.role = role;
  })
  .catch(() => {
    const el = document.getElementById("who");
    if (el) el.textContent = "(not sure who you are)";
  });
