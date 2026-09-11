// Shared by the browser and offline validator: one delivery acceptance policy.
export function validateScanManifest(value) {
  const manifest = value;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.id !== 'concrete-pavement-03' || manifest.license !== 'CC0-1.0'
    || manifest.normalConvention !== 'OpenGL' || typeof manifest.tileMeters !== 'number'
    || !Number.isFinite(manifest.tileMeters) || manifest.tileMeters <= 0 || manifest.tileMeters > 20) {
    throw new Error('Unsupported scanned-material contract');
  }
  for (const tier of ['1k', '2k']) {
    const resolution = tier === '1k' ? 1024 : 2048;
    for (const role of ['albedo', 'normal', 'arm']) {
      const map = manifest.maps?.[tier]?.[role];
      if (!map || typeof map.file !== 'string' || !/^concrete-pavement-03-(albedo|normal|arm)-(1k|2k)-[a-f0-9]{12}\.webp$/.test(map.file)
        || !map.file.startsWith(`concrete-pavement-03-${role}-${tier}-`)
        || typeof map.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(map.sha256) || !map.file.endsWith(`-${map.sha256.slice(0, 12)}.webp`)
        || !Number.isSafeInteger(map.bytes) || map.bytes <= 0 || map.bytes > 9_000_000
        || map.width !== resolution || map.height !== resolution || map.colorSpace !== (role === 'albedo' ? 'srgb' : 'linear')) {
        throw new Error(`Invalid scanned-material ${role}/${tier}`);
      }
    }
  }
  return manifest;
}
