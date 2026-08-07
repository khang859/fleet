import { describe, it, expect } from 'vitest';
import { startCallback, CALLBACK_URLS, DEFAULT_CALLBACK_URL } from '../callback';

/**
 * A real listener on a real port, driven with a real request.
 *
 * Nothing here is stubbed, because what could go wrong is exactly the part a
 * stub would paper over: which address it binds, whether the port is released
 * afterwards, and whether the query survives the trip.
 */

describe('the sign-in callback', () => {
  it('hands back the query the browser arrived with', async () => {
    const callback = await startCallback();
    const arrival = callback.wait();

    await fetch(`${callback.redirectUrl}?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example`);
    const params = await arrival;

    expect(params.get('code')).toBe('abc');
    expect(params.get('state')).toBe('xyz');
    // Whole, rather than picked apart: `finishAuth` checks `iss` against the
    // issuer it recorded before reading anything else.
    expect(params.get('iss')).toBe('https://auth.example');
  });

  it('listens on the address it tells the server to come back to', async () => {
    const callback = await startCallback();
    try {
      // Never the name: it can resolve to ::1 first, and a server redirecting
      // to the name while we listened on the address hangs on a dead page.
      expect(callback.redirectUrl.startsWith('http://127.0.0.1:')).toBe(true);
      expect(CALLBACK_URLS).toContain(callback.redirectUrl);
    } finally {
      callback.close();
    }
  });

  it('shows the user something, so the tab is not left blank', async () => {
    const callback = await startCallback();
    const arrival = callback.wait();

    const res = await fetch(`${callback.redirectUrl}?code=abc`);
    const body = await res.text();
    await arrival;

    expect(res.status).toBe(200);
    expect(body).toContain('go back to Fleet');
  });

  it('lets go of the port once the sign-in is over', async () => {
    const first = await startCallback();
    const port = new URL(first.redirectUrl).port;
    const arrival = first.wait();
    await fetch(`${first.redirectUrl}?code=abc`);
    await arrival;

    // The same port again, which only works if the first one really closed.
    const second = await startCallback();
    try {
      expect(new URL(second.redirectUrl).port).toBe(port);
    } finally {
      second.close();
    }
  });

  it('steps to the next port when one is already taken', async () => {
    const held = await startCallback();
    try {
      const next = await startCallback();
      try {
        expect(next.redirectUrl).not.toBe(held.redirectUrl);
        expect(CALLBACK_URLS).toContain(next.redirectUrl);
      } finally {
        next.close();
      }
    } finally {
      held.close();
    }
  });

  it('gives up when the turn it belongs to is stopped', async () => {
    const controller = new AbortController();
    const callback = await startCallback(controller.signal);
    const arrival = callback.wait();

    controller.abort();

    await expect(arrival).rejects.toThrow(/cancelled/);
  });

  it('ignores anything on the port that is not the browser coming back', async () => {
    const callback = await startCallback();
    try {
      const res = await fetch(`http://127.0.0.1:${new URL(callback.redirectUrl).port}/favicon.ico`);
      expect(res.status).toBe(404);
    } finally {
      callback.close();
    }
  });

  it('closes cleanly even when nobody ever arrived', async () => {
    const callback = await startCallback();
    expect(() => {
      callback.close();
      callback.close();
    }).not.toThrow();
  });

  it('points a provider with no flow running at a real candidate', () => {
    expect(CALLBACK_URLS).toContain(DEFAULT_CALLBACK_URL);
  });
});
