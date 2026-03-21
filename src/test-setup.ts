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
