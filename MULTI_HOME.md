# Independent home hubs and offline configuration

## Storage and ownership

- **Phone:** persistent, endpoint-specific SharedPreferences cache of the home registry, device lists, event lists and event variable catalogues. Cold starts without connectivity retain the cached lists and mark devices/homes offline. Connecting refreshes these snapshots, including homes not currently selected. A connection failure never means an empty configuration.
- **Gateway:** desired configuration is stored durably in MongoDB database `SmartHomeHubConfig` on the existing cluster. This is separate from the old server's home databases. Heroku's temporary filesystem is not used for configuration. One document per home contains devices, variable definitions, events, configuration revision, synchronization acknowledgment, last-seen and runtime status.
- **Pi:** SQLite remains the local execution database. Schedules and events continue during Internet outages using the last synchronized configuration. Live values are preserved when configuration is reapplied. Only new variables receive their configured initial value.

The app can save configuration through the Internet-connected gateway while a Pi is offline. Those edits show **Changes pending sync** until that home's Pi acknowledges the configuration revision. The newest desired configuration is sent on reconnect; deleted items cannot be recreated by an old Pi snapshot. If the phone itself cannot reach the gateway, cached lists remain usable for viewing; edits cannot be committed until connectivity returns. Event editor drafts survive normal screen configuration changes, but are not a durable offline mutation queue.

Live variable commands are never stored for later replay. An offline home cannot accept a live command. Local device communication and existing automations continue independently of Heroku/Mongo connectivity.

## Configuration conflicts

Writes use a home revision and mutation ID. A stale editor is rejected with a request to reload/review rather than silently overwriting newer edits. The gateway keeps the last 100 mutation receipts for deduplication. Atomic revision comparison protects configuration against concurrent gateway writes. A persisted home deletion is a tombstone; its hub receives an empty configuration.

Configuration changes for managed hubs must use the gateway URL. Direct Pi connections support local device control, runtime reads and schedules, but device/home/event/variable-definition edits return a message directing the app to the gateway. This gives configuration a single owner and prevents a disconnected Pi from replacing newer cloud edits.

Deleting a referenced variable/device removes related events and Pi schedules. When the Pi is offline, its old configuration continues running until synchronization completes; the pending indicator reflects this.

## Home identity and status

`HUB_BINDINGS` on Heroku maps home names to distinct private hub tokens. A hub token can connect only as its assigned home; a Germany Pi cannot read or receive Egypt traffic. `HUB_HOME=Home_Germany` scopes the present Pi's requests and schedule execution. Egypt remains configured and offline until its separate Pi connects.

The home light is green when the app can reach that home's ready hub, gray otherwise. Manage Homes shows online/offline, pending configuration and the last gateway observation in the phone's local time. Last seen is not a claim about the exact instant of power loss; disconnect detection and runtime heartbeats can introduce delay. A phone without network access displays its cached last-seen information.

## Event comparisons

Condition `operator` supports `=`, `>`, `>=`, `<`, `<=`. Ordering is accepted only for int/float variables; text and booleans offer equality. Existing rules without `operator` keep equality behavior. AND/OR grouping and false-to-true triggering are unchanged. Saving/enabling a rule establishes its baseline; reconnecting does not replay missed actions.

## Deployments and future Egypt Pi

Current Pi release: `/home/khaled/smarthome/releases/multi-home-v1`. Final pre-migration backup: `/home/khaled/smarthome/backups/final-before-multi-home-20260921.sqlite`; prior environment: `backups/hub-before-multi.env`.

Package `config-store.js`, `multi-gateway.js`, and `home-sync.js` in addition to the previous server files for future updates. Gateway startup uses `CONFIG_MONGO_URI` and `HUB_BINDINGS`; without those settings the legacy single-hub mode remains available for regression tests.

For the future Egypt Pi, deploy the same runtime/server, use a separate local SQLite file, set `HUB_HOME=Home_Egypt`, the same `GATEWAY_URL`, and the distinct `EGYPT_HUB_TOKEN` stored locally in `Migration/private/gateway-keys.json`. Use that token as the Egypt Pi's `HUB_TOKEN`. Do not use the Germany token. On first connection it receives the existing Egypt configuration. No router forwarding is needed. No Egypt Pi was provisioned by this change.

`scripts/bootstrap-home-registry.js` initially seeds missing home registry documents from a private Pi backup. `--refresh-seed` is allowed only before activation (revision 1, no acknowledgment); it refuses to replace active configuration. `--configure` activates the Heroku settings. Never use the bootstrap helper as an ongoing synchronization mechanism.

## Verification

Node tests cover numeric operators and boundaries, two independent hubs, cross-home rejection, offline configuration edits, idempotency, stale revisions, reconnect application and deletion, plus existing schedules/events/legacy protocol tests. `scripts/verify-offline-home.js` verifies an offline Egypt home using a temporary device and disabled event and cleans up both. The Android emulator was cold-started without networking to verify cached homes/devices/events and offline statuses.
