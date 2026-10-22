# Unified asset preload: source and browser transport audit

Checked **2026-10-21**, against upstream `dev` **06a92237ebf42a7933a57fa80de2573e1e092f79**.
These are observations from one development machine/network, not a guarantee that a public proxy stays available.
No production server, Apache configuration, private records or local services were accessed or changed.

## Published files and installed bytes

The public [latest release API](https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest) and
[v0.3.1 release](https://github.com/sganggs/Stronghold-Protocol/releases/tag/v0.3.1) identify three attachments:

| Attachment | Bytes |
| --- | ---: |
| `Stronghold-Protocol-v0.3.1-lite.zip` | 27,188,386 |
| `Stronghold-Protocol-v0.3.1-update.zip` | 13,790,952 |
| `Stronghold-Protocol-v0.3.1.zip` | 845,522,197 |

The release notes explicitly say the separate `Stronghold-Protocol-v0.3.1-assets.zip` is offered by the maintainer
outside Releases. The preceding v0.3.0 release says the same. No GitHub `-assets.zip` URL is manufactured.
The repository excludes `public/assets/`; its source-code archive is not the full-game attachment.

The full-game ZIP is a legitimate input to the existing importer: it includes files beneath `public/assets/` and
`public/fonts/`, with the same packaging switches as the separately generated asset pack. Code, dependencies and
unlisted files are skipped locally. `tools/package.mjs` includes official FX only when the packager extracted them
and `FULL_ZIP_FX` permits them. A full package does not guarantee equality with another server's locally extracted
files or newer `dev` installation; the served hashes remain authoritative, and mismatches are rejected.

Setup has real per-file public GitHub sources (`tools/assets/sources.mjs`, `plan.mjs`): community dumps by
yuanyan3060, fexli, isHarryh and ArknightsAssets, plus the font repository. They do not publish the exact installed
site layout. `tools/assets/spine.mjs` normalizes atlas size, page names and premultiplied-alpha metadata;
`tools/assets/fonts.mjs` generates WOFF2 and `fonts.css`. Local board/scene/WebP/FX files come from extraction.
The server hashes its installed output; each Spine URL carries the hash of skeleton, atlas and ordered texture
members. Blindly prefixing a raw dump URL or downloading a raw atlas cannot prove this output matches.

## Actual ghfast and direct transport probes

The prefix format checked was `https://ghfast.top/` followed by the **complete public GitHub download URL**.
Two real public targets were used:

- [raw Amiya PNG](https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/char_002_amiya.png),
  a source used by the asset-plan avatar pattern;
- [upstream v0.3.1 full game ZIP](https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip).

Node `fetch` HEAD and GET probes sent `Origin: http://localhost:3000`. Range probes sent `Range: bytes=0-31`.
No cookies, authorization header, token, client certificate configuration, private URL or identifying application data
was supplied. Redirect locations were inspected by origin only; transient signed URLs are not committed here.

| Target / route | HEAD | GET range | Browser-readable CORS | Redirect |
| --- | --- | --- | --- | --- |
| PNG / direct raw | 200, 56,957 B | 206, 32 B, PNG signature | `Access-Control-Allow-Origin: *` | none |
| PNG / ghfast prefix | 200, 56,957 B | 206, 32 B, PNG signature | `Access-Control-Allow-Origin: *` | none |
| Full ZIP / GitHub | 302 then release host | 206, 32 B, ZIP signature | no `Access-Control-Allow-Origin` | `release-assets.githubusercontent.com` |
| Full ZIP / ghfast prefix | 200, 845,522,197 B | 206, 32 B, ZIP signature | no `Access-Control-Allow-Origin` | none visible to caller |

The range responses advertise `Content-Range` and `Accept-Ranges` at the network level, but neither tested route
exposes `Content-Range` through `Access-Control-Expose-Headers`. HTTP range support alone is insufficient for a
browser remote-ZIP reader. `https://ghfast.top/https://example.com/test.png` returned **403 `Invalid input.`**;
the proxy does not accept arbitrary origins, and this code must not assume it does.

A full GET streaming probe through ghfast returned 200 and the first 15,518-byte chunk; the reader was cancelled
immediately, without buffering or downloading the whole ZIP. The same direct full-GET probe timed out after
10 seconds on this network. The 32-byte direct Range probe did succeed. These probes verify bounded client-side
interruption, not end-to-end resume of an entire 845 MB transfer, sustained throughput or proxy reliability.

Chrome **155.0.8059.85** was launched headlessly with a temporary `127.0.0.1` HTTP test page. Its CSP explicitly
allowed only the tested remote origins. `fetch` used `mode: 'cors'`, `credentials: 'omit'`, `referrerPolicy:
'no-referrer'`, a 15-second abort deadline and the 32-byte Range. Both PNGs were readable 206 responses with
32-byte bodies; their `Content-Range` was hidden. Both ZIP fetches failed. Chrome's actual ghfast console error was
the missing `Access-Control-Allow-Origin` header. With the page restored to `connect-src 'self'`, all four remote
requests failed; Chrome reported a CSP connection violation. No production site was used to test either policy.

Minimal network reproduction (Node 22+, public bytes only):

```js
const target = 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip';
const response = await fetch('https://ghfast.top/' + target, {
  headers: { Origin: 'http://localhost:3000', Range: 'bytes=0-31' },
  signal: AbortSignal.timeout(10000),
});
console.log(response.status, response.headers.get('access-control-allow-origin'),
  response.headers.get('content-range'), (await response.arrayBuffer()).byteLength);
// Observed: 206 null "bytes 0-31/845522197" 32. Node does not enforce browser CORS.
```

## Automatic flow after the P0 correction (2026-10-22)

The GitHub source no longer uses native-download handoff, a downloaded-file picker or historical handoff records.
Selecting it automatically verifies current saved assets, discovers the actual full-game release, reads the ZIP tail
and central directory with bounded ranges, and lets the existing importer extract only required, missing files.
CRC, per-file hashes and complete Spine combinations are all checked before trusted storage. A fresh final verification
and a controlling project service worker are required for complete; missing or host-specific bytes stay partial.

Client CORS ranges with omitted credentials/referrer are preferred. Since the observed official/ghfast ZIPs do not
permit that, the same-origin fallback now relays exact ranges for only the discovered fixed public release. Clients
choose route IDs, never URLs; owners can configure at most four trusted HTTPS mirror prefixes. Public-address DNS
pinning is applied on each TLS connection, redirect targets are constrained, and only fixed public-request headers
are sent. Cancellation, backpressure, deadlines, response byte counts, concurrency and request limits are enforced.

The default 512 KiB block reader keeps at most 8 MiB in its LRU; the parser retains bounded central-directory and
per-entry buffers, not the full archive. If upstream sends 200 despite Range, the browser cancels without reading the
body; the relay streams one full archive to temporary disk (2 GiB budget), validates size/signature and the official
SHA-256 when available, then serves ranges. Waiters share preparation, which stops when the last waiter cancels.
This alternate path consumes a full upstream transfer and temporary disk; a successful Range path consumes only the
requested ranges. Same-origin relay traffic consumes the game server's bandwidth. `SP_ASSET_PRELOAD_RELAY=0` disables
it. See DEPLOY for limits, cleanup, explicit origins and custom-mirror configuration.

Ordinary LAN HTTP still uses server HTTP Cache. GitHub selection there automatically starts this real server
preload and labels the source, rather than claiming that cross-origin bytes populated an inaccessible import cache.
Game loading/networking and service-worker audio Range behavior are unchanged. Manual import still requires the
existing secure-context capabilities. No production server configuration was accessed or modified.

## Visitor country and privacy

There is no reliable built-in browser GeoIP API. The browser's
[Geolocation API](https://w3c.github.io/geolocation/) asks permission for device coordinates; it does not identify
the public network egress that reached this website. Language, time zone and server IP do not identify that egress.

A default public-IP query would disclose the player's network metadata to an extra third party, add another
CORS/CSP dependency and introduce availability/rate-limit/maintenance concerns. A bundled IP database requires
updates and still needs a trustworthy public client-IP signal, which LAN peers may not provide. Neither is added.

An optional deployment can reuse its existing trusted edge. Cloudflare's
[IP geolocation documentation](https://developers.cloudflare.com/network/ip-geolocation/) describes `CF-IPCountry`
and its country-code estimate. `SP_ASSET_PRELOAD_COUNTRY_HEADER=CF-IPCountry` explicitly enables reading that header
only from a request peer trusted under the existing `TRUST_PROXY` policy. The operator must have the proxy overwrite
incoming copies and restrict access to the origin; setting an arbitrary header does not make it trustworthy.
No public IP is sent to the page or stored by this feature. No country header is trusted by default.

`CN` selects ghfast before direct; all other country codes and unknown select direct before ghfast. HK, MO and TW
are separate codes and use direct first. An explicit always-direct preference suppresses mirror fallback. A route's
speed/success never becomes a claimed geographic classification. IP geolocation itself is approximate and can
change with VPNs or mobile routing; routing uses the website visitor's hint, not the host's location.

## Remaining distribution improvements

An immutable mapping of post-processed file hashes to public files, or bounded ZIP shards with an index, would reduce
the central-directory/nearby-block overhead and temporary full-spool fallback. It is an optimization, not a prerequisite
for the automatic flow. Transport CORS support could avoid relay bandwidth; long-term trusted mirror policy remains
an owner/maintainer decision. Neither permits bypassing current server hashes or whole-model checks. Host extraction
and FX differences still need server supplementation; a game version alone does not prove byte equality.

## Validation scope

On **2026-10-22**, the actual production relay transport was also exercised against the public v0.3.1 full ZIP
(845,522,197 bytes, published SHA-256 `d2f48f7fd2698f330b86c897d93ada2d7066825593cce4de8add46dfa68c3db1`).
Both direct and ghfast returned exact 206 responses for bytes 0–31 and the last 65,557 bytes (ZIP signature and EOCD
present), taking about 1.0–1.8 seconds per request on this network. A second probe used the production random-range
adapter, real relay and existing ZIP parser: **40,444 entries** parsed, then two real deflated PNG members passed CRC
and signature checks. It transferred **5,612,821 bytes in 11 ranges**, taking **24.54 seconds**. No full archive was
downloaded and no extracted art was written into the repository. This proves actual release format/transport
compatibility, not that every member matches an arbitrary server's manifest or that throughput is constant.

A repeat with `Origin: http://localhost:3000` again found no ACAO or exposed headers on ghfast and the official
release CDN. The direct head-range request hit the 10-second upstream header deadline once (504); its following tail
request succeeded. Public transport remains variable, so finite retries/fallback are necessary. The earlier successful
head and tail probes and this timeout are both retained in the local evidence rather than treating either as uptime.

The controlled seven-file browser fixture is 2,099,207 bytes including unlisted padding. A successful initial run
read 526,343 archive bytes in two relay ranges; rechecking verified cached files performed zero further ZIP requests.
The actual game image URL was fetched and decoded with no corresponding asset request reaching the server.
These small-fixture timings are not estimates for a complete art installation.

The public HTTP/Chrome probes above are actual network observations, separate from the controlled full-game-shaped
ZIP fixtures in the browser suite. Tests use real stored/deflated entries, CRCs, server hashes, a three-member Spine
group, actual Cache Storage writes and the real service worker. Missing CORS is enforced by Chrome; same-origin
requests traverse the actual relay handler with a server-injected public transport fixture. ZIP parsing or storage is
not mocked. Quota and upstream interruption are deliberately injected to check false-success handling.

The final local validation report records exact commands, counts and performance observations. The controlled archive
contains seven required files and unlisted padding, not copyrighted game art. A full 845 MB public download/import,
multi-region network comparison, production mTLS deployment and many simultaneous real players have not been tested.
