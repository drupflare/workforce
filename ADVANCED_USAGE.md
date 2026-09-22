# Advanced Usage: Fleet Recipes

Worked examples that span more than one part of the library. Each states what it needs before it
starts, then gives the whole thing rather than a fragment.

## Recipe Index

- [A Worker That Provisions Another Worker](#a-worker-that-provisions-another-worker)
- [Pull Request Previews With Access](#pull-request-previews-with-access)
- [A Fleet-Wide Binding Change Under Budget](#a-fleet-wide-binding-change-under-budget)
- [Dev to Live Promotion](#dev-to-live-promotion)
- [A Canary With an Automatic Rollback](#a-canary-with-an-automatic-rollback)
- [Keeping Version History](#keeping-version-history)
- [Reading a Fleet-Wide Meter](#reading-a-fleet-wide-meter)
- [Converting a Host Over SFTP](#converting-a-host-over-sftp)
- [A Canary on a Self-Hosted Node](#a-canary-on-a-self-hosted-node)

## A Worker That Provisions Another Worker

### Prerequisites

A Worker with an `ASSETS` binding holding a template and a manifest, plus an account id and a token
with Workers write access.

The constraint that shapes this: an `ASSETS` binding has no listing API, so a manifest is read first,
and each file then costs one subrequest. The free plan allows fifty per invocation, so the read is
bounded and hands back a cursor rather than failing.

```ts
import { cloudflare, fromAssets, workforce, type AssetsBinding } from '@drupflare/workforce';

interface Env {
  ASSETS: AssetsBinding;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name');
    if (name === null) return new Response('pass ?name=', { status: 400 });

    const source = await fromAssets(env.ASSETS, '/template/manifest.json', { budget: 40 });
    if (!source.done) {
      return Response.json({ provisioned: false, resumeFrom: source.cursor });
    }

    const cf = workforce({
      plane: cloudflare({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN })
    });
    const result = await cf.worker(name).upload({
      source: source.modules,
      metadata: { compatibility_date: '2026-08-01' }
    });

    return Response.json({ provisioned: true, etag: result.etag });
  }
};
```

## Pull Request Previews With Access

### Prerequisites

A Cloudflare account, a token with Workers and Access write access, and a repository using the
Action.

Previews are always a managed Worker here. Cloudflare does not generate preview URLs for a Worker
implementing a Durable Object, and no preview URL serves logs, so the native path is unavailable for
half the cases and unobservable for the rest.

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, closed]
  schedule:
    - cron: '17 4 * * *'

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: drupflare/workforce/action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          worker: my-api
          mode: ${{ github.event_name == 'schedule' && 'sweep' || (github.event.action == 'closed' && 'destroy' || 'deploy') }}
          access: true
          ttl: 7d
          staleAfter: 14d
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

The `schedule` entry is what removes previews for pull requests that went quiet. A Cloudflare cron
would also work and costs one of the five the free plan allows per account, which is why the default
is a GitHub schedule instead.

## A Fleet-Wide Binding Change Under Budget

### Prerequisites

An account with several Workers, and a token that can patch their settings.

```ts
import { cloudflare, mapFleet, workforce } from '@drupflare/workforce';

const cf = workforce({ plane: cloudflare({ accountId, token }) });
const workers = await cf.list();

const result = await mapFleet(
  workers,
  async (worker) => {
    await worker.patchSettings({
      bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: cacheId }]
    });
  },
  { concurrency: 4, onProgress: (done, total) => console.log(`${done}/${total}`) }
);

for (const failure of result.failed) {
  console.error(`${failure.item.name}: ${String(failure.error)}`);
}
```

Two things are doing work here. `patchSettings` reads the current bindings and inherits the ones it
was not asked to change, because a settings patch replaces the whole list. And `mapFleet` finishes
and reports rather than stopping at the first failure, so a fleet is never left half-changed with no
record of which half.

## Dev to Live Promotion

### Prerequisites

Two Workers, one per environment, and the modules you want promoted.

```ts
import { cloudflare, planPromotion, workforce } from '@drupflare/workforce';
import { fromDirectory } from '@drupflare/workforce/node';

const cf = workforce({ plane: cloudflare({ accountId, token }) });
const modules = await fromDirectory('./dist');

const plan = planPromotion({
  from: 'api-dev',
  to: 'api',
  plane: cf.plane,
  modules,
  metadata: { compatibility_date: '2026-08-01' }
});

await cf
  .worker(plan.target)
  .upload({ source: modules, metadata: { compatibility_date: '2026-08-01' } });
```

Durable Objects stay `fresh` in a promotion on purpose: promoting code should not move the target's
data, and a target that already exists already has its own namespaces.

## A Canary With an Automatic Rollback

### Prerequisites

An account-scoped Worker with at least two versions, and observability enabled on it.

```ts
import { Observability, cloudflare, workforce } from '@drupflare/workforce';

const cf = workforce({ plane: cloudflare({ accountId, token }) });
const api = cf.worker('api');

const versions = await api.versions.list();
const [next, current] = [versions[0]!, versions[1]!];

await api.versions.deploy([
  { version: next.id, percentage: 10 },
  { version: current.id, percentage: 90 }
]);

await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));

const obs = new Observability(cf.raw, accountId);
const events = await obs.query({
  from: Date.now() - 5 * 60_000,
  to: Date.now(),
  filters: [
    { key: 'scriptName', operation: 'eq', value: 'api' },
    { key: 'outcome', operation: 'neq', value: 'ok' }
  ]
});

if (events.length > 0) {
  await api.versions.rollback(current.id);
} else {
  await api.versions.deploy(next.id);
}
```

Worth knowing while reading this: under a gradual deployment a given Durable Object stays on one
version for the life of the deployment, so ten percent means ten percent of objects rather than ten
percent of each object's requests.

## Keeping Version History

### Prerequisites

An R2 bucket for frames and a D1 database for the index, both bound to wherever this runs.

```ts
import { RevisionStore, cloudflare, planRevert, workforce } from '@drupflare/workforce';
import { d1Index, hybridStore, r2Frames } from '@drupflare/workforce/store';

const store = hybridStore({ frames: r2Frames(env.FRAMES), index: d1Index(env.DB) });
const revisions = new RevisionStore(store);
const cf = workforce({ plane: cloudflare({ accountId, token }) });

const result = await cf.worker('api').upload({ source });
await revisions.write('api', source, {
  versionId: result.versionId,
  etag: result.etag,
  label: 'deploy from CI'
});

const plan = await planRevert(revisions, 'api', olderRevisionId);
await cf.worker('api').versions.create({ upload: plan.upload, message: plan.message });
```

The store is what makes this possible at all: version endpoints return metadata and an etag, never
the modules, so a revert has to rebuild content from something you kept.

Run `verifyAll` on a schedule to find a store that lost a frame before a revert does.

## Reading a Fleet-Wide Meter

### Prerequisites

A way to ask each Worker for its own numbers. What that is depends on the Worker; this takes a reader
function rather than assuming.

```ts
import { fairShare, fleetMeter } from '@drupflare/workforce';

const readings = await Promise.all(
  workers.map(async (worker) => ({
    worker: worker.name,
    values: await readMetersFrom(worker.name)
  }))
);

const meter = fleetMeter(readings);
const share = fairShare({
  allowance: 100_000,
  spent: meter.totals.rowsWritten ?? 0,
  workers: meter.workers
});
```

`meter.missing` names the Workers that reported nothing for a key. A sum that treated silence as zero
would reintroduce exactly the blindness a fleet meter exists to remove: quotas are account-wide while
every per-Worker instrument reads only itself.

## Converting a Host Over SFTP

### Prerequisites

The Workers runtime, because `edgeport` is built on `cloudflare:sockets`. SSH credentials for the
host, and a fingerprint to pin once you have seen it.

```ts
import { fromRemote } from '@drupflare/workforce';

const { modules, hostKey } = await fromRemote(
  {
    hostname: 'box.example',
    username: 'deploy',
    privateKey: { pem: env.SSH_KEY },
    expectFingerprint: env.HOST_FINGERPRINT ?? null
  },
  '/var/www/html',
  { filter: (path) => !path.startsWith('cache/'), maxFiles: 5000 }
);

console.log(`read ${modules.size} files; host key ${hostKey?.fingerprint}`);
```

On a first connection leave `expectFingerprint` unset and record what comes back; on every connection
after, pass it. A changed key is then refused rather than accepted quietly, which is the difference
between pinning and pretending to.

## A Canary on a Self-Hosted Node

### Prerequisites

A bastion node reachable over HTTPS and a `bst_` API token. The tenant a token may reach rides on the
token itself, so nothing below names one.

The node runs workerd and owns its router, its scheduler and its version store, so the canary here is
the same shape as the Cloudflare one above without an account behind it. A site is addressed by the
host it serves, and it needs a bundle path and a probe that an upload cannot supply, so it is
registered before anything is deployed to it.

```ts
import { buildUpload, fromFiles, workerd } from '@drupflare/workforce';

const node = workerd({ endpoint: 'https://node.example.edu', token: env.BASTION_TOKEN });
const site = 'www.example.edu';

await node.create({ host: site, bundle: '/srv/bundles/example.tar', probe: '/health' });

await node.upload(
  site,
  buildUpload({
    source: fromFiles({ 'index.js': code }),
    metadata: { compatibility_date: '2026-08-01' }
  })
);

const [next, current] = await node.versions(site);
await node.rollout(site, next!.id, 10);

const failures = (await node.logs({ site, level: 'error', limit: 100 })).length;
if (failures > 0) await node.rollback(site, current!.id);
```

A version id is the content address of the bundle, so uploading the same bytes twice gives one
version rather than two, and a rollback is a pointer move instead of a re-upload. The split is real:
the node picks a version per visitor at its own front door, so a session stays on one side of the
rollout for as long as it lasts.

Two capabilities report `cannot` here and say why. There is no `workers.dev` on a self-hosted box, so
`subdomain` is unavailable, and Cloudflare Access is not reachable from one, so `access` is too.
Analytics reads the node's own log and its Prometheus endpoint through `logs()` and `metrics()` rather
than Cloudflare's query API. Secrets are host-level on a node and reachable only from an interactive
session, and a node does not serve a deployed bundle back, so keep the source you upload.
