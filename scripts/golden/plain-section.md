<!-- audience: both -->
## Summary

SceneScout checked http://app.test on 2026-01-01 09:00 UTC, for 13 minutes, with the care level "Look only". This run found 4 problems: 1 blocks users, 2 are annoying and 1 is cosmetic. It went to 3 of the 5 pages it knew about.

| # | Impact | Problem | Where | What you'd see | What was expected |
|---:|---|---|---|---|---|
| 1 | Blocks users | Saving a thing says it worked when it did not | /things/new | The page said something worked when the server had refused it | The page reports only what really happened. |
| 2 | Annoying | The error hides behind the banner | /login | Something is confusing to use | It is clear what to do and what happened. |
| 3 | Cosmetic | A label is clipped | / | Something else is wrong | The app behaves the way a person using it would expect. |
| 4 | Annoying | The orders page fails to load its list | /orders?page=2#top | The server refused or failed a request | The action completes, or the page says clearly why it could not. |

2 problems found by earlier runs were not checked again this time. They are listed in the technical details below.

1 observation is a problem only if your project follows a particular convention, so it is not counted here. They are listed in the technical details below.

While it worked, the automatic checks noticed:

- The server refused or failed a request (2 times)
- The page reported an error behind the scenes (once)

The run left 2 things unchecked. The gap ledger in the technical details says which.

### Ticket THING-1: one criterion answered

### Each problem

Open a problem for the steps to see it, what was expected and what happened.

<details><summary>1. Saving a thing says it worked when it did not</summary>

**Blocks users** · The page said something worked when the server had refused it · on http://app.test/things/new, and also seen on /other-things, /more-things

**What was done:**

1. Go to http://app.test/things/new
2. Type "A thing" into the "Name" field and press Enter
3. Click the "Save" button

**What was expected:** The page reports only what really happened.

**What happened:** The page shows "Saved". The server answered with an error.

**Picture:** under Evidence, as problem 1.

- **Finding id:** `0a1b2c3d4e` · **Category:** false_success · **Severity:** high
- **Evidence:** `POST /api/things → HTTP 500`
- **Route:** `/things/new#abc`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

<details><summary>2. The error hides behind the banner</summary>

**Annoying** · Something is confusing to use · on http://app.test/login

**What was done:**

1. Go to http://app.test/login
2. Double-click the "Sign in" button
3. Choose "Narnia" in the "Country" list

**What was expected:** It is clear what to do and what happened.

**What happened:** The error message is under the cookie banner.

**Picture:** under Evidence, as problem 2.

- **Finding id:** `1b2c3d4e5f` · **Category:** ux-confusing · **Severity:** medium
- **Route:** `/login#def`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

<details><summary>3. A label is clipped</summary>

**Cosmetic** · Something else is wrong · on http://app.test/

**What was expected:** The app behaves the way a person using it would expect.

**What happened:** The label is cut off.

- **Finding id:** `2c3d4e5f60` · **Category:** a-category-from-an-older-file · **Severity:** low
- **Route:** `/#ghi`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

<details><summary>4. The orders page fails to load its list</summary>

**Annoying** · The server refused or failed a request · on http://app.test/orders?page=2#top, and also seen on /orders/archive

**What was done:**

1. Go to http://app.test/orders?page=2
2. Scroll down

**What was expected:** The action completes, or the page says clearly why it could not.

**What happened:** The list stays empty. The server answered 502.

- **Finding id:** `3d4e5f6071` · **Category:** http-error · **Severity:** medium
- **Evidence:** `GET /api/orders → HTTP 502`
- **Route:** `/orders#jkl`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical details below.

</details>

## Evidence

What the page showed for each problem, numbered as in the summary.

### 1. Saving a thing says it worked when it did not

**Blocks users** · on /things/new · finding `0a1b2c3d4e`

![What the page showed](recordings/s1/finding-0a1b2c3d4e.png)

### 2. The error hides behind the banner

**Annoying** · on /login · finding `1b2c3d4e5f`

