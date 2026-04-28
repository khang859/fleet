# Pi plan modal bridge disconnect handling

## Symptom

The Pi plan modal response flow initially assumed that once `pi.plan_open` returned, the Fleet bridge would stay connected until the user clicked Approve/Reject/Continue. If the WebSocket disconnected after opening the modal but before the response, `exit_plan_mode` could wait forever. After adding delivery failure checks, the modal could also become effectively unclosable because every dismissal path tried to send `continue` through the disconnected bridge.

## Fix

- Add a disconnect callback to the Fleet Pi bridge extension client.
- Have pending `exit_plan_mode` response waiters resolve as `continue` on bridge disconnect, matching abort behavior.
- Make renderer-side response delivery failures visible but non-blocking by showing an error with a direct Dismiss escape hatch.
- When invoking disconnect handlers, iterate over a copy so handlers can unsubscribe themselves without skipping later handlers.

## Lesson

For two-way UI flows over an agent bridge, handle all lifecycle edges explicitly:

1. Request opened but response never arrives.
2. Response send fails after user action.
3. User needs a local dismiss path even if the agent can no longer be notified.
4. Event handler arrays must tolerate handlers unregistering during dispatch.
