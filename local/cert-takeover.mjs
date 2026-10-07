import { Network, SessionRegistry } from '../server/net.js';

const HEADER = 'x-stronghold-client-serial';

// WebSocket -> verified mTLS certificate serial.
const wsCertificates = new WeakMap();

// SessionRegistry -> Map<certificate serial, Stronghold Session>.
const registryCertificates = new WeakMap();

function certMap(registry) {
  let map = registryCertificates.get(registry);
  if (!map) {
    map = new Map();
    registryCertificates.set(registry, map);
  }
  return map;
}

function parseSerial(req) {
  let serial = req?.headers?.[HEADER];
  if (Array.isArray(serial)) serial = serial[0];
  if (typeof serial !== 'string') return null;

  serial = serial.trim().toUpperCase();
  if (!/^[0-9A-F]{1,128}$/.test(serial)) return null;
  return serial;
}

function sessionForCertificate(registry, serial) {
  const map = certMap(registry);
  const session = map.get(serial);
  if (!session) return null;

  // The Session may already have been removed or its reconnect window may
  // have expired. Remove stale certificate mappings in that case.
  if (
    registry.byId(session.playerId) !== session ||
    registry.isExpired(session, registry.now())
  ) {
    if (map.get(serial) === session) map.delete(serial);
    return null;
  }

  return session;
}

function bindCertificate(registry, serial, session) {
  const map = certMap(registry);
  const previousSerial = session.__strongholdCertSerial;

  if (
    previousSerial &&
    previousSerial !== serial &&
    map.get(previousSerial) === session
  ) {
    map.delete(previousSerial);
  }

  Object.defineProperty(session, '__strongholdCertSerial', {
    value: serial,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  map.set(serial, session);
}

// Clean the certificate mapping when Stronghold removes a Session.
const originalRemove = SessionRegistry.prototype.remove;
SessionRegistry.prototype.remove = function certAwareRemove(session) {
  const serial = session?.__strongholdCertSerial;
  const map = registryCertificates.get(this);

  if (serial && map?.get(serial) === session) map.delete(serial);
  return originalRemove.call(this, session);
};

// Capture the certificate identity before Stronghold installs its WebSocket
// message handlers. Apache must overwrite X-Stronghold-Client-Serial from the
// verified TLS client certificate; never trust a browser-provided value.
const originalHandleConnection = Network.prototype.handleConnection;
Network.prototype.handleConnection = function certAwareConnection(ws, req) {
  const serial = parseSerial(req);
  if (serial) wsCertificates.set(ws, serial);
  return originalHandleConnection.call(this, ws, req);
};

// Make the verified certificate the primary cross-device identity.
//
// Same certificate on a second device:
//   certificate -> existing Session -> official reconnect token path
//   -> Stronghold closes the old socket with 4001 "session replaced"
//   -> the new device receives the normal full resync.
//
// A reconnect token already bound to another certificate is ignored, which
// prevents one valid mTLS user from taking another certificate owner's
// Session merely by obtaining that browser token.
const originalOnHelloMsg = Network.prototype.onHelloMsg;
Network.prototype.onHelloMsg = function certAwareHello(conn, originalMsg, now) {
  const serial = wsCertificates.get(conn.ws) || null;
  let msg = originalMsg;

  if (serial && !conn.session) {
    const certSession = sessionForCertificate(this.registry, serial);

    if (certSession) {
      msg = { ...msg, token: certSession.token };
      this.log.info?.(
        `[cert-takeover] TAKEOVER serial=${serial} player=${certSession.playerId}`,
      );
    } else if (msg.token) {
      const tokenSession = this.registry.byToken(msg.token);
      const owner = tokenSession?.__strongholdCertSerial;

      if (owner && owner !== serial) {
        this.log.warn?.(
          `[cert-takeover] BLOCKED serial=${serial} player=${tokenSession.playerId}`,
        );
        msg = { ...msg };
        delete msg.token;
      }
    }
  }

  originalOnHelloMsg.call(this, conn, msg, now);

  const session = conn.session;
  if (!serial || !session) return;

  const owner = session.__strongholdCertSerial;
  if (!owner) {
    bindCertificate(this.registry, serial, session);
    this.log.info?.(
      `[cert-takeover] BIND serial=${serial} player=${session.playerId}`,
    );
  } else if (owner === serial) {
    certMap(this.registry).set(serial, session);
  } else {
    this.log.error?.(
      `[cert-takeover] OWNERSHIP_MISMATCH serial=${serial} player=${session.playerId}`,
    );
  }
};

console.error('[cert-takeover] preload ACTIVE');
