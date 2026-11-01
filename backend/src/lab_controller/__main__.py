import argparse
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from .ipc.server import serve


def main():
    parser = argparse.ArgumentParser(description='甘蓝试验台真实硬件控制进程')
    parser.add_argument('--data-dir', required=True)
    args = parser.parse_args()
    root = Path(args.data_dir).resolve()
    logs = root / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(logs / 'controller.log', maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, handlers=[handler], format='%(asctime)s %(levelname)s %(message)s')
    try:
        serve(root)
    except Exception:
        logging.exception('控制进程退出')
        raise


if __name__ == '__main__':
    main()
