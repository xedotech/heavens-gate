import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { HeavensGateEngine } from './engine';

vi.mock('./props', async (importOriginal) => ({
  ...await importOriginal<typeof import('./props')>(),
  fetchVerifiedAsset: vi.fn(async () => ({ bytes: new ArrayBuffer(4) })),
}));

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('releases decoded HDRs when conversion fails or engine is disposed (%s)', async (disposed) => {
  const sources = [new THREE.DataTexture(), new THREE.DataTexture()];
  const disposals = sources.map((source) => vi.spyOn(source, 'dispose'));
  vi.spyOn(HDRLoader.prototype, 'loadAsync')
    .mockResolvedValueOnce(sources[0]).mockResolvedValueOnce(sources[1]);
  const convert = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular')
    .mockImplementation(() => { throw new Error('GPU conversion failed'); });
  const release = vi.spyOn(THREE.PMREMGenerator.prototype, 'dispose').mockImplementation(() => {});
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const fallback = new THREE.Texture();
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    renderer: {}, scene: { environment: fallback }, disposed,
  }) as { loadHdriEnvironments(): Promise<void>; scene: { environment: THREE.Texture } };
  await engine.loadHdriEnvironments();
  disposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
  expect(convert).toHaveBeenCalledTimes(disposed ? 0 : 2);
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  expect(engine.scene.environment).toBe(fallback);
});

it('waits for a pending sibling HDR before releasing shared processing resources', async () => {
  const hdr = new THREE.DataTexture();
  const texture = new THREE.Texture();
  const hdrDispose = vi.spyOn(hdr, 'dispose');
  const textureDispose = vi.spyOn(texture, 'dispose');
  let finish!: (value: THREE.DataTexture) => void;
  const pending = new Promise<THREE.DataTexture>((resolve) => { finish = resolve; });
  const load = vi.spyOn(HDRLoader.prototype, 'loadAsync')
    .mockRejectedValueOnce(new Error('Missing street HDR'))
    .mockReturnValueOnce(pending);
  const generatorDispose = vi.spyOn(THREE.PMREMGenerator.prototype, 'dispose').mockImplementation(() => {});
  vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular')
    .mockReturnValue({ texture } as THREE.WebGLRenderTarget);
  const fallback = new THREE.Texture();
  const engine = Object.assign(Object.create(HeavensGateEngine.prototype), {
    renderer: {}, scene: { environment: fallback }, disposed: false,
  }) as { loadHdriEnvironments(): Promise<void>; scene: { environment: THREE.Texture } };
  const loading = engine.loadHdriEnvironments();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(generatorDispose).not.toHaveBeenCalled();
  finish(hdr);
  await loading;
  expect(hdrDispose).toHaveBeenCalledOnce();
  expect(textureDispose).toHaveBeenCalledOnce();
  expect(generatorDispose).toHaveBeenCalledOnce();
  expect(engine.scene.environment).toBe(fallback);
});
