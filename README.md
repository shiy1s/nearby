# Nearby

Nearby shares messages and files between paired devices. It has two modes:

- **Local mode:** one laptop runs the Node.js host. The default listener is loopback-only. To connect phones or other computers, put the host behind a trusted HTTPS reverse proxy; see the Secure local LAN mode section in [VERCEL.md](VERCEL.md).
- **Hosted mode:** devices connect from any network through Vercel. See [VERCEL.md](VERCEL.md) for setup, Redis, private Blob storage, and deployment.

## Local mode

Requires Node.js 24 or newer on the host. No npm dependencies are needed for the local server.

### Start

On Windows, double-click `start.bat`. Or run:

```sh
node server.mjs
```

The server prints a random pairing secret if `JOIN_CODE` is not configured. The generated secret is cryptographically random and changes on each restart. To use a stable secret, set `JOIN_CODE` to a random value containing at least 20 bytes.

By default, the server binds to `127.0.0.1`, so only the host computer can connect. For access from other devices, configure a trusted HTTPS reverse proxy and set:

- `HOST=127.0.0.1`
- `PUBLIC_ORIGIN=https://your-lan-hostname`
- `COOKIE_SECURE=1`

The reverse proxy must terminate HTTPS, and its local CA certificate must be trusted on each client device. Follow the Caddy example in [VERCEL.md](VERCEL.md).

Setting `HOST=0.0.0.0` exposes the local HTTP server to the LAN without encryption. This is an explicit insecure opt-in; Nearby prints a warning. Do not use this mode for sensitive conversations or on untrusted networks.

### Use

1. Open the configured HTTPS address on each device (or `http://localhost:3000` on the host).
2. Enter a device name and the pairing secret.
3. Select **Everyone**, a paired device, or a group.
4. Send messages or use **+** to share files. Recipients click a file to download it.

The host must remain running while local devices communicate. Windows Firewall may need to allow the reverse proxy on Private networks. Guest Wi-Fi, access-point isolation, or VPN settings can prevent devices from reaching the host. Do not forward the server port on your router.

### Local behavior and storage

- Browsers connect to the host; server-sent events deliver live messages and presence, while HTTP transfers files.
- Paired devices remain listed when offline and reconnect when their page is opened again.
- The host retains the latest 100 events per session in memory. Messages are lost when the host restarts.
- Pairings and groups are saved under `.nearby-data`. Keep this folder when moving or updating the app.
- Files are held in a temporary host folder, with a 1 GiB per-file limit and 5 GiB total quota. Files expire after one hour. Graceful shutdown removes the temporary folder; a forced crash may leave a `nearby-*` folder in the OS temporary directory.
- Use separate browsers or devices for separate identities; tabs in the same browser share an identity.

Optional environment variables: `PORT` (default `3000`), `HOST` (default `127.0.0.1`), `JOIN_CODE` (minimum 20 bytes), `PUBLIC_ORIGIN`, and `COOKIE_SECURE`.

## Verify

Run the integration tests with:

```sh
node --test test.mjs cloud/test.mjs
```

The hosted tests use Redis and Blob test doubles. They do not replace testing against a configured Vercel preview deployment.

## Security model

Use a trusted HTTPS connection for network access. Messages and files are not end-to-end encrypted; the host or hosted deployment operator can access transferred data. Pairing is shared-secret based, so only share the pairing secret with people you intend to include. The local server enforces device, request-rate, and upload-concurrency limits. Hosted mode uses Redis-backed rate limiting and a 100-device cap.
