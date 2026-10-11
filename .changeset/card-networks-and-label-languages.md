---
"scenescout": patch
---

A run of digits is redacted as a card number only when it starts as a card network's numbers do (Visa, Mastercard, American Express, Discover, JCB, Diners Club, UnionPay, Maestro, Mir), at a length that network issues, and passes the Luhn check. Order ids, lists of years and lists of five-digit numbers that happened to pass the Luhn check are no longer redacted. A field labelled for a password, PIN, one-time or verification code, card number or card security code in German, French, Spanish, Portuguese, Italian, Dutch, Polish, Czech or the Nordic languages is treated as a secret field, so its value is masked after a show-password toggle makes it an ordinary text field.
