---
"scenescout": patch
---

A run of digits is redacted as a card number only when it passes the Luhn check and starts with a prefix a card network issues from, at a length that network issues (Visa, Mastercard, American Express, Discover, JCB, Diners Club, UnionPay, Maestro, Mir, RuPay, China T-Union, BORICA, UzCard, Humo, Troy and the national networks in Maestro's ranges). Lists of years, and many order ids and lists of five-digit numbers that happened to pass the Luhn check, are no longer redacted. A field labelled for a password, PIN, one-time or verification code, card number or card security code in German, French, Spanish, Portuguese, Italian, Dutch, Polish, Czech or the Nordic languages, with or without accents, is treated as a secret field, so its value is masked after a show-password toggle makes it an ordinary text field. A URL parameter with such a name (`?senha=…`, `?has%C5%82o=…`) has its value redacted.
