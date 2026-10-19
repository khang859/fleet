# `/clear` on an Admiral thread could leave it on a dead session

## What happened

`/clear` asks main for a fresh session id, and main records it at once.
The renderer only blocked `check()` during that round trip.
A wakeup pull already in flight, or a message the client sent, could still start a turn on the old id.
Main then refused that turn ("This conversation is not the Bridge of ..."), the thread could not move while the turn ran, and every later turn failed until a reload.

The lobby clear also replaced the pane's `Attached` object.
Every `attached.get(paneId) !== pane` check then read as "detached", so an in-flight job pull, a pending refresh or a handoff was dropped.

## How it was fixed

- `deliver()` holds a batch while the thread is clearing; the clear's own `check()` delivers it after.
- `send()` asks the runtime's `hold` hook first, and a message sent during the clear goes out on the new session.
- If a turn starts anyway, the new id is adopted in `turnEnded`.
- The lobby id is changed on the `Attached` object in place, so its identity still means "same attach".

## Rule

When a state flag says "no turn may start", find every path that starts one: the scheduler, a pull that is already in flight, and the client.
Object identity used as an "is this still the same attach" token must never be replaced for an ordinary update.
