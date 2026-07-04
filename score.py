"""Retired legacy CLI.

Use `/evaluate-resume <pdf>` inside OpenCode instead.
"""

import sys


MIGRATION_MESSAGE = (
    "This project now routes AI calls through OpenCode. "
    "Use `/evaluate-resume <pdf>` inside OpenCode."
)


def main() -> int:
    print(MIGRATION_MESSAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
