import { vi } from 'vitest';

// Mock Electron app for logger module (and any other module that imports electron)
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'home') return '/tmp/fleet-test';
      return '/tmp';
    },
    getAppPath: () => '/tmp/fleet-test-app'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}));

// Mock winston-daily-rotate-file to avoid real file I/O in tests
vi.mock('winston-daily-rotate-file', () => {
  const Transport = vi.fn();
  Transport.prototype.on = vi.fn();
  Transport.prototype.log = vi.fn();
  return { default: Transport };
});

// Polyfill window for Node.js test environment (renderer tests need window.fleet)
if (typeof window === 'undefined') {
  Object.assign(globalThis, {
    window: {
      fleet: {} as Record<string, unknown>
    }
  });
}

// Polyfill localStorage for Node.js test environment (renderer stores use it).
// Node 22+ has a global localStorage that requires --localstorage-file to work;
// when not available, getItem is undefined. Always install our own.
if (!globalThis.localStorage?.getItem) {
  const store: Record<string, string> = {};
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key of Object.keys(store)) delete store[key];
      }
    }
  });
}

// Polyfill OffscreenCanvas for Node.js test environment
if (typeof OffscreenCanvas === 'undefined') {
  class FakeOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext(_type: string): object {
      void _type;
      return {
        clearRect: () => {},
        fillRect: () => {},
        createLinearGradient: () => ({
          addColorStop: () => {}
        }),
        drawImage: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        set fillStyle(_v: unknown) {},
        set strokeStyle(_v: unknown) {},
        set lineWidth(_v: unknown) {},
        set filter(_v: unknown) {},
        set globalAlpha(_v: unknown) {}
      };
    }
  }

  Object.assign(globalThis, { OffscreenCanvas: FakeOffscreenCanvas });
}
