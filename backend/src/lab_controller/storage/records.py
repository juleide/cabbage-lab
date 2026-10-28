"""SQLite data survives both renderer reloads and controller restarts."""
import json
import sqlite3


class RecordStore:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, library TEXT NOT NULL, started_at TEXT NOT NULL,
                ended_at TEXT, status TEXT NOT NULL, config TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS samples (
                run_id TEXT NOT NULL REFERENCES runs(id), number INTEGER NOT NULL,
                time TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, number)
            );
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY, time TEXT NOT NULL, message TEXT NOT NULL
            );
        ''')
        self.db.execute("UPDATE runs SET status='interrupted' WHERE status='running'")
        self.db.commit()

    def begin(self, run_id, library, at, config):
        self.db.execute('INSERT INTO runs VALUES (?, ?, ?, NULL, ?, ?)',
                        (run_id, library, at, 'running', json.dumps(config)))
        self.db.commit()

    def append(self, run_id, number, at, values):
        self.db.execute('INSERT INTO samples VALUES (?, ?, ?, ?)',
                        (run_id, number, at, json.dumps(values, allow_nan=False)))
        self.db.commit()

    def finish(self, run_id, at, status):
        if run_id:
            self.db.execute('UPDATE runs SET ended_at=?, status=? WHERE id=? AND status=?',
                            (at, status, run_id, 'running'))
            self.db.commit()

    def list(self, library):
        rows = self.db.execute('''SELECT r.id, r.started_at AS startedAt, r.ended_at AS endedAt,
            r.status, COUNT(s.number) AS sampleCount FROM runs r LEFT JOIN samples s ON r.id=s.run_id
            WHERE r.library=? GROUP BY r.id ORDER BY r.started_at DESC LIMIT 50''', (library,))
        return [dict(row) for row in rows]

    def count(self, run_id):
        if not self.db.execute('SELECT 1 FROM runs WHERE id=?', (run_id,)).fetchone():
            raise ValueError('试验记录不存在')
        return self.db.execute('SELECT COUNT(*) FROM samples WHERE run_id=?', (run_id,)).fetchone()[0]

    def read(self, run_id, offset, limit):
        rows = self.db.execute('SELECT time, payload FROM samples WHERE run_id=? AND number>? ORDER BY number LIMIT ?',
                               (run_id, offset, limit))
        return [{'time': row['time'], **json.loads(row['payload'])} for row in rows]

    def log(self, at, message):
        self.db.execute('INSERT INTO logs(time, message) VALUES (?, ?)', (at, message))
        self.db.commit()

    def logs(self):
        return [dict(row) for row in self.db.execute('SELECT time, message FROM logs ORDER BY id DESC LIMIT 200')]

    def close(self):
        self.db.close()
