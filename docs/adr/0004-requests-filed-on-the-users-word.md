# Reopen and leave requests are filed on the user's word, with no extra confirmation step

Supersedes [0003](0003-reopen-consent-form-or-chat-token.md).

`itfin_request_reopen` and `itfin_request_leave` file the request in one call. The user asking for it in the conversation, or agreeing to it, is the consent. The server no longer shows a confirmation form or hands out a preview with a one-time `confirmationToken`.

The two-step flow made the user say the same thing twice: once to ask for the leave, then again to approve the preview. In the desktop Code tab the form never shows, so every request needed a second round trip even when the user had already given all the details. The requests aren't final anyway: a manager still has to approve them, and a leave request can be withdrawn with `itfin_cancel_leave_request`.

## Considered Options

- Keep the form and token (0003): rejected, because it forces the user to repeat an explicit instruction.
- Keep the form only where the app shows it: rejected, because it behaves differently per app for no gain to the user.

## Consequences

- Consent now depends only on the agent acting on what the user actually said. Tool descriptions tell the agent to call only when the user asked or agreed.
- The leave result still carries ITFin's counted days/hours and balance, so the agent can report what was filed.
- The `CONFIRMATION_*` error codes and the elicitation support are gone.
