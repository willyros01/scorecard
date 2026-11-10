#!/usr/bin/env python3
"""Exercise the actual build configurator/auditor, including the build 33 defect."""
import pathlib
import plistlib
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
script = root / 'build/ios/camera-permission.py'
with tempfile.TemporaryDirectory() as tmp:
    plist = pathlib.Path(tmp) / 'Info.plist'
    for value in [None, '', '   ', 1, False, []]:
        data = {'CFBundleIdentifier': 'io.github.willyros01.scorecard'}
        if value is not None:
            data['NSCameraUsageDescription'] = value
        plist.write_bytes(plistlib.dumps(data))
        result = subprocess.run([sys.executable, str(script), 'verify', str(plist)], capture_output=True)
        assert result.returncode != 0, f'Accepted invalid description: {value!r}'
    print('PASS  CAM1 missing/empty/non-string camera descriptions rejected (build 33 regression)')
    subprocess.run([sys.executable, str(script), 'configure', str(plist)], check=True)
    subprocess.run([sys.executable, str(script), 'verify', str(plist)], check=True)
    data = plistlib.loads(plist.read_bytes())
    assert data['CFBundleIdentifier'] == 'io.github.willyros01.scorecard'
    before = plist.read_bytes()
    subprocess.run([sys.executable, str(script), 'configure', str(plist)], check=True)
    assert plist.read_bytes() == before
    print('PASS  CAM2 configuration preserves other keys and is repeatable')
    data['NSMicrophoneUsageDescription'] = 'Unexpected permission'
    plist.write_bytes(plistlib.dumps(data))
    result = subprocess.run([sys.executable, str(script), 'verify', str(plist)], capture_output=True)
    assert result.returncode != 0
    print('PASS  CAM3 unrelated permissions remain forbidden')
