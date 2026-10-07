# mTLS certificate takeover deployment

This branch adds an optional deployment extension that treats a verified mTLS client certificate as the cross-device Stronghold identity.

Target baseline: Stronghold Protocol v0.2.1 (`c2a2ef778cf728ff29b953b9842b2a39b1e9cbea`).

## Behaviour

- One verified client certificate serial maps to one live Stronghold Session.
- Opening the game on another device with the same certificate resumes that Session through Stronghold's existing reconnect-token path.
- The previous device is closed by the stock server with close code `4001` (`session replaced`).
- The stock client already shows the native "该身份已在其他页面登录 / 在此页面继续" UI.
- A reconnect token already bound to another certificate is ignored, preventing cross-certificate token takeover.
- The certificate mapping is deliberately memory-only, matching Stronghold's own in-memory room/match/session model. Restarting Node clears it.

## Files

- `local/cert-takeover.mjs` — Node preload extension. It does not modify `server/net.js`.
- `deploy/apache-mtls-example.conf` — Apache example for HTTPS, mTLS, WebSocket proxying, certificate-serial forwarding and audit logging.

## Security model

Apache is the trust boundary. Node must only listen on localhost and must never trust a browser-supplied certificate header directly.

Apache must:

1. Require a valid client certificate.
2. Remove any incoming `X-Stronghold-Client-Serial` header.
3. Set `X-Stronghold-Client-Serial` itself from `SSL_CLIENT_M_SERIAL`.
4. Proxy `/ws` explicitly as WebSocket before the generic `/` proxy.

Do **not** expose port 3000 publicly. The intended path is:

```text
client -> HTTPS 443 -> Apache mTLS -> 127.0.0.1:3000 -> Stronghold
```

## Start command

Run Stronghold with the preload loaded:

```bash
node --import=/www/wwwroot/Stronghold-Protocol/local/cert-takeover.mjs server/index.js
```

Equivalent environment form:

```bash
NODE_OPTIONS=--import=/www/wwwroot/Stronghold-Protocol/local/cert-takeover.mjs
```

The process log should contain:

```text
[cert-takeover] preload ACTIVE
```

The first device using a certificate should log a `BIND`, and another device using the same certificate should log `TAKEOVER`.

## Apache validation

After editing the site vhost:

```bash
apachectl -t
```

Only reload Apache if it reports `Syntax OK`:

```bash
systemctl reload apache2
```

A successful game WebSocket connection should appear as `/ws` with HTTP status `101` in the mTLS audit log.

## BaoTa / BT Panel note

BT Panel can regenerate a site's Apache reverse-proxy template when the Node project settings are saved. If that happens, verify that the following custom directives are still present:

```text
SSLCACertificateFile .../.mtls/ca.crt
SSLVerifyClient require
RequestHeader unset X-Stronghold-Client-Serial
RequestHeader set X-Stronghold-Client-Serial ...
ProxyPass /ws ws://127.0.0.1:3000/ws
ProxyPassReverse /ws ws://127.0.0.1:3000/ws
```

Also verify that port 80 redirects to HTTPS instead of proxying directly to Node, otherwise it can bypass the mTLS gate.

## Certificates and secrets

Never commit any real CA/private material. Keep deployment secrets outside Git or under a runtime-only ignored directory, for example:

```text
.mtls/ca.key
.mtls/ca.crt
.mtls/clients/*.key
.mtls/clients/*.p12
```

The CA private key and client private keys must never be stored in this repository.

## Certificate issuing pattern

A practical deployment uses one certificate per person. A stricter model can use one certificate per device for easier revocation, but then cross-device takeover requires both devices to share the same logical certificate identity or an additional account mapping layer.

For Android compatibility, PKCS#12 files may need a non-empty import password and legacy-compatible encryption/MAC options depending on the device keystore.

## Troubleshooting

If same-certificate takeover does not happen, check in this order:

```text
1. Both devices show the same certificate SERIAL in the Apache mTLS audit log.
2. /ws returns status 101.
3. The running Node process command line contains --import=.../cert-takeover.mjs, or NODE_OPTIONS contains it.
4. Node log contains [cert-takeover] preload ACTIVE.
5. First device produces BIND; second same-certificate device produces TAKEOVER.
```

The stock Stronghold server already handles the actual replacement after the resume token resolves to the existing Session; this extension only supplies certificate-based identity selection.
