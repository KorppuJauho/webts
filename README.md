# WebTS

**A self-hosted web client for TeamSpeak servers.** Your friends open a web page and they're on your TeamSpeak
server: voice, chat, pictures and streams, on a PC or a phone, with nothing to install.

> WebTS is an independent fan project. It is not affiliated with, endorsed by or supported by TeamSpeak Systems GmbH.
> "TeamSpeak" is their trademark. Use it on servers you run or are allowed to connect to.

## What it does

- **Voice:** push-to-talk or voice activation, per-person volume, mute and sound mute in sync with the server, talk
  power respected. Works in Chrome, Edge, Safari and Firefox (also Firefox on Android, through Opus in WebAssembly).
- **The channel tree** as the TeamSpeak app shows it: the server's own icons, group badges, avatars, spacers and
  channel banners, in the server's order. Move between channels with a click.
- **Chat:** channel and private chat, pokes, link previews.
- **Pictures:** send a photo (camera or gallery on a phone, paste or drop on a PC). It goes into the channel's file
  browser and shows in the TeamSpeak app too. Hidden photo details such as GPS location are removed first.
- **Streams:** watch screen shares and cameras from the TeamSpeak 6 app, and share your own screen or camera
  (Chromium-based browsers). An optional TURN relay helps people behind strict networks.
- **Installable** as an app on phones.

Every browser gets its own TeamSpeak connection and identity, so people show up on the server as themselves
(`Web - Alex`), keep their server groups between visits, and the server's permissions apply to them.

## How it works

```
browser ──https/WebSocket──▶ WebTS (Node, this repository) ──TeamSpeak protocol (UDP 9987, TCP 30033)──▶ your TeamSpeak server
        ◀──── streams go straight between the browser and the TeamSpeak app (WebRTC), or through your TURN relay ────▶
```

WebTS runs next to your TeamSpeak server, as one Docker container. It serves the web page and turns each browser
connection into a TeamSpeak client.

## Quick start (Docker)

1. You need a TeamSpeak server (3 or 6; streams need 6) and Docker.
2. Get the code and make your settings:
   ```bash
   git clone https://github.com/KorppuJauho/webts.git
   cd webts
   cp .env.example .env
   ```
   In `.env`, set at least `TS_HOST`, `PUBLIC_URL` and the access settings (next section).
3. Start it:
   ```bash
   mkdir -p data sounds && sudo chown 1000:1000 data
   docker compose up -d --build
   ```
   WebTS listens on `127.0.0.1:3002`. Put your sign-in in front of it (next section) and open `PUBLIC_URL`.

The `data/` folder holds everyone's TeamSpeak identity (with its private key) and saved settings. Back it up: if
it's lost, everyone gets a new identity and loses the server groups tied to the old one.

## Access: who gets in

WebTS has no login of its own. Pick one of these with `ACCESS_MODE`:

| Mode | For | How it works |
| --- | --- | --- |
| `cloudflare-access` (recommended) | Cloudflare Tunnel + Cloudflare Access (free for small teams) | Access signs in your friends (email code, Google, GitHub...). WebTS checks Access's signed token on every request, so nothing gets in around Access. |
| `header` | Another login proxy: Authelia, Authentik, oauth2-proxy... | The proxy puts the user name in a header (`ACCESS_HEADER`, default `Remote-User`). **WebTS must only be reachable through the proxy**, or anyone could send that header. |
| `public` | A server that's open to everyone anyway | Anyone with the address gets in; each browser gets its own identity. Needs `I_UNDERSTAND_THIS_IS_PUBLIC=true`. |
| `signed-note` | Your own gateway | Your gateway signs `{ id, name, exp }` with a shared secret and passes it in a header (see `src/access.ts`). |

### Cloudflare Tunnel + Access, step by step

1. In Cloudflare Zero Trust, create a **tunnel** and a public hostname (e.g. `webts.example.com`) pointing to
   `http://webts:3002` (or `http://localhost:3002`).
2. Create an **Access application** (self-hosted) for that hostname, with a policy listing who may sign in.
3. Copy its **Application Audience (AUD) tag** to `CF_ACCESS_AUD`, and your team domain
   (`<team>.cloudflareaccess.com`) to `CF_ACCESS_TEAM_DOMAIN`. Set `PUBLIC_URL=https://webts.example.com`.

The menu's "Sign out" then signs out of Access.

## TeamSpeak permissions

WebTS users are ordinary TeamSpeak clients and get the server's normal permissions. For pictures, they need
permission to upload files (and to create the picture folder) in channels; viewers need permission to download
files. If uploads are refused, WebTS says so in the chat.

## Sounds

TeamSpeak's own UI sounds are copyrighted and not included. To have them, copy the `.wav` files from your own
TeamSpeak 3 client's `sound/default` folder into `sounds/` (mounted read-only into the container). Without them
WebTS is simply quiet.

## Relay (optional)

Streams go straight between the browser and the TeamSpeak app. Some networks (CG-NAT, strict firewalls) block that;
a TURN relay carries the video instead. Either your own **coturn** (`TURN_URLS` + `TURN_SECRET`, coturn's
`static-auth-secret`) or **Cloudflare Realtime TURN** (`CF_TURN_KEY_ID` + `CF_TURN_KEY_TOKEN`, optionally a monthly
cap with `CF_ACCOUNT_ID` + `CF_ANALYTICS_TOKEN`). Browsers use the relay only when a direct connection fails.

## Known limitations

- **Watching streams in Firefox doesn't work:** the TeamSpeak 6 app never completes the connection to Firefox (it
  sends no connection checks to it). Chrome, Edge and other Chromium-based browsers work. WebTS tells Firefox users.
- Sharing your screen needs a Chromium-based browser on a computer.
- Pictures pasted in the TeamSpeak 6 app (its paperclip button) are stored in TeamSpeak's own cloud and can't be
  shown in WebTS; WebTS shows a short note instead. Pictures sent from WebTS work everywhere.

## All settings

See [`.env.example`](.env.example): every setting with a short explanation.

## Development

```bash
npm ci
npm test          # offline tests: protocol encryption, file transfer, access modes, pictures
npm run typecheck
npm start         # needs the settings as environment variables (or a .env loaded by your shell)
```

## Licence

WebTS is licensed under the [Open Software License 3.0](LICENSE): you may use, change and share it; if you run a
changed version for other people, you must make your changed source available to them. It contains code from other
projects, credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
