# Team report

| | |
|---|---|
| Site | https://staging.example.com |
| Date | 2026-10-16 10:00 UTC |
| What was checked | Forms, Broken pages and links |
| Care level | Look only |
| How thorough | Normal |

## Summary

This run found 3 problems: 1 blocks users, 1 is annoying and 1 is cosmetic. It went to 7 of the 9 pages it knew about.

1 problem found by earlier runs was not checked again this time.

1 observation is a problem only if your project follows a particular convention, so it is not counted here.

While it worked, the automatic checks noticed:

- The server refused or failed a request (2 times)

The check left 2 things untested.

## Problems found

### 1. Saving an order says it worked when the server refused it

**Blocks users** · The page said something worked when the server had refused it · on /orders/new, also seen on /orders/edit

![640×400, "Save" and around it](recordings/main/finding-a1a1a1a1a1.png)

**What was done:**

1. Go to https:​//staging.example.com/orders/new
2. Click the "Save" button

**What was expected:** The page reports only what really happened.

**What happened:** The page showed Order saved, and the server answered 422.

Technical detail: id a1a1a1a1a1 · false\_success · high · /orders/new\#form

### 2. The date field has no label

**Annoying** · Some people cannot use this part · on /orders/new

**What was done:**

1. Go to https:​//staging.example.com/orders/new
2. Click the "Save" button

**What was expected:** Everyone can use it, including with a keyboard or a screen reader.

**What happened:** A screen reader announces it as edit text.

Technical detail: id b2b2b2b2b2 · a11y · medium · /orders/new\#form

### 3. The footer overlaps the last row

**Cosmetic** · Something looks wrong on screen · on /orders

**What was expected:** Everything is visible, readable and in its place.

**What happened:** The page showed Order saved, and the server answered 422.

Technical detail: id c3c3c3c3c3 · visual · low · /orders\#list

## Marked not a bug

Someone marked these not a bug. They are kept, and listed here apart from the problems.

- The banner flickers (/orders/new): "It is an animation"

## What was not checked

These are the parts the check knew about and did not test. A problem there would not be in this report.

- 2 known route\(s\) never visited: /admin, /reports
- single-role run \(user\) — permission boundaries and role capability gaps are untested

## Sign-off

Sign once the problems above have been read and a decision made about each.

| Role | Name | Signature | Date |
|---|---|---|---|
| Checked by | | | |
| Reviewed by | | | |
| Approved by | | | |

Made by SceneScout 9.9.9. It stays on this computer until you share it.
