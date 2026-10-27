# Deploy Nearby on Vercel

This project has two modes. `node server.mjs` still runs the original LAN app. The Vercel build runs an internet app: devices can be on different Wi-Fi networks or mobile data, and the laptop does not need to stay on. Devices pair once per browser and hostname. Internet access is required.

## Deployment setup

1. Put the project source in your Git repository and import it into Vercel. Do not upload `.nearby-data`, `.env` files, or local user files. Exclusions are included in this project.
2. Use **Other** as the framework, **Node.js 24.x**, build command `npm run build`, output directory `dist`. The included `vercel.json` configures the API route and daily cleanup.
3. Connect an **Upstash Redis** database from the Vercel Marketplace. Confirm `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured.
4. Create and connect a **private Vercel Blob store**. Supply its `BLOB_READ_WRITE_TOKEN` as a server-only environment variable. Do not use a public store: uploads explicitly request private access.
5. Set `JOIN_CODE` to a strong private passphrase of at least 6 characters. Set `CRON_SECRET` to a separate random secret. These must never have a public/client prefix. `.env.example` lists the required names. Share only the pairing passphrase with people you want in your circle.
6. Deploy. Open the resulting HTTPS address on each device, enter a device name and the shared pairing passphrase. Use the same stable production hostname later so the browser remembers its pairing.

Production and preview deployments should use separate Redis databases and Blob stores to prevent test data and cleanup jobs affecting production. This is one private circle per deployment; anyone with the pairing passphrase can join it and see the device list and Everyone conversation. It is not a public multi-tenant service.

## Behavior

- Paired device identities, group membership, and the latest 100 items per device live in Redis and survive deployments and function restarts. Offline recipients receive those retained items when they return.
- The client checks for changes every 3 seconds while visible, and every 15 seconds while hidden. This uses short serverless requests instead of a permanently running server. Mobile browsers can pause background tabs.
- Files up to 1 GiB upload directly to private Blob storage. Large files use multipart uploads with SDK retry behavior. They do not pass through the API request body limit.
- Download requests check recipient membership, then redirect to a temporary, file-specific signed Blob URL. That URL is a bearer link: recipients should not forward it. It expires after at most one hour, or at the file's expiry if sooner.
- Files are accessible for 24 hours. The daily cleanup deletes up to 100 expired files per invocation, so physical deletion can happen later than access expiry. For heavier usage increase cleanup frequency on a suitable plan or schedule additional authenticated cleanup calls. Incomplete uploads that never form a Blob are subject to the storage provider's multipart cleanup behavior.
- Message and upload endpoints are rate-limited. Storage and bandwidth are billed by the selected providers; no unlimited/free storage assumption is made. Configure provider budgets for your usage.
- Connections use HTTPS, but messages/files are not end-to-end encrypted. The deployment operator and storage providers can access stored data.
- Local identities, groups, and files are not uploaded or migrated automatically. Pair once on the hosted address and recreate groups there.

## Verification

Install dependencies with pnpm, then run `node scripts/build.mjs` and `node --test test.mjs cloud/test.mjs`.

The automated suite checks LAN transfers and hosted authorization, persistent state across new handler instances, offline group messages, upload ownership, exact file size validation, duplicate upload completion, signed-download access, expiry, and cleanup. Hosted tests use storage doubles, not live paid services.

Before relying on the deployment, pair two browsers, create a group, send a message, upload a small file and a large file, download on the recipient, and verify that a third nonmember cannot access it. Actual Vercel routing, Blob callbacks, credentials, and real network throughput require a configured preview deployment to verify.

References: [Vercel client uploads](https://vercel.com/docs/vercel-blob/client-upload), [signed Blob URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls), [Vercel storage](https://vercel.com/docs/storage).
