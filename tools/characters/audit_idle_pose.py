"""Narrow regression gate for relaxed idle arms, not full animation approval.

Call audit_idle(rig) after importing a hero GLB and selecting its HG_Idle action.
Coordinates are armature-local Z-up, as presented by Blender's glTF importer.
"""
import json
import math
import argparse
from pathlib import Path
import runpy
import sys

import bpy


def audit_idle(rig):
    if not rig.animation_data or not rig.animation_data.action:
        raise RuntimeError('Idle audit requires an active action')
    action = rig.animation_data.action
    if not (action.name == 'HG_Idle' or action.name.startswith('HG_Idle.')):
        raise RuntimeError('Idle audit refuses a non-idle action')
    previous_frame = bpy.context.scene.frame_current
    samples = []
    failures = []
    start, end = action.frame_range
    try:
        for frame in (round(start), round((start + end) / 2), round(end)):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            for side in ('l', 'r'):
                upper = rig.pose.bones[f'upperarm_{side}']
                lower = rig.pose.bones[f'lowerarm_{side}']
                hand = rig.pose.bones[f'hand_{side}']
                direction = upper.tail - upper.head
                lateral_ratio = math.hypot(direction.x, direction.y) / max(1e-8, -direction.z)
                finite = all(math.isfinite(value) for point in (upper.head, lower.head, hand.head) for value in point)
                checks = {
                    'finite': finite,
                    'armDown': direction.z < 0 and lateral_ratio < 0.45,
                    'handBelowElbow': hand.head.z < lower.head.z,
                    'notCrossed': hand.head.x * upper.head.x > 0,
                }
                samples.append({'frame': frame, 'side': side, 'lateralRatio': lateral_ratio, 'checks': checks})
                failures.extend(f'{frame}:{side}:{name}' for name, passed in checks.items() if not passed)
    finally:
        bpy.context.scene.frame_set(previous_frame)
    report = {'scope': 'idle arm alignment only', 'samples': samples, 'failures': failures}
    print('HG_IDLE_AUDIT=' + json.dumps(report))
    if failures:
        raise RuntimeError('Idle arm regression: ' + ', '.join(failures))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    identities = ('seraph', 'relic', 'nocturne', 'ash', 'meridian', 'voidborn')
    assets = [args.assets / f'aurel-{identity}-hero.glb' for identity in identities]
    missing = [str(asset) for asset in assets if not asset.is_file()]
    if missing:
        raise RuntimeError('Incomplete cast: ' + ', '.join(missing))
    preview = runpy.run_path(str(Path(__file__).with_name('render_turntables.py')),
                            run_name='hg_idle_preview')['render_asset']
    for identity, asset in zip(identities, assets):
        preview(asset.resolve(), Path('unused.png'), inspect_only=True)
        rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
        print('HG_CAST_ID=' + identity)
        audit_idle(rig)
    print('HG_IDLE_CAST_PASS=6')


if __name__ == '__main__':
    main()
