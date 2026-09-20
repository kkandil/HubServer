# Variable schedules

In Android Studio, sync/build/run the `SmartHome` project. Connect the app to the new gateway or directly to the Pi. In dashboard Edit mode, open a widget's settings, scroll to **Schedule**, and press **+**. Select the time, one or more days (Sunday first), a value, and time zone, then Save. Tap a saved row to edit it, or Delete to remove it.

- Buttons use their configured ON/OFF values. Checkboxes use 1/0. Text widgets have a text field; numeric variables use numeric input.
- A datastream binding is required. Schedules belong to that home/device/variable and are shared by all widgets bound to it. Deleting a widget does not delete the variable's schedules; deleting the variable, device, or home does.
- Schedule Save takes effect immediately and also persists the widget's current configuration. The separate Save Settings button is not required to activate a saved schedule.
- Time zones default to the phone's time zone, not the Pi's system zone. They can be changed, for example to `Europe/Berlin` or `Africa/Cairo`.
- The Pi checks once per second and dispatches within the selected minute. Schedules survive service restarts and do not require the app or gateway to remain connected.
- Devices must be connected to the Pi at execution time. Offline occurrences are marked `skipped_offline`, do not change the stored value, and are not queued for later delivery. Entirely missed minutes while the service is down are not replayed.
- The Pi needs an accurate system clock. Daylight-saving repeated local times execute once; nonexistent local times are skipped.
- Saving a rule in its matching minute does not immediately execute it. It becomes eligible at the next minute boundary.
- Occurrences are claimed persistently before dispatch, preventing repeated sends after restart. A crash between claim and dispatch can miss that occurrence rather than risk a duplicate.
- `sent` means the command was dispatched to the device socket, not that the hardware acknowledged it. Current firmware can publish its own response as usual. Server variable updates are broadcast to apps consistently with existing write behavior.
- Button schedules send a single selected value; push buttons are not automatically released. Add a separate OFF schedule when needed.

## Protocol

Requests and matching responses: `GetSchedules`, `SaveSchedule`, `DeleteSchedule`. Every request includes `requestId`, `homeName`, numeric `deviceID`, and `varName`. Responses include the matching `requestId` and `status` (`OK` or `Error`); errors include `message`.

`SaveSchedule` adds `time` (`HH:mm`), `days` (0=Sunday through 6=Saturday), `timeZone` (IANA ID), `varType`, and string `varValue`. Optional `valueLabel` is `ON` or `OFF`. Include `id` to edit an existing schedule. `DeleteSchedule` requires `id`. `GetSchedules` returns `schedules`; Save returns `schedule`.

The Pi broadcasts `SchedulesChanged` with the target fields on mutations and after dispatch. Android refreshes the list on this event. Gateway outage errors retain `requestId` so the panel can display failures without claiming a save succeeded.

Storage: the `schedules` SQLite table in the existing Pi database. Logs: `sudo journalctl -u smarthome-local -f`.

## Verification

- Android debug build passed and the schedule editor/list/save/delete flow was exercised in the emulator.
- Five automated tests cover existing protocol behavior plus schedule CRUD, time zones/weekdays, SQLite persistence, restart deduplication, DST, validation, offline skips, and target cleanup.
- A live scheduled value of 47 reached physical TestDev_1 on the Pi, and its `SliderCtrlInt_State` response arrived through Heroku. The test schedule was deleted and its original value restored.
- An emulator-created schedule for an offline device was saved, listed with `skipped offline`, and deleted successfully.
- Backup before deployment: `/home/khaled/smarthome/backups/before-schedules.sqlite`.

The original Heroku `smarthome` server is unchanged and does not implement these schedule events.
