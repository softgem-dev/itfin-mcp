# ITFin token comes only from a human login, with a launchd relogin reminder

ITFin issues a JWT only at Google login, valid exactly 7 days and never refreshed. We don't automate the Google sign-in or store Google credentials. Instead, `itfin_login` opens a window in a user-chosen Chromium-based browser with a dedicated profile, lets the user sign in, watches the `itfin-jwt` cookie ITFin sets after sign-in (the same JWT the API accepts as a bearer token), and stores the token in the macOS Keychain. At that moment the server schedules a one-shot launchd notification for the nearest working time before `exp`. The server only runs while Claude runs, so it cannot remind anyone by itself.

## Considered Options

- Automated Google sign-in with a stored password: rejected. Google blocks automated browsers, and a Google password grants far more than ITFin access.
- Reactive login on the first failed call: rejected as the only mechanism. `exp` is known exactly, so failures can be predicted, and an unattended evening run can't complete a login anyway.
- Remote connector with OAuth: rejected for the MVP. It would need hosting and storing other people's tokens server-side.

## Consequences

- Any 401 marks the token dead (no retry) until the next login. Only GET, PUT and DELETE are retried on network errors and 5xx, because a retried POST could file a second time entry or reopen request. Expiry checks use a 5-minute clock-skew margin.
- A login window opens only when the user asks from chat, never on its own during an unattended run.
