"""Discover serial ports without opening them or sending device commands."""


def list_ports():
    try:
        from serial.tools import list_ports as discovery
    except ImportError as exc:
        raise ValueError('串口扫描不可用：请在控制端 Python 环境安装 backend/requirements.txt 中的依赖') from exc
    try:
        found = discovery.comports()
        ports = []
        for port in found:
            ports.append({
                'port': port.device,
                'description': port.description or '',
                'manufacturer': port.manufacturer,
                'vid': port.vid,
                'pid': port.pid,
                'serialNumber': port.serial_number,
                'location': port.location,
            })
        return {'ports': sorted(ports, key=lambda item: item['port'])}
    except (OSError, RuntimeError) as exc:
        raise ValueError(f'串口扫描失败：{exc}') from exc
