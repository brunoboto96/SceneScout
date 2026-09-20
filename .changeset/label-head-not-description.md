---
"scenescout": patch
---

The read-only write policy no longer refuses a control because of a destructive word in its description. A card or tile that is a button carries prose in its accessible name, a title then a sentence about it, and a word in that sentence describes what the thing is for rather than what the click does. A label that is prose, longer than six words and containing a sentence, is now judged by its first six words, where the verb lives; every other label is still judged whole, so a long confirm button stays refused. The pattern still sees the whole label, so exemptions that look ahead ("reset filters") keep working. This is what refused the manager card on a sign-in page whose sentence mentioned orders that need sign-off. Separately, "sign off" is now read as the noun when the word before it says so ("Needs sign-off", "Awaiting sign-off", "Send for sign-off"), so those short labels are no longer refused either.
