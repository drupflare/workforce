# 🗄️ workforce

> Management and fleet library for Cloudflare Workers

workforce wraps the Cloudflare Workers management API and the operations built on top of it. You give
it a credential and a target; it creates, updates, patches, forks, deletes, monitors, diagnoses and
rolls back Workers, one at a time or a thousand at once.

It runs on Node and inside a Worker. The second one is the point: a Worker can provision another
Worker from its own assets, from a tarball, or from files it received over HTTP.

## 📖 Table of Contents

- [Why workforce](#-why-workforce)
- [Features](#-features)
- [Install](#-install)
- [Getting Started](#-getting-started)
- [Planes](#️-planes)
- [Sources](#-sources)
- [Bindings](#-bindings)
- [Secrets](#-secrets)
- [Assets](#️-assets)
- [Versions and Deployments](#-versions-and-deployments)
- [Revisions, Diff and Merge](#️-revisions-diff-and-merge)
- [Observability](#-observability)
- [Fleet](#️-fleet)
- [Environments](#-environments)
- [Access](#️-access)
- [Resources](#-resources)
- [Storage](#-storage)
- [Events](#-events)
- [GitHub Action](#-github-action)
- [Error Handling](#-error-handling)
- [Limitations](#-limitations)
- [API Reference](#-api-reference)
- [Contributing](#-contributing)
- [License](#-license)

## ❓ Why workforce

The Cloudflare API is a REST surface, and everything above one Worker is left to the caller: paging,
the request budget, which operations a dispatch namespace does not have, what a version can and
cannot carry, and what happens to a fleet operation when the fortieth of five hundred fails.

workforce is that layer. The official `cloudflare` SDK covers the whole API and unpacks to 65 MB
across 16,289 files, which is not a dependency that belongs inside a Worker.

## 🧰 Features

- One interface over account-scoped Workers and Workers for Platforms, with a capability object
  saying what each cannot do and why
- A request governor that reads Cloudflare's own rate-limit headers and keeps a reserve, because the
  limit is account-wide and crossing it blocks the dashboard too
- Uploads from memory, a tarball, a GitHub template, an HTTP request, another Worker, a remote host
  over SFTP, or a directory
- Static asset sync where the manifest is the complete desired set, so an omission is a deletion
- Versions, gradual deployments, rollback, and four guards for the refusals the platform makes
- Optional version history: content-addressed frames, delta reuse, diff, three-way merge, revert
- Fleet operations with bounded concurrency, a readable plan, and resumable apply
- Runs under Node and inside a Worker, with no `node:` import outside the `/node` subpath

## 🚀 Install

```sh
bun add @drupflare/workforce
npm i @drupflare/workforce
```

## 🏁 Getting Started

```ts
import { cloudflare, fromFiles, workforce } from '@drupflare/workforce';

const cf = workforce({
  plane: cloudflare({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    token: process.env.CLOUDFLARE_API_TOKEN!
  })
});

await cf.worker('my-api').upload({
  source: fromFiles({
    'index.js': 'export default { fetch: () => new Response("hello") };'
  }),
  metadata: { compatibility_date: '2026-08-01' }
});
```

## ✈️ Planes

A plane is the executor. The operations are the same on each; what differs is declared rather than
discovered.

```ts
import { cloudflare, dispatch, workforce } from '@drupflare/workforce';

const account = workforce({ plane: cloudflare({ accountId, token }) });
const tenants = workforce({ plane: dispatch({ accountId, token, namespace: 'tenants' }) });

await account.worker('api').upload({ source });
await tenants.worker('acme').upload({ source });

tenants.capabilities.versions.supported; // false
tenants.capabilities.versions.reason; // why, and what to use instead
```

Reaching for an unsupported operation throws a `CapabilityError` before any request is made.

|                                 | `cloudflare` | `dispatch` |
| ------------------------------- | ------------ | ---------- |
| versions, deployments, rollback | yes          | no         |
| subdomain, schedules, tails     | yes          | no         |
| assets, tags, analytics, Access | yes          | yes        |
| tags per script                 | unlimited    | 8          |

## 📦 Sources

Everything that uploads takes a `ModuleSet`, which is a `Map<string, Uint8Array>` of path to bytes.

```ts
import { fromFiles, fromGitHub, fromRequest, fromTarball, fromAssets } from '@drupflare/workforce';
import { fromDirectory } from '@drupflare/workforce/node';

fromFiles({ 'index.js': 'export default {}' });
await fromTarball(bytes);
await fromGitHub('drupflare/some-template', { ref: 'main' });
await fromRequest(request);
await fromDirectory('./dist');
```

`fromAssets` reads the calling Worker's own assets, which is how a Worker provisions another Worker:

```ts
const source = await fromAssets(env.ASSETS, '/templates/manifest.json', { budget: 40 });
if (!source.done) {
  // resume from source.cursor on the next invocation
}
```

The budget is there because an `ASSETS` binding spends one subrequest per file and the free plan
allows fifty per invocation. When it runs out it hands back a cursor instead of failing.

## 🔌 Bindings

```ts
await cf.worker('api').patchSettings({
  bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: id }]
});
```

A settings patch replaces the whole binding list, so naming two bindings would delete every other
one. `patchSettings` reads the current list first and turns the rest into `inherit` entries.
`replaceBindings` is there for a caller who means to replace them.

## 🔐 Secrets

```ts
await cf.worker('api').secrets.put('API_KEY', value);
await cf.worker('api').secrets.putJson('CONFIG', { region: 'enam' });
await cf.worker('api').secrets.list(); // names and types; the API never returns values
```

## 🗂️ Assets

```ts
const result = await cf.worker('api').assets.sync(await fromDirectory('./public'));
await cf.worker('api').upload({ source, metadata: { assets: { jwt: result.completionToken } } });
```

`sync` takes the whole tree. A path absent from it is absent from the resulting version, which is the
only way a rollout deletes a file, so there is deliberately no partial form.

## 🚦 Versions and Deployments

```ts
const next = await cf.worker('api').versions.create({ upload, message: 'pr-412' });

await cf.worker('api').versions.deploy([
  { version: next.id, percentage: 10 },
  { version: current.id, percentage: 90 }
]);

await cf.worker('api').versions.rollback(previous.id);
```

Under a gradual deployment, requests to a given Durable Object use the same version for the life of
that deployment. A ten percent split therefore puts roughly ten percent of OBJECTS wholly on the new
code rather than ten percent of each object's requests.

## 🕰️ Revisions, Diff and Merge

The platform does not return a past version's code, so workforce keeps it when you give it a store.

```ts
import { RevisionStore, planRevert } from '@drupflare/workforce';
import { hybridStore, r2Frames, d1Index } from '@drupflare/workforce/store';

const store = hybridStore({ frames: r2Frames(env.FRAMES), index: d1Index(env.DB) });
const revisions = new RevisionStore(store);

const upload = await cf.worker('api').upload({ source });
await revisions.write('api', source, { versionId: upload.versionId, etag: upload.etag });

const plan = await planRevert(revisions, 'api', someRevisionId);
await cf.worker('api').versions.create({ upload: plan.upload, message: plan.message });
```

`rollback` re-points the deployment at a version the platform still holds; no new version appears.
`revert` uploads old content as a NEW version and deploys that. Different operations, named apart.

Content is framed at 16 KiB and addressed by digest, so an edit stores the frames it touched rather
than the whole bundle.

`diffModules` compares two module sets; `diffWorkers` adds bindings, compatibility date and flags,
tags and secret names, and sets `contentUnavailable` when one side has no stored content.

```ts
import { diffModules } from '@drupflare/workforce';

for (const file of diffModules(before, after)) {
  if (file.change !== 'unchanged') console.log(file.change, file.path);
}
```

Three-way merge lives behind its own subpath, so a Worker that never merges does not bundle it.
Text merges line by line; binary files that both sides changed are reported as conflicts.

```ts
import { merge } from '@drupflare/workforce/merge';

const result = merge(base, ours, theirs);
if (!result.clean) {
  for (const conflict of result.conflicts) {
    // resolve conflict.path here; conflict.reason says why it could not merge
  }
}
```

## 🔭 Observability

```ts
import { Observability, summariseCpu } from '@drupflare/workforce';

const obs = new Observability(cf.raw, accountId);
const events = await obs.query({ from: Date.now() - 3_600_000, to: Date.now() });
const report = summariseCpu(events);
if (report.instrumentFailure) {
  // the capture is not usable; see report.notes
}
```

Prefer the query API over tail. `wrangler tail --format json` has been measured returning stateless
events and zero durable-object events for invocations the query API reported in full, so
`summariseCpu` reports a capture in that shape as a broken instrument rather than as a reading.

## 🛰️ Fleet

```ts
import { mapFleet, planFleet, applyPlan } from '@drupflare/workforce';

const workers = await cf.list();
const result = await mapFleet(workers, (w) => w.patchSettings({ bindings }), { concurrency: 8 });

const plan = planFleet(desired, actual);
const report = await applyPlan(plan, async (action) => {
  // perform the action here
});
```

A fleet operation finishes and reports rather than stopping at the first failure, and `applyPlan`
hands back a cursor when its action budget runs out.

## 🌱 Environments

```ts
import { planFork } from '@drupflare/workforce';

const plan = planFork({
  source: 'api',
  target: 'api-dev',
  modules,
  durableObjects: 'fresh'
});
```

`fresh` gives the fork its own empty Durable Object namespaces, `shared` points its bindings at the
source's, and `transfer` MOVES them and needs an explicit confirmation. A fork never carries secrets,
because the API does not return their values; `plan.secretsNotCarried` names the ones you still owe.

## 🛡️ Access

```ts
import { Access } from '@drupflare/workforce';

await new Access(cf.raw, accountId).ensure({ name: 'preview', workerId });
```

Worker-level Access covers every hostname a Worker is reached by, including its `workers.dev` one,
and needs no zone.

## 🧱 Resources

```ts
import { Resources } from '@drupflare/workforce';

const resources = new Resources(cf.raw, accountId, { plan: 'free' });
await resources.createD1('tenant-acme');
```

`createD1` counts the account's databases first and refuses by name at the cap rather than relaying a
quota error. The free plan allows ten.

## 💾 Storage

Providers take a binding and hold no state of their own:

```ts
import { d1Index, hybridStore, kvIndex, memoryStore, r2Frames } from '@drupflare/workforce/store';
```

Frames belong in an object store and the index in a database, which is what `hybridStore` composes.
The index is one small record per Worker, so it never outgrows a single D1 database.

## 🔔 Events

```ts
import { emit, memorySink } from '@drupflare/workforce';

const sink = memorySink();
await emit(sink, {
  name: 'worker.created',
  plane: 'cloudflare',
  target: accountId,
  subject: 'api'
});
```

workforce emits; it never decides what an event costs. A sink is optional and failures in one never
fail the operation being described.

## 🤖 GitHub Action

The Action gives every pull request its own preview Worker. Previews are always managed Workers:
Cloudflare generates no preview URL for a Worker implementing a Durable Object, and serves no logs
for any preview URL, so a named Worker is the only shape that works for every case.

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, closed]
  schedule:
    - cron: '0 3 * * *'

jobs:
  preview:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run build
      - uses: drupflare/workforce/action@v0.1.0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
          worker: api
          directory: dist
          mode: ${{ github.event_name == 'schedule' && 'sweep' || github.event.action == 'closed' && 'destroy' || 'deploy' }}
```

### Routing

A preview is named from `nameTemplate`, which defaults to `{worker}-pr-{pr}`, and is reachable on the
account's `workers.dev` subdomain:

```
https://{worker}-pr-{pr}.{account-subdomain}.workers.dev
```

Worker `api` on pull request 7, under an account whose subdomain is `acme`, answers on
`https://api-pr-7.acme.workers.dev`. The Action enables that hostname and turns per-version preview
URLs off, so each preview has exactly one URL. Set `access: true` to put Cloudflare Access in front
of it.

### Modes

`mode` runs when no `command` is given.

| mode      | when                                  | what it does                                                                            |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `deploy`  | `pull_request` opened or synchronized | uploads the preview, writes the `wf:pr` and `wf:ttl` tags, comments the URL             |
| `destroy` | `pull_request` closed                 | deletes the Worker and the Access application covering it                               |
| `sweep`   | `schedule`                            | deletes previews whose pull request is closed or untouched for longer than `staleAfter` |

Inactivity is measured from the pull request's `updated_at`, which arrives for every open pull
request in one call. `wf:ttl` is written at creation and honoured whether or not the sweep runs.

### Inputs

`apiToken`, `accountId`, `command`, `preCommands`, `postCommands`, `workingDirectory`, `quiet`,
`environment`, `secrets`, `vars`, `packageManager` and `gitHubToken` carry the same meaning as in
`cloudflare/wrangler-action`, so a workflow converts by changing the `uses:` line. Kebab-case
spellings are accepted too.

| input            | default            | what it sets                                                                |
| ---------------- | ------------------ | --------------------------------------------------------------------------- |
| `mode`           | `deploy`           | which preview operation to run                                              |
| `worker`         |                    | the Worker previews are made from                                           |
| `directory`      | `dist`             | the built Worker to upload                                                  |
| `nameTemplate`   | `{worker}-pr-{pr}` | how a preview is named                                                      |
| `ttl`            | `7d`               | how long a preview may live regardless of the pull request                  |
| `staleAfter`     | `14d`              | how long a pull request may go untouched before `sweep` removes its preview |
| `access`         | `false`            | put the preview behind Cloudflare Access                                    |
| `accessPolicyId` |                    | an existing Access policy to attach instead of creating one                 |
| `cleanup`        | `true`             | delete the preview when the pull request closes                             |
| `comment`        | `true`             | comment the preview URL on the pull request                                 |

Outputs are `command-output`, `command-stderr`, `deployment-url`, `worker-name`, `version-id` and
`swept`.

`secrets` and `vars` are newline-separated variable NAMES whose values come from the workflow's own
`env`. Values are never logged.

## 🧯 Error Handling

Every refusal is a `WorkforceError` with a `kind`:

| kind         | means                                                               |
| ------------ | ------------------------------------------------------------------- |
| `auth`       | the credential was missing, malformed or rejected                   |
| `api`        | the API answered and said no; `errors` carries its codes            |
| `limit`      | a rate limit or quota refused it; `retryAfterMs` when one was named |
| `not-found`  | it is not there                                                     |
| `capability` | this plane cannot do this at all, and the reason says why           |
| `usage`      | the call was refused before a request was made                      |
| `transport`  | the request never produced a readable response                      |

A 200 carrying `success: false` is how this API reports a permission problem, so status alone is
never the check.

## 🧗 Limitations

- **Preview URLs are not generated for a Worker implementing a Durable Object**, nor for Workers for
  Platforms user Workers, and no preview URL serves logs. A managed per-preview Worker is the shape
  that works for every case.
- **A Worker version's content cannot be read back.** Version endpoints return metadata and an etag.
  Diff and revert need a `RevisionStore`; without one they report themselves unavailable.
- **A version upload cannot carry a Durable Object lifecycle change**, and a gradual deployment is
  not supported on a Worker configured with `exports`.
- **Only the 100 most recent versions are reachable** for a rollback.
- **The API allows 1,200 requests per five minutes per user**, counted across the dashboard and every
  token together. Crossing it blocks every call for five minutes.
- **A dispatch namespace script has no versions, deployments, subdomain, schedules or tails**, and
  allows eight tags. Release identity is application-level there instead: a `RevisionStore` does not
  read the platform, so history, diff and `planRevert` work on a namespaced script exactly as they do
  on an account-scoped one. What is genuinely unavailable is TRAFFIC SPLITTING, because with no
  `/deployments` endpoint there is nothing to split across, so a revert is a re-upload and is atomic
  per script rather than gradual. A staged rollout there belongs in the dispatch Worker, which
  decides what reaches which script.
- **`edgeport` is required only for the SSH and SFTP sources**, is imported lazily, and works only on
  the Workers runtime.

## 📚 API Reference

Generated docs: <https://drupflare.github.io/workforce>.

## 🧪 Contributing

```sh
bun install
bun run typecheck
bun run test:unit
bun run test:e2e
bunx prettier --check .
```

`test:e2e` runs against a local plane over `wrangler dev`. `test:e2e:integration` runs the same specs
against Cloudflare and needs `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN`.

## 📝 License

MIT. See [LICENSE](LICENSE).
