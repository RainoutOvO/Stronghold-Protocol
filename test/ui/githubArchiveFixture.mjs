// Controlled full-game-shaped ZIP bytes for automatic preloader E2E. No game art or public network is needed.
import { deflateRawSync } from 'node:zlib';
import { hash16 } from '../../server/http/assetIndex.js';
import { crc32 } from '../../public/js/assetPack.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const ROOT = 'Stronghold-Protocol-v0.3.1/';

/** Real ZIP local headers, central directory and CRCs; include both stored and deflated entries. */
export function buildGithubArchive(files) {
  const localParts = [], centralParts = [], entries = new Map();
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.bytes);
    const name = Buffer.from(ROOT + file.path);
    const method = file.method || 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = file.badCrc ? (crc32(raw) ^ 1) >>> 0 : crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); name.copy(central, 46);
    entries.set(file.path, { localOffset: offset, dataOffset: offset + local.length, compressedLength: compressed.length,
      bytes: raw, method });
    localParts.push(local, compressed); centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...localParts, directory, end]), entries };
}

/** Seven manifest files: two PNGs, a font, audio, and a three-member Spine group with its aggregate hash. */
export function githubArchiveFixture({ corrupt = null } = {}) {
  const assets = [
    { path: 'assets/preload/stored.png', bytes: png, method: 0 },
    { path: 'assets/preload/deflated.png', bytes: png, method: 8 },
    { path: 'fonts/preload.woff2', bytes: Buffer.from('wOF2-browser-preload-fixture'), method: 8 },
    { path: 'assets/audio/bgm/preload.mp3', bytes: Buffer.from('ID3-browser-preload-audio'), method: 0 },
    { path: 'assets/preload/model.skel', bytes: Buffer.from('synthetic-spine-skeleton'), method: 8 },
    { path: 'assets/preload/model.atlas', bytes: Buffer.from('model.png\nsize: 1,1\nformat: RGBA8888\n'), method: 0 },
    { path: 'assets/preload/model.png', bytes: png, method: 8 },
  ];
  const hash = (file) => hash16(file.bytes);
  const url = (file, digest = hash(file)) => '/' + file.path.replace(/^(assets|fonts)\//, `$1/~${digest}/`);
  const modelHash = hash16(assets.slice(4).map(hash).join('\n'));
  const manifest = { files: assets.slice(0, 4).map((file) => url(file)), model: {
    skel: url(assets[4], modelHash), atlas: url(assets[5], modelHash), textures: [url(assets[6], modelHash)],
  } };
  const files = [
    { path: 'README.txt', bytes: Buffer.from('public full game package fixture\n') },
    // Unlisted stored bytes keep the ZIP over the tail-read window. Downloading a central directory is not a full ZIP.
    { path: 'unrelated-padding.bin', bytes: Buffer.alloc(2 * 1024 * 1024, 0x5a) },
    ...assets.map((file) => ({ ...file, path: 'public/' + file.path })),
  ];
  if (corrupt === 'hash') files.find((file) => file.path.endsWith('/stored.png')).bytes = Buffer.from('wrong-but-valid-CRC');
  if (corrupt === 'spine') files.find((file) => file.path.endsWith('/model.png')).bytes = Buffer.from('wrong-spine-page');
  if (corrupt === 'crc') files.find((file) => file.path.endsWith('/stored.png')).badCrc = true;
  const archive = buildGithubArchive(files);
  if (corrupt === 'zip') archive.bytes[archive.bytes.length - 22] = 0;
  const release = { version: '0.3.1', name: 'Stronghold-Protocol-v0.3.1.zip', size: archive.bytes.length,
    url: 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.1/Stronghold-Protocol-v0.3.1.zip' };
  const served = new Map(assets.map((file, index) => [url(file, index >= 4 ? modelHash : hash(file)), file.bytes]));
  return { ...archive, release, manifest, served, image: manifest.files[0], modelUrls: [manifest.model.skel, manifest.model.atlas, ...manifest.model.textures] };
}

/** Server-only injected transport. Production URL checks remain in the actual relay handler. */
export function githubArchiveTransport(fixture, control = {}) {
  const requests = [];
  const transport = async ({ url, headers, signal }) => {
    const range = new Headers(headers).get('range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    if (!match) throw new Error('fixture requires a bounded Range');
    const start = Number(match[1]), end = Number(match[2]);
    requests.push({ url, range, start, end, headers: Object.fromEntries(new Headers(headers)) });
    if (typeof control.offline === 'function' ? control.offline({ url, start, end }) : control.offline) throw new TypeError('controlled network interruption');
    if (control.hold?.({ start, end, url })) {
      await new Promise((resolve, reject) => {
        control.release = resolve;
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (start > end || end >= fixture.bytes.length) return new Response('', { status: 416 });
    const bytes = control.noRange ? fixture.bytes : fixture.bytes.subarray(start, end + 1);
    return new Response(bytes, { status: control.noRange ? 200 : 206, headers: { 'Content-Type': 'application/zip',
      ...(control.noRange ? {} : { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${fixture.bytes.length}` }),
      'Content-Length': String(bytes.length) } });
  };
  return { transport, requests };
}
