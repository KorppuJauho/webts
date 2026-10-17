# Security

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately instead: on this repository's
**Security** tab, choose **Report a vulnerability**. Only the maintainer sees it.

Helpful to include: what's affected (the bridge, the page, an access mode, connect anywhere...), how to reproduce it,
and what an attacker could do with it. You'll get an answer as soon as possible; fixes for real problems come first.

## What counts

For example: getting past the sign-in (any `ACCESS_MODE`), making WebTS connect to addresses it should refuse
(private ones with connect anywhere), reading another person's identity, settings, favourites or chat history, running
script in the page through something a TeamSpeak server or another user sends, or leaking server passwords.

Not WebTS's own problem, but still welcome as a normal issue: TeamSpeak's own limits (e.g. pictures sent with the
TeamSpeak app's paperclip, which live in TeamSpeak's cloud), or a setup that ignores the README's advice (e.g.
`ACCESS_MODE=public` with connect anywhere on a server reachable from the internet).

## Supported versions

Only the latest version on `main` gets fixes.
