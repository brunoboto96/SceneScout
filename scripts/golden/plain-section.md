<!-- audience: both -->
## In plain words

This run found 3 problems: 1 blocks users, 1 is annoying and 1 is cosmetic. It went to 3 of the 5 pages it knew about.

2 problems found by earlier runs were not checked again this time. They are listed in the technical detail below.

1 observation is a problem only if your project follows a particular convention, so it is not counted here. They are listed in the technical detail below.

While it worked, the automatic checks noticed:

- The server refused or failed a request (2 times)
- The page reported an error behind the scenes (once)

The run left 2 things unchecked. The gap ledger below says which.

### Ticket THING-1: one criterion answered

### 1. Saving a thing says it worked when it did not

**Blocks users** · The page said something worked when the server had refused it · on http://app.test/things/new, and also seen on /other-things, /more-things

![What the page showed](recordings/s1/finding-0a1b2c3d4e.png)

**What was done:**

1. Go to http://app.test/things/new
2. Type "A thing" into the "Name" field and press Enter
3. Click the "Save" button

**What was expected:** The page reports only what really happened.

**What happened:** The page shows "Saved". The server answered with an error.

<details><summary>Technical detail</summary>

- **Finding id:** `0a1b2c3d4e` · **Category:** false_success · **Severity:** high
- **Evidence:** `POST /api/things → HTTP 500`
- **Route:** `/things/new#abc`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical detail below.

</details>

### 2. The error hides behind the banner

**Annoying** · Something is confusing to use · on http://app.test/login

![What the page showed](recordings/s1/0004-click.jpg)

**What was done:**

1. Go to http://app.test/login
2. Double-click the "Sign in" button
3. Choose "Narnia" in the "Country" list

**What was expected:** It is clear what to do and what happened.

**What happened:** The error message is under the cookie banner.

<details><summary>Technical detail</summary>

- **Finding id:** `1b2c3d4e5f` · **Category:** ux-confusing · **Severity:** medium
- **Route:** `/login#def`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical detail below.

</details>

### 3. A label is clipped

**Cosmetic** · Something else is wrong · on http://app.test/

**What was expected:** The app behaves the way a person using it would expect.

**What happened:** The label is cut off.

<details><summary>Technical detail</summary>

- **Finding id:** `2c3d4e5f60` · **Category:** a-category-from-an-older-file · **Severity:** low
- **Route:** `/#ghi`
- The full entry, with the repro trace and a test skeleton, is under the same id in the technical detail below.

</details>


<!-- audience: qa -->
## In plain words

This run found 3 problems: 1 blocks users, 1 is annoying and 1 is cosmetic. It went to 3 of the 5 pages it knew about.

2 problems found by earlier runs were not checked again this time.

1 observation is a problem only if your project follows a particular convention, so it is not counted here.

While it worked, the automatic checks noticed:

- The server refused or failed a request (2 times)
- The page reported an error behind the scenes (once)

The run left 2 things unchecked.

- The admin pages were not visited
- One form was never submitted

### Ticket THING-1: one criterion answered

### 1. Saving a thing says it worked when it did not

**Blocks users** · The page said something worked when the server had refused it · on http://app.test/things/new, and also seen on /other-things, /more-things

![What the page showed](recordings/s1/finding-0a1b2c3d4e.png)

**What was done:**

1. Go to http://app.test/things/new
2. Type "A thing" into the "Name" field and press Enter
3. Click the "Save" button

**What was expected:** The page reports only what really happened.

**What happened:** The page shows "Saved". The server answered with an error.

<details><summary>Technical detail</summary>

- **Finding id:** `0a1b2c3d4e` · **Category:** false_success · **Severity:** high
- **Evidence:** `POST /api/things → HTTP 500`
- **Route:** `/things/new#abc`

</details>

### 2. The error hides behind the banner

**Annoying** · Something is confusing to use · on http://app.test/login

![What the page showed](recordings/s1/0004-click.jpg)

**What was done:**

1. Go to http://app.test/login
2. Double-click the "Sign in" button
3. Choose "Narnia" in the "Country" list

**What was expected:** It is clear what to do and what happened.

**What happened:** The error message is under the cookie banner.

<details><summary>Technical detail</summary>

- **Finding id:** `1b2c3d4e5f` · **Category:** ux-confusing · **Severity:** medium
- **Route:** `/login#def`

</details>

### 3. A label is clipped

**Cosmetic** · Something else is wrong · on http://app.test/

**What was expected:** The app behaves the way a person using it would expect.

**What happened:** The label is cut off.

<details><summary>Technical detail</summary>

- **Finding id:** `2c3d4e5f60` · **Category:** a-category-from-an-older-file · **Severity:** low
- **Route:** `/#ghi`

</details>

