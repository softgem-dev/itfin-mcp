# Reopen request consent: a confirmation form when it works, a chat confirmation token otherwise

A reopen request goes to the user's manager, so the server never files one without the user's per-call consent. The server first asks through an MCP confirmation form (elicitation). Some apps advertise forms but never show them: the Claude desktop Code tab answers straight away without displaying anything. So an answer that comes faster than a person could give (under 1 s) is not treated as consent or refusal, even when it is an accept. In that case, or when the app doesn't support forms, the server files nothing. Instead it returns a preview plus a one-time `confirmationToken`, valid for 10 minutes and bound to the tool and the exact dates and reason. The agent must show the preview in chat and call again with the token only after the user explicitly agrees.

## Considered Options

- Form only, refusing when the form can't be shown: rejected, because reopen requests could not be filed at all from the desktop Code tab.
- Chat token only: rejected, because where forms work, they give consent the agent can't fake.
- Treat any answer as final: rejected, because an app that auto-declines (or auto-accepts) without showing the form would be read as the user's answer.

## Consequences

- On the token path, consent depends on the agent honestly asking the user. The server only guarantees that one call alone can't file, and that the second call matches what the preview showed.
- Every form answer is logged to stderr (`action`, `confirm`, elapsed ms). Declined and dismissed forms return `CONFIRMATION_DECLINED` or `CONFIRMATION_CANCELLED` with those details.
- Leave requests also go to the manager, so `itfin_request_leave` uses the same flow. Its token is bound to the leave type, dates, reason and comment, and a token issued by one tool is refused by the other.
- Tokens live in the server's memory. They don't survive a server restart, which only means asking again.
