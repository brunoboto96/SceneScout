// Shows who is signed in, in the header of every page that has one.
fetch("/api/me")
  .then((r) => r.json())
  .then(({ role }) => {
    const el = document.getElementById("role");
    if (el) el.textContent = role;
    document.body.dataset.role = role;
  })
  .catch(() => {});
