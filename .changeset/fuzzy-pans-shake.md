---
"scenescout": patch
---

The run's page now notices when the engine behind it has exited.

That address is served by a process. Once the process is gone, reloading it
gets the browser's own "site can't be reached" and the tab is lost, although
everything on the page was still readable a moment earlier. The served copy
now watches the engine, and when it goes says so in place: the page is still
good, reloading will not reach anything, and the copy that survives — with its
frames — is at the path it names, ready to copy. Leaving the page from then on
asks first, so a reflexive refresh cannot throw it away.

A browser will not follow a `file://` link from a served page, so the saved
copy cannot be opened from there; the path is offered instead. The copy on
disk carries none of this and stays a plain document with no script in it.