![What the page showed](recordings/s1/0004-click.jpg)


<!-- audience: qa -->
## Summary

SceneScout checked http://app.test on 2026-01-01 09:00 UTC, for 13 minutes, with the care level "Look only". This run found 4 problems: 1 blocks users, 2 are annoying and 1 is cosmetic. It went to 3 of the 5 pages it knew about.

| # | Impact | Problem | Where | What you'd see | What was expected |
|---:|---|---|---|---|---|
| 1 | Blocks users | Saving a thing says it worked when it did not | /things/new | The page said something worked when the server had refused it | The page reports only what really happened. |
| 2 | Annoying | The error hides behind the banner | /login | Something is confusing to use | It is clear what to do and what happened. |
| 3 | Cosmetic | A label is clipped | / | Something else is wrong | The app behaves the way a person using it would expect. |
| 4 | Annoying | The orders page fails to load its list | /orders?page=2#top | The server refused or failed a request | The action completes, or the page says clearly why it could not. |

2 problems found by earlier runs were not checked again this time.

1 observation is a problem only if your project follows a particular convention, so it is not counted here.

While it worked, the automatic checks noticed:

- The server refused or failed a request (2 times)
- The page reported an error behind the scenes (once)

The run left 2 things unchecked.

- The admin pages were not visited
- One form was never submitted

### Ticket THING-1: one criterion answered

### Each problem

Open a problem for the steps to see it, what was expected and what happened.

<details><summary>1. Saving a thing says it worked when it did not</summary>

**Blocks users** · The page said something worked when the server had refused it · on http://app.test/things/new, and also seen on /other-things, /more-things

**What was done:**

1. Go to http://app.test/things/new
2. Type "A thing" into the "Name" field and press Enter
3. Click the "Save" button

**What was expected:** The page reports only what really happened.

**What happened:** The page shows "Saved". The server answered with an error.

**Picture:** under Evidence, as problem 1.

- **Finding id:** `0a1b2c3d4e` · **Category:** false_success · **Severity:** high
- **Evidence:** `POST /api/things → HTTP 500`
- **Route:** `/things/new#abc`

</details>

<details><summary>2. The error hides behind the banner</summary>

**Annoying** · Something is confusing to use · on http://app.test/login

**What was done:**

1. Go to http://app.test/login
2. Double-click the "Sign in" button
3. Choose "Narnia" in the "Country" list

**What was expected:** It is clear what to do and what happened.

**What happened:** The error message is under the cookie banner.

**Picture:** under Evidence, as problem 2.

- **Finding id:** `1b2c3d4e5f` · **Category:** ux-confusing · **Severity:** medium
- **Route:** `/login#def`

</details>

<details><summary>3. A label is clipped</summary>

**Cosmetic** · Something else is wrong · on http://app.test/

**What was expected:** The app behaves the way a person using it would expect.

**What happened:** The label is cut off.

- **Finding id:** `2c3d4e5f60` · **Category:** a-category-from-an-older-file · **Severity:** low
- **Route:** `/#ghi`

</details>

<details><summary>4. The orders page fails to load its list</summary>

**Annoying** · The server refused or failed a request · on http://app.test/orders?page=2#top, and also seen on /orders/archive

**What was done:**

1. Go to http://app.test/orders?page=2
2. Scroll down

**What was expected:** The action completes, or the page says clearly why it could not.

**What happened:** The list stays empty. The server answered 502.

- **Finding id:** `3d4e5f6071` · **Category:** http-error · **Severity:** medium
- **Evidence:** `GET /api/orders → HTTP 502`
- **Route:** `/orders#jkl`

</details>

## Evidence

What the page showed for each problem, numbered as in the summary.

### 1. Saving a thing says it worked when it did not

**Blocks users** · on /things/new · finding `0a1b2c3d4e`

![What the page showed](recordings/s1/finding-0a1b2c3d4e.png)

### 2. The error hides behind the banner

**Annoying** · on /login · finding `1b2c3d4e5f`

![What the page showed](recordings/s1/0004-click.jpg)

