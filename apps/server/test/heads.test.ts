import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { faceOf } from '../src/players/heads.js';

describe('player faces from the skin (Philip: new skin did not show)', () => {
  it('cuts out the face, puts the hat layer on top and scales it to 64×64', () => {
    const skin = new PNG({ width: 64, height: 64 });
    const paint = (x: number, y: number, rgba: number[]): void => skin.data.set(rgba, (y * 64 + x) * 4);
    Array.from({ length: 64 }, (_, n) => paint(8 + (n % 8), 8 + Math.floor(n / 8), [200, 0, 0, 255]));
    paint(40, 8, [0, 0, 200, 255]); // hat pixel over the top left of the face
    const face = PNG.sync.read(faceOf(PNG.sync.write(skin)));
    expect([face.width, face.height]).toEqual([64, 64]);
    expect([...face.data.subarray(0, 4)]).toEqual([0, 0, 200, 255]);
    const middle = (32 * 64 + 32) * 4;
    expect([...face.data.subarray(middle, middle + 4)]).toEqual([200, 0, 0, 255]);
  });

  it('ignores the solid hat layer of old 64×32 skins (Notch looked black)', () => {
    const skin = new PNG({ width: 64, height: 32 });
    Array.from({ length: 64 * 32 }, (_, n) => skin.data.set([0, 0, 0, 255], n * 4));
    Array.from({ length: 64 }, (_, n) =>
      skin.data.set([200, 150, 100, 255], ((8 + Math.floor(n / 8)) * 64 + 8 + (n % 8)) * 4),
    );
    const face = PNG.sync.read(faceOf(PNG.sync.write(skin)));
    expect([...face.data.subarray(0, 4)]).toEqual([200, 150, 100, 255]);
  });
});
