# Deploying OpsMemory on Railway

OpsMemory runs as **one container with a persistent disk**: SQLite stores run history and the Meko activity log on the disk, and one server process handles requests in order (`app/api/_server/opsmemory.ts`). That is why it needs a host with volumes, such as Railway, and not a serverless platform like Vercel, whose storage resets between requests.

The repo already contains what Railway needs:

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the Next.js standalone server on Node 24. The database lives at `/data/opsmemory.db`. |
| `railway.json` | Tells Railway to use the Dockerfile and to health-check `/api/health`, with restart on failure. |
| `app/api/health/route.ts` | Returns 200 only when every required setting is present and the database opens. |
| `.dockerignore` | Keeps `.env*`, local databases and `.git` out of the image. |

## One-time setup

1. **Push the branch to GitHub.** Railway deploys from a branch, usually `main`.
2. **Create the project.** At railway.com: New Project, then Deploy from GitHub repo, then pick `OpsMemory` and the branch. Railway finds `railway.json` and builds the Dockerfile.
3. **Attach a volume.** Open the service, add a Volume, and set the mount path to `/data`.
4. **Set the variables** (service, Variables tab):

   | Variable | Value |
   |---|---|
   | `MEKO_API_KEY` | OpsMemory's own runtime key. Never your coding agent's key. |
   | `GEMINI_API_KEY` | Your Gemini key |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
   | `MEKO_DATAPACK_PREFIX` | `opsmemory-public`, so the public site never touches the demo or e2e datapacks |
   | `MEKO_CREATE_DATAPACKS` | `true` for the first deploy only |

   You don't need to set `PORT` or `OPSMEMORY_DB`: Railway provides `PORT`, and the image defaults the database to the volume.
5. **Keep one replica.** Requests are serialised inside one process and SQLite is a local file, so a second replica would split history and break the activity log.
6. **Generate a domain.** Settings, Networking, Generate Domain.

## After the first deploy

1. Open `https://<your-domain>/api/health`. It should return `{"ok":true}`.
2. Load the page and run sample 1 with Meko **OFF**. That checks the model key without touching Meko.
3. Run the demo story once yourself, so visitors arrive to a populated knowledge base:
   1. sample 1, Meko ON;
   2. Apply sample correction, then approve;
   3. sample 2, Meko ON, then Run with Meko OFF.

   The first Meko ON run creates the `opsmemory-public-*` datapacks.
4. Set `MEKO_CREATE_DATAPACKS` to `false` (or delete it). From now on, a mistyped prefix fails clearly instead of starting empty datapacks.

Every push to the deployed branch rebuilds and redeploys. A deploy whose health check fails is not promoted, so the previous version keeps serving.

## Starting fresh

Promoted memories can't be deleted through Meko's API. To give the public site a clean slate, change `MEKO_DATAPACK_PREFIX` (for example to `opsmemory-public-2`), set `MEKO_CREATE_DATAPACKS=true` once, and redeploy. To clear run history, delete and recreate the volume.

## Running the image elsewhere

```bash
docker build -t opsmemory .
```

```bash
docker run -p 3000:3000 -v opsmemory-data:/data --env-file .env.local opsmemory
```

Any host that runs a container with a persistent volume works the same way (Fly.io, Render with a disk, a VM).

## A note on local testing

Neither Next.js nor `node --env-file` overrides a variable that is already set in your shell. If your shell exports `MEKO_API_KEY` (the Meko MCP setup for coding agents does this), local runs use that key instead of the one in `.env.local`. On Railway only the variables you set exist, so this doesn't apply there.
