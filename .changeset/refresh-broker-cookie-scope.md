---
"scenescout": patch
---

The refresh broker no longer holds back an app's requests when its refresh token is a cookie scoped to "/". A cookie alone no longer makes a request a refresh: only a POST, PUT or PATCH to a path named for a refresh, or an endpoint the broker has seen rotate the cookie (learned for every session of the role), goes through the lock. Scripts, stylesheets, images and fonts are never brokered, and when the broker cannot take the lock or read the profile the request goes out as the page sent it instead of being dropped. A refresh-named storage value that is an address is no longer taken for a token. On Windows, a lock file still being deleted as it changes hands (EPERM, EBUSY or EACCES) is waited for like a held lock instead of failing.
