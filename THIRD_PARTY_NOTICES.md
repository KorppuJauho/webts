# Third-party notices and credits

WebTS is licensed under the [Open Software License 3.0](LICENSE). It contains or is based on the following work.

## Included code

| What | Where in WebTS | Authors | Licence |
| --- | --- | --- | --- |
| **TSLib**, the TeamSpeak 3 protocol library (C#), part of [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) | `src/tslib/` is a TypeScript port of it (connection, encryption, identities, licence chain, QuickLZ) | Splamy, Flakebi, TSLib contributors | OSL-3.0 |
| **ts6-manager**, whose backend carries the TypeScript port of TSLib that WebTS started from | `src/tslib/` | [Clusterzx](https://github.com/clusterzx/ts6-manager) | MIT (as stated by the project; the port itself follows TSLib's OSL-3.0) |
| **Socket.IO** client 4.7.5 | `public/vendor/socket.io-4.7.5.min.js` | Guillermo Rauch and contributors | MIT |
| **opus-encdec** 0.1.1 (libopus 1.3.1 compiled to WebAssembly) | `public/vendor/opus-encdec-0.1.1/` (its `LICENSE.md` is next to it) | Matt Diamond, Christopher Rudmin, and others; libopus: Xiph.Org Foundation and others | MIT; libopus BSD-3-Clause |

## Packages installed at build time

express (MIT), socket.io (MIT), libsodium-wrappers-sumo (ISC), tsx (MIT), TypeScript (Apache-2.0) and their
dependencies, as pinned in `package-lock.json`.

## Thanks

- [WebSpeak3](https://github.com/Moepchi/webspeak3) by Moepchi (MIT): the way a web viewer joins a TeamSpeak 6
  stream was learned from it.
- `VERSION_SIGN` in `src/tslib/client.ts` is TS3AudioBot's public client version signature.

## Not included

- **TeamSpeak's sounds** are copyrighted by TeamSpeak Systems GmbH and are never part of WebTS. Each server owner can
  copy them from their own TeamSpeak 3 client (README: "Sounds").
- **TeamSpeak** is a trademark of TeamSpeak Systems GmbH. WebTS is an independent project and is not affiliated with,
  endorsed by or supported by TeamSpeak Systems GmbH.
