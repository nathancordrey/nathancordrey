"""Run: python -m art.backup /path/to/art-table-backup.zip"""
import sys
from . import make_backup
if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python -m art.backup OUTPUT.zip (set ART_DATA_DIR)')
    make_backup(sys.argv[1])
    print('Backup written:', sys.argv[1])
