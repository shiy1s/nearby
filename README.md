# Nearby

**Vercel / any-network mode:** See [VERCEL.md](VERCEL.md) for the hosted build, private cloud storage, and deployment setup. The instructions below describe the original local-network mode.

Messages and file transfers between browsers on the same home Wi-Fi. One laptop hosts the app; phones and other laptops join through its local IP address. No cloud, accounts, installation on the receiving devices, or internet required. Requires Node.js 20 or newer on the host only. No npm dependencies.

## Run

Double-click `start.bat` on Windows, or run 
ode server.mjs` in this folder. Keep the terminal open. It prints a six-digit join code and local addresses.

1. On the host, open http://localhost:3000.
2. On another device connected to the same Wi-Fi, open the **Other devices** address printed in the terminal, such as `http://192.168.1.5:3000`. Type `http://`, not `https://`. If several addresses appear, use the Wi-Fi adapter's IPv4 address from `ipconfig`.
3. Give each device a name and enter the join code.
4. Select **Everyone** or one device. Send text or click **+** to share files. The recipient clicks a file to download it.

If Windows asks, allow Node.js through the firewall for **Private networks**. If phones cannot connect, check that the Windows Wi-Fi profile is Private and the firewall permits TCP port 3000 on Private networks. Guest Wi-Fi and access-point/client isolation can prevent devices from communicating; use the main home network. VPNs may also interfere. Do not forward this port on your router.

## How it works

Browsers connect to a Node.js HTTP server on the host. Server-sent events deliver live messages and presence; HTTP uploads/downloads carry files. It uses a central host, not a peer-to-peer mesh. Paired devices remain listed offline; they reconnect when the page is opened again. Active transfers require both devices online and the host running; this does not scan every device on the Wi-Fi. Mobile browsers may disconnect when backgrounded and reconnect when reopened.

The join code changes whenever the server restarts. Sessions use HTTP-only cookies. Direct messages and downloads are restricted to their participants. “Everyone” reaches currently connected devices; newcomers do not receive past messages or files. Last 100 events per session are kept in memory. Device pairings are saved in `.nearby-data/devices.json` and do not expire on the host. Keep this folder when moving or updating the app. The browser cookie lasts up to 400 days and renews on use; browsers may clear it sooner. Clearing browser data, private browsing, or changing the host address requires pairing again. Use a fixed local IP (router DHCP reservation) or stable local hostname for consistent access. Use separate browsers/devices for separate identities; tabs in the same browser share an identity.

Files stream to a temporary host folder, with a 1 GB per-file limit and 5 GB total cap. They expire after one hour. Graceful shutdown deletes that folder; a forced crash may leave a 
earby-*` folder in the OS temporary directory. Messages are lost on restart; paired device identities survive restarts. File delivery means uploaded to the host and offered for download, not automatically saved on the receiving device.

Use only on a trusted private LAN: plain HTTP is not encrypted, and this is not end-to-end encryption. The host can access transferred data. Binding to all interfaces makes it reachable on connected networks, so keep the firewall scoped to Private networks. Files are not automatically opened or executed.

Optional environment variables: `PORT` (default 3000), `JOIN_CODE` (default random six digits).

## Verify

Run 
ode --test test.mjs` for integration checks with independent simulated device sessions, including live delivery, binary file integrity, and recipient access restrictions.



## Saved groups
Use **Create group** in the sidebar, enter a name, select paired devices, and choose **Create**. The creator is included automatically. Groups and membership are saved in `.nearby-data/groups.json` and survive restarts. Only members see the group or can send to it. Group messages reach offline members when they reconnect while the same host session is running. Group history is still held in memory and resets on host restart; files still expire after one hour. Keep the entire `.nearby-data` folder to preserve identities and groups.

