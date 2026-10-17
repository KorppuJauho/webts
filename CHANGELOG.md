# Changelog

What each release changes. Versions: **1.0.x** fixes, **1.x.0** features, **2.0.0** would be the first release that
needs changes on your side (README: "Versions").

## 1.0.0 (2026-10-17)

The first release. Image: `ghcr.io/korppujauho/webts:1.0.0` (x86 and ARM).

- **Voice:** push-to-talk or voice activation, per-person volume, mute and sound mute in sync with the server, talk
  power respected; Chrome, Edge, Safari and Firefox (also Firefox on Android).
- **The channel tree** as the TeamSpeak app shows it: the server's icons, group badges, avatars, spacers and channel
  banners, in the server's order.
- **Chat:** channel and private chat, pokes, link previews, join and leave lines, and an optional chat history across
  days, locked on disk.
- **Pictures:** sent into the channel's file browser so the TeamSpeak app shows them too, with hidden photo details
  (such as GPS location) removed.
- **Streams:** watch screen shares and cameras from the TeamSpeak 6 app; share your screen (Chromium-based browsers and
  Firefox, up to 4K) or camera (also on phones); an optional TURN relay (coturn or Cloudflare).
- **Access modes:** Cloudflare Access, a login proxy's header, a signed note from your own gateway, or public.
- **Servers:** one server, a list to pick from, or "connect anywhere" with favourites, with private addresses refused.
- **Installable** as an app on phones.
- **The image:** runs as an unprivileged user with a read-only file system; built and published by GitHub Actions
  after the tests, a start-up test and a vulnerability scan, with a signed build record.
