#!/usr/bin/env python3
"""Configure or audit the permission used by Manage > Take a photo."""
import plistlib
import sys

KEY = 'NSCameraUsageDescription'
DESCRIPTION = 'The Scorecard uses your camera to photograph a golf course scorecard so you can read and verify its tees and hole details.'


def verify(data):
    value = data.get(KEY)
    if not isinstance(value, str) or not value.strip():
        raise ValueError('NSCameraUsageDescription must be a nonempty string')
    unexpected = sorted(k for k in data if k.startswith('NS') and k.endswith('UsageDescription') and k != KEY)
    if unexpected:
        raise ValueError('Unexpected usage descriptions: ' + ', '.join(unexpected))


def main():
    mode, path = sys.argv[1:]
    with open(path, 'rb') as f:
        data = plistlib.load(f)
    if mode == 'configure':
        data[KEY] = DESCRIPTION
        with open(path, 'wb') as f:
            plistlib.dump(data, f, sort_keys=False)
    elif mode != 'verify':
        raise ValueError('Expected configure or verify')
    verify(data)
    print('PASS  camera permission: ' + path)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL  camera permission: ' + str(error), file=sys.stderr)
        sys.exit(1)
