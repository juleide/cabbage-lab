"""Frozen executable entry point; control logic remains in lab_controller."""
import sys

from lab_controller.__main__ import main

if __name__ == '__main__':
    # Frozen Python ignores some interpreter environment flags on Windows.
    # Keep the existing JSONL wire encoding independent of the system locale.
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8', write_through=True)
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    main()
