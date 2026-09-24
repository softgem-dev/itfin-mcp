# ITFin Reporting Assistant

A local MCP server that gives agents authenticated access to one user's ITFin workspace: projects, time entries and leave requests. What to report, when, and how is decided by the calling agent, not by this server.

## Language

### Authorization

**Workspace**:
A company's ITFin instance, identified by its address (e.g. `https://keenethics.itfin.io`). Each installation is configured for exactly one workspace and one user.
_Avoid_: tenant, company, domain

**ITFin token**:
The JWT that authorizes API calls. It is issued only when the user logs in and expires exactly 7 days after issue. It is never refreshed or extended.
_Avoid_: session, auth, refresh token

**Login**:
The user signing in to ITFin via Google in a window opened on request from chat. This is the only moment a new ITFin token is issued.
_Avoid_: refresh, re-auth

**Relogin reminder**:
A notification asking the user to log in, scheduled for the nearest working time before the ITFin token expires.

**Working time**:
The hours when the user can be asked to act. Working days come from ITFin (holidays and weekends); daily hours and timezone come from the installation's config.
_Avoid_: business hours, office hours

### Reporting

**Time entry**:
One record of work in ITFin: a date, an agreement (project), optional task, minutes and a comment.
_Avoid_: report, log, timesheet row

**Closed day**:
A day whose time entries can no longer be added or changed because its reporting period has closed.
_Avoid_: locked day, expired day

**Reopen request**:
A user's request to a manager to allow reporting on closed days again. It is only made after the user explicitly agrees, and a granted request is valid for a limited time.
_Avoid_: unlock, open reporting

### Leave

**Leave type**:
A kind of absence the workspace lets the user request, e.g. vacation, sick leave, paid or unpaid leave. Each has its own balance rules and list of reasons.
_Avoid_: time off type, policy

**Leave request**:
A user's request to a manager to approve full days of leave of one leave type, with a reason and a comment. Like a reopen request, it is only made after the user explicitly agrees.
_Avoid_: vacation request, sick note, day-off request
