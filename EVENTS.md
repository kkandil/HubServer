# Conditional events

Events are saved on the Pi in `conditional_events` in the existing SQLite database. The Heroku gateway only relays requests and updates. Firmware changes are not required.

## In the Android app

Select a home on Home, then open **Events** in the bottom navigation. Tap **+**, enter a name, and add one or more conditions under **If** and actions under **Then**. Each row selects a device and variable from that home, then a typed value. Boolean variables offer ON/OFF; numeric variables use a numeric keyboard; strings accept text (including an empty string).

AND joins conditions in the same group. OR starts a new group. For example, A AND B OR C means `(A AND B) OR C`. Any group matching triggers every action, in listed order. Numeric conditions support =, >, >=, < and <=. Text and boolean conditions use equality. Tap a row to edit it, or its trash icon to remove it. At least one condition and one action are required.

New events default to paused. Enable in the editor or use the switch in the Events list. Events can be edited and deleted from that list. Editor drafts survive normal Android configuration changes.

## Execution semantics

- Evaluates server variable updates from devices, phone writes, schedules, and event actions.
- Runs on a false-to-true transition of the complete expression, not on every equal sensor report.
- Saving, enabling and restarting establish the current values as a baseline; they do not immediately run actions or replay missed transitions.
- Numeric equality compares numbers (`1` and `1.0` match). Boolean values normalize 0/1/false/true. Text equality is exact and case sensitive.
- Uses the latest stored condition values, including cached values from currently offline source devices.
- An offline action target is skipped without queuing. Other actions continue. A last-run result records each action as sent, skipped_offline, missing_target or failed. Sent indicates transport dispatch, not a hardware acknowledgment.
- The transition is recorded before dispatch, so a restart cannot repeat a claimed event. A crash between claim and dispatch can miss an action. A crash mid-run can leave the last result as running; it is not replayed.
- Enabled rules with direct variable dependency cycles are rejected, including cycles across multiple events. Disabled events may be saved but cannot be enabled until the cycle is resolved.
- Every false-to-true condition transition is queued, including rapid repeated transitions. There is no cooldown that discards triggers. Duplicate reports while a condition remains true do not repeat actions. All matching events run in order, even when new reports arrive while an action is pending. Configured event cycles remain rejected; avoid feedback loops implemented indirectly in firmware.
- Removing a referenced variable, device or home removes events using it. Removing a dashboard widget does not remove an event.

## Protocol

Requests and replies use `requestId`. Successful replies have `status: "OK"`; failures have `status: "Error"` and `message`.

- `GetEvents { homeName }` → `{ events }`
- `GetEventVariables { homeName }` → `{ devices: [{ deviceID, deviceName, variables: [{ varName, varType }] }] }`
- `SaveEvent { homeName, id?, name, enabled, conditions, actions }` → `{ event }`
- `SetEventEnabled { homeName, id, enabled }` → `{ event }`
- `DeleteEvent { homeName, id }`
- `EventsChanged { homeName }` broadcasts after mutations and runs.

Each condition/action includes `deviceID`, `varName`, `varValue` (string). Conditions after the first require `join: "AND" | "OR"`. The server resolves types and device names from authoritative variable records. Limits: name 80 characters; up to 32 conditions and 32 actions; values 1024 characters.

## Verification and deployment

Run `npm test` using Node 24. Tests cover precedence, typed equality, transitions, duplicate reports, restart baselines, enable/disable, offline and failed actions, loops, home scoping, deletion cleanup, and actual gateway/bridge/local-server behavior.

`node scripts/test-physical-event.js` is specifically for TestDev_1 (ID 1007) and its in-memory slider variables. It reads/restores their values and removes its temporary rule. It must not be repurposed for actuator variables without reviewing the targets.

The initial Events release was `/home/khaled/smarthome/releases/events-v1`. See MULTI_HOME.md for the current release and cloud configuration ownership. Backup before deployment: `/home/khaled/smarthome/backups/before-events-20260921.sqlite`. Heroku gateway release: v6. Include **events.js** along with scheduler.js and the other modules when packaging future Pi updates. Use the existing SQLite backup script to include both events and schedules.
