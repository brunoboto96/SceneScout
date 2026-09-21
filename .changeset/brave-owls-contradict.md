---
"scenescout": minor
---

Report the page contradicting the server: a refused list shown as an empty state, and a refused save shown as a success.

Two of the most expensive bugs a web app ships were invisible to every oracle that watches one side of the wire. A list request is refused with a 403 and the page renders its empty state, so the user is told they have nothing when the truth is that nothing could be loaded — which is how a permission regression reaches production without anyone noticing. A save is refused and the page says "Saved", so the user walks away believing their work is stored.

Neither is a crash. The HTTP oracle already saw the refusal and reported it as a medium, indistinguishable from the dozens of expected 401s an auth probe produces; the defect is not the refusal but the page contradicting it. Both now raise a high-severity `refused_empty` or `false_success` violation on the action that caused them, naming the endpoint and quoting what the user was shown instead.

The rules pair an exact half with a fuzzy one — a status code either is an error or is not, and the page half is never enough alone — so a page that is refused and says so raises nothing. Against the demo app, whose only 4xx is a missing image, they are silent.
