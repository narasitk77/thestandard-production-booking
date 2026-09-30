#!/usr/bin/env python3
"""schema_diff.py — อะไรใน DB จะหายถ้าคอนเทนเนอร์ push schema ของอีกเวอร์ชัน (ใช้โดย deploy.py + rollback.py)

WHY THIS FILE EXISTS (v1.252). คอนเทนเนอร์ push schema ทุก boot · อิมเมจที่ schema ไม่มีตาราง/คอลัมน์/ค่า enum
ที่ DB มีอยู่ = DROP ทิ้งพร้อมข้อมูล · rollback.py เดิมเตือนจากธง `schema_changed` ของ **deploy รอบล่าสุด** เท่านั้น
⇒ `rollback.py <sha เก่ากว่านั้น>` ไม่เตือนเลย (30 ก.ย. 2569: ถอยข้าม v1.249 = ตาราง mix_job_events หายทั้งตาราง
โดยไม่มีคำเตือน · เคยเกิดจริงแล้วที่ v1.231: ถอยแล้วผู้กำกับคนที่ 2-3 ของทุกใบหาย)

หลักคิด: เทียบ **ของสองเวอร์ชันจริง** ไม่ใช่ธงของรอบใดรอบหนึ่ง · เทียบด้วย **ชื่อใน DB** (@@map / @map) เพราะ Prisma
ลบของตามชื่อใน DB — rename ฝั่งโค้ดที่ยังชี้ชื่อเดิมใน DB ไม่ใช่การลบ · field ความสัมพันธ์ (ชนิดเป็น model) ไม่มีคอลัมน์ ข้าม

ขอบเขตที่ตั้งใจ: ไม่จับการเปลี่ยนชนิดคอลัมน์ — Prisma ปฏิเสธเองถ้ามีข้อมูล ("cannot be executed", ทดสอบแล้ว 30 ก.ย.)
และด่านตอน boot (scripts/schema-sync.js) ข้ามการ push ที่จะเสียข้อมูลอยู่แล้ว ตัวนี้คือด่านก่อนยิงให้คนตัดสินใจ

ใช้: python3 scripts/ops/schema_diff.py <from-sha> <to-sha>   (พิมพ์สิ่งที่จะหายถ้า DB ของ from ถูก push ด้วย to)
     python3 scripts/ops/schema_diff.py --selftest
"""
import os, re, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_BLOCK = re.compile(r'^\s*(model|enum|view)\s+(\w+)\s*\{')
_MAP_ARG = re.compile(r'@map\(\s*(?:name\s*:\s*)?"([^"]+)"')
_BLOCK_MAP = re.compile(r'^\s*@@map\(\s*(?:name\s*:\s*)?"([^"]+)"')


def schema_items(text):
    """ชุดของสิ่งที่อยู่ใน DB ตาม schema นี้: table:<t> · column:<t>.<c> · enum:<e> · enumvalue:<e>.<v>"""
    blocks = []  # (kind, name, [lines])
    cur = None
    for raw in text.splitlines():
        line = raw.strip()
        if cur is None:
            m = _BLOCK.match(line)
            if m:
                cur = (m.group(1), m.group(2), [])
            continue
        if line.startswith('}'):
            blocks.append(cur)
            cur = None
            continue
        cur[2].append(line)
    if cur is not None:
        raise ValueError(f'schema อ่านไม่ครบ — block {cur[1]} ไม่มีวงเล็บปิด')

    models = {name for kind, name, _ in blocks if kind in ('model', 'view')}
    items = set()
    for kind, name, lines in blocks:
        body = [l for l in lines if l and not l.startswith('//')]
        db_name = next((m.group(1) for l in body for m in [_BLOCK_MAP.match(l)] if m), name)
        if kind == 'enum':
            items.add(f'enum:{db_name}')
            for l in body:
                if l.startswith('@@'):
                    continue
                tok = l.split()[0]
                m = _MAP_ARG.search(l)
                items.add(f'enumvalue:{db_name}.{m.group(1) if m else tok}')
            continue
        if kind == 'view':
            continue  # view ไม่ใช่ตารางที่ push สร้าง/ลบข้อมูล
        items.add(f'table:{db_name}')
        for l in body:
            if l.startswith('@@'):
                continue
            parts = l.split()
            if len(parts) < 2:
                continue
            field, ftype = parts[0], parts[1]
            base = ftype.rstrip('?').replace('[]', '')
            if base in models:
                continue  # field ความสัมพันธ์ — ไม่มีคอลัมน์ของตัวเอง
            m = _MAP_ARG.search(l)
            items.add(f'column:{db_name}.{m.group(1) if m else field}')
    return items


def _collapse(gone):
    """ตัดคอลัมน์/ค่า enum ของตารางหรือ enum ที่หายทั้งก้อนออก (บอกระดับตารางพอ) · เรียงตาราง/enum ก่อน"""
    whole = {g.split(':', 1)[1] for g in gone if g.startswith(('table:', 'enum:'))}
    out = [g for g in gone if not (g.startswith(('column:', 'enumvalue:')) and g.split(':', 1)[1].split('.')[0] in whole)]
    return sorted(out, key=lambda g: (g.split(':')[0] not in ('table', 'enum'), g))


def removals(from_text, to_text):
    """สิ่งที่มีใน DB ของ from แต่ไม่มีใน schema ของ to = สิ่งที่ push ด้วย to จะลบทิ้ง"""
    return _collapse(schema_items(from_text) - schema_items(to_text))


def _strip_comment(line):
    """ตัด // ท้ายบรรทัดที่อยู่นอกเครื่องหมายคำพูด (default ที่เป็น URL มี // ได้)"""
    q = False
    for i, ch in enumerate(line):
        if ch == '"' and (i == 0 or line[i - 1] != '\\'):
            q = not q
        elif not q and line.startswith('//', i):
            return line[:i].rstrip()
    return line


_PG_BASE = {'String': 'text', 'Int': 'integer', 'BigInt': 'bigint', 'Float': 'double precision',
            'Decimal': 'numeric(65,30)', 'Boolean': 'boolean', 'DateTime': 'timestamp(3) without time zone',
            'Json': 'jsonb', 'Bytes': 'bytea'}
_PG_DB = {'VarChar': 'character varying({})', 'Char': 'character({})', 'Text': 'text', 'Date': 'date',
          'Timestamptz': 'timestamp({}) with time zone', 'Timestamp': 'timestamp({}) without time zone',
          'Time': 'time({}) without time zone', 'Decimal': 'numeric({})', 'SmallInt': 'smallint', 'Integer': 'integer',
          'BigInt': 'bigint', 'Real': 'real', 'DoublePrecision': 'double precision', 'Uuid': 'uuid', 'JsonB': 'jsonb',
          'Json': 'json', 'Boolean': 'boolean', 'ByteA': 'bytea'}


def field_specs(text):
    """อ่าน schema เป็นสิ่งที่ Postgres จะเห็น (ชื่อใน DB) — ใช้เทียบกับ DB จริงทั้งชนิด / NOT NULL / unique / PK
    คืน (cols, uniques, pks) · cols[column:<t>.<c>] = {pg, notnull, default ('db'|'prisma'|None), table}
    ตรวจแล้ว 30 ก.ย. 2569: schema ของพรอด (a622aab) ตรงกับ DB จริงทุกคอลัมน์ (--validate)"""
    blocks, cur = [], None
    for raw in text.splitlines():
        line = _strip_comment(raw.strip())
        if cur is None:
            m = _BLOCK.match(line)
            cur = (m.group(1), m.group(2), []) if m else None
            continue
        if line.startswith('}'):
            blocks.append(cur); cur = None; continue
        if line and not line.startswith('//'):
            cur[2].append(line)
    models = {n for k, n, _ in blocks if k in ('model', 'view')}
    enums = {}
    for k, n, body in blocks:
        if k == 'enum':
            enums[n] = next((m.group(1) for l in body for m in [_BLOCK_MAP.match(l)] if m), n)
    cols, uniques, pks = {}, set(), {}
    for k, n, body in blocks:
        if k != 'model':
            continue
        table = next((m.group(1) for l in body for m in [_BLOCK_MAP.match(l)] if m), n)
        dbname = {}
        for l in body:
            parts = l.split()
            if len(parts) < 2 or l.startswith('@@'):
                continue
            field, tok = parts[0], parts[1]
            base = tok.rstrip('?').replace('[]', '')
            if base in models:
                continue
            m = _MAP_ARG.search(l)
            col = m.group(1) if m else field
            dbname[field] = col
            dbm = re.search(r'@db\.(\w+)(?:\(([^)]*)\))?', l)
            if dbm:
                tmpl = _PG_DB.get(dbm.group(1))
                pg = tmpl.format((dbm.group(2) or '').replace(' ', '')) if tmpl else f'?@db.{dbm.group(1)}'
                pg = pg.replace('()', '(3)') if pg.startswith(('timestamp(', 'time(')) and '()' in pg else pg
            elif base in enums:
                pg = enums[base]
            else:
                pg = _PG_BASE.get(base, f'?{base}')
            if tok.endswith('[]'):
                pg += '[]'
            dm = re.search(r'@default\(\s*(\w+)?', l)
            default = None
            if dm:
                default = 'prisma' if (dm.group(1) or '') in ('cuid', 'uuid', 'nanoid', 'ulid') else 'db'
            if '@updatedAt' in l and default is None:
                default = 'prisma'
            # scalar list (text[]) ของ Prisma เป็น nullable ใน Postgres แม้ไม่มี ? (ตรวจกับ DB พรอด: 7/7 คอลัมน์)
            cols[f'column:{table}.{col}'] = {'pg': pg, 'notnull': not tok.endswith('?') and not tok.endswith('[]'), 'default': default, 'table': table}
            if re.search(r'@id\b', l):
                pks[table] = (col,)
            if re.search(r'@unique\b', l):
                uniques.add((table, (col,)))
        for l in body:
            m = re.match(r'@@(id|unique)\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]', l)
            if m:
                fs = tuple(dbname.get(f.strip(), f.strip()) for f in m.group(2).split(',') if f.strip())
                if m.group(1) == 'id':
                    pks[table] = fs
                else:
                    uniques.add((table, fs))
    return cols, uniques, pks


def _git(*args):
    r = subprocess.run(['git', '-C', REPO, *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} ล้ม: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def resolve(sha_or_tag):
    """'sha-4fd1d8b' / '4fd1d8b' → full sha · หาไม่เจอในเครื่อง = ลอง fetch origin หนึ่งครั้ง · ยังไม่เจอ = raise (fail-closed)"""
    s = sha_or_tag.strip()
    s = s[4:] if s.startswith('sha-') else s
    if not re.fullmatch(r'[0-9a-f]{7,40}', s):
        raise RuntimeError(f'ไม่ใช่ git sha: {sha_or_tag!r}')
    try:
        return _git('rev-parse', '--verify', '--quiet', f'{s}^{{commit}}').strip()
    except RuntimeError:
        _git('fetch', '--quiet', 'origin')
        return _git('rev-parse', '--verify', f'{s}^{{commit}}').strip()


def schema_at(sha):
    return _git('show', f'{sha}:prisma/schema.prisma')


def has_boot_guard(sha):
    """อิมเมจของ sha นี้ push schema ผ่านด่าน (v1.252) ไหม — ดูจาก **คำสั่งที่รันจริง** ไม่ใช่แค่ว่ามีไฟล์
    (ผู้ตรวจ: มีไฟล์แต่ start.sh/npm start ยังเรียก db push --accept-data-loss ตรง ๆ = ไม่มีด่าน)"""
    import json
    try:
        start = _git('show', f'{sha}:start.sh')
        pkg_start = json.loads(_git('show', f'{sha}:package.json')).get('scripts', {}).get('start', '')
        _git('cat-file', '-e', f'{sha}:scripts/schema-sync.js')
    except RuntimeError:
        return False
    live = [l.strip() for l in start.splitlines() if not l.strip().startswith('#')]
    return ('node scripts/schema-sync.js' in live
            and not any('db push' in l for l in live)
            and pkg_start == 'node scripts/schema-sync.js && next start')


def version_at(sha):
    import json
    return json.loads(_git('show', f'{sha}:package.json')).get('version')


# ───────────────────── DB จริงบนพรอด (อ่านอย่างเดียว) ─────────────────────
# เทียบกับ DB ไม่ใช่กับ schema ของ sha ที่รันอยู่ — หลังถอยแบบมีด่าน DB มีของมากกว่า schema ของอิมเมจ
# (ผู้ตรวจจับได้: เทียบ sha กับ sha มองไม่เห็นของที่ด่านเก็บไว้ แล้วถอยรอบที่สองไปอิมเมจเก่าก็ลบมันทิ้ง)
# ตรวจแล้ว 30 ก.ย. 2569 กับ DB พรอด: ชื่อ 566/566 · ชนิด/NOT NULL/default 433/433 คอลัมน์ · unique/PK ครบ — ตรงทั้งหมด
LIVE_SQL = r"""
SELECT 'table:'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
UNION ALL SELECT 'column:'||c.relname||'.'||a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
UNION ALL SELECT 'enum:'||t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'
UNION ALL SELECT 'enumvalue:'||t.typname||'.'||e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
  JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public';
"""
LIVE_COLS_SQL = r"""
SELECT 'col|'||c.relname||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||(a.attnotnull)::text||'|'||(a.atthasdef)::text
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
SELECT 'idx|'||t.relname||'|'||CASE WHEN x.indisprimary THEN 'pk' ELSE 'uq' END||'|'||string_agg(a.attname, ',' ORDER BY k.ord)
FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
WHERE n.nspname='public' AND (x.indisunique OR x.indisprimary) GROUP BY t.relname, x.indexrelid, x.indisprimary;
"""


def _rows(sql):
    """ผลของ SELECT หนึ่งคอลัมน์ผ่าน Portainer exec · เทียบจำนวนกับ footer "(N rows)" — stream ขาดกลางทาง = raise
    (ผู้ตรวจ: ผลที่โดนตัดท้ายยังมีตาราง bookings อยู่ แต่คอลัมน์ท้าย ๆ หายไป = ถูกอ่านว่า "ไม่มีอะไรหาย")"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from offboard import env_file, psql  # ท่า Portainer exec เดียวกับ offboard.py (ไม่มี side effect ตอน import)
    code, out = psql(env_file(), sql, {})
    if code != 0:
        raise RuntimeError(f'psql บนพรอดล้ม (exit {code}): {out.strip()[-300:]}')
    lines = [l.strip() for l in out.replace('\r', '').splitlines() if l.strip()]
    foot = [i for i, l in enumerate(lines) if re.fullmatch(r'\((\d+) rows?\)', l)]
    if not foot:
        raise RuntimeError('ผลจาก psql ไม่มี footer "(N rows)" — อาจโดนตัดกลางทาง')
    n = int(re.search(r'\d+', lines[foot[-1]]).group())
    data = lines[1:foot[-1]]  # บรรทัดแรก = ชื่อคอลัมน์
    if len(data) != n:
        raise RuntimeError(f'psql บอก {n} แถวแต่อ่านได้ {len(data)} — ผลไม่ครบ ตรวจไม่ได้')
    return data


def live_items():
    """ชุดของที่อยู่ใน DB พรอดตอนนี้ รูปเดียวกับ schema_items · อ่านไม่ได้/ผลแปลก = raise (fail-closed)"""
    items = {l for l in _rows(LIVE_SQL) if re.fullmatch(r'(table|column|enum|enumvalue):\S+', l)}
    if 'table:bookings' not in items or len(items) < 100:
        raise RuntimeError(f'อ่าน schema จาก DB พรอดได้ {len(items)} รายการ ไม่มีตาราง bookings — ตรวจอะไรไม่ได้')
    return items


def live_structure():
    """(cols, uniques, pks) ของ DB จริง รูปเดียวกับ field_specs · pg ตัดเครื่องหมายคำพูดของชื่อ enum ออก"""
    cols, uniques, pks = {}, set(), {}
    for r in _rows(LIVE_COLS_SQL):
        p = r.split('|')
        if p[0] == 'col' and len(p) == 6:
            cols[f'column:{p[1]}.{p[2]}'] = {'pg': p[3].replace('"', ''), 'notnull': p[4] == 'true', 'hasdef': p[5] == 'true', 'table': p[1]}
        elif p[0] == 'idx' and len(p) == 4:
            (pks.__setitem__(p[1], tuple(p[3].split(','))) if p[2] == 'pk' else uniques.add((p[1], tuple(p[3].split(',')))))
        else:
            raise RuntimeError(f'อ่านโครงสร้าง DB ไม่ออก: {r[:120]}')
    if not cols:
        raise RuntimeError('อ่านคอลัมน์จาก DB พรอดไม่ได้เลย')
    return cols, uniques, pks


def _ident(name):
    return '"' + name.replace('"', '""') + '"'


def _lit(s):
    return "'" + s.replace("'", "''") + "'"


def _counts(pairs):
    """[(label, SELECT count(...) FROM ...)] → {label: int} ในรอบเดียว · ขาดตัวไหน = raise"""
    if not pairs:
        return {}
    sql = '\nUNION ALL '.join(f"SELECT {_lit(label)}||'|'||({q})::text" for label, q in pairs) + ';'
    got = {}
    for r in _rows(sql):
        label, _, n = r.rpartition('|')
        if n.isdigit():
            got[label] = got.get(label, 0) + int(n) if label in got else int(n)
    missing = [l for l, _ in pairs if l not in got]
    if missing:
        raise RuntimeError(f'นับข้อมูลไม่ครบ: {missing[:5]}')
    return got


def live_data_counts(items):
    """table:x → จำนวนแถว · column:t.c → จำนวนค่าที่ไม่ใช่ NULL (Prisma เตือนเฉพาะที่มีข้อมูล)"""
    pairs = []
    for it in items:
        kind, name = it.split(':', 1)
        if kind == 'table':
            pairs.append((it, f'SELECT count(*) FROM {_ident(name)}'))
        elif kind == 'column':
            t, c = name.split('.', 1)
            pairs.append((it, f'SELECT count({_ident(c)}) FROM {_ident(t)}'))
    return _counts(pairs)


def stack_image_tag():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from offboard import env_file, _portainer
    s = _portainer(env_file(), 'GET', '/api/stacks/125')
    return next((e['value'] for e in (s.get('Env') or []) if e['name'] == 'IMAGE_TAG'), None)


def assess(target):
    """สิ่งที่จะเกิดกับ DB พรอดถ้าคอนเทนเนอร์บูตด้วยอิมเมจของ target — ใช้ทั้ง deploy.py และ rollback.py
    ทุกอย่างเทียบกับ DB จริง (ชื่อ ชนิด NOT NULL unique PK) และนับข้อมูลที่ขัดจริง ไม่ใช่เดาจาก git"""
    t_sha = resolve(target)
    t_text = schema_at(t_sha)
    live = live_items()
    t_items = schema_items(t_text)
    lcols, luq, lpk = live_structure()
    tcols, tuq, tpk = field_specs(t_text)
    removed = _collapse(live - t_items)

    both = sorted(tcols.keys() & lcols.keys())
    type_changes = [f"{c}: {lcols[c]['pg']} → {tcols[c]['pg']}" for c in both if tcols[c]['pg'] != lcols[c]['pg']]
    pk_changes = [f"table:{t}: {','.join(lpk[t])} → {','.join(tpk[t])}" for t in sorted(tpk) if t in lpk and tpk[t] != lpk[t]]
    tighten = [c for c in both if tcols[c]['notnull'] and not lcols[c]['notnull']]
    new_req = [c for c in sorted(tcols) if c not in lcols and tcols[c]['notnull'] and tcols[c]['default'] != 'db'
               and f"table:{tcols[c]['table']}" in live]
    new_uq = sorted(u for u in tuq - luq if f'table:{u[0]}' in live and all(f'column:{u[0]}.{c}' in lcols for c in u[1]))
    gone_vals = [r for r in removed if r.startswith('enumvalue:')]

    pairs = []
    for r in removed:
        kind, name = r.split(':', 1)
        if kind == 'table':
            pairs.append((r, f'SELECT count(*) FROM {_ident(name)}'))
        elif kind == 'column':
            t, c = name.split('.', 1)
            pairs.append((r, f'SELECT count({_ident(c)}) FROM {_ident(t)}'))
    for c in tighten:
        t, col = c.split(':', 1)[1].split('.', 1)
        pairs.append((f'null:{c}', f'SELECT count(*) FROM {_ident(t)} WHERE {_ident(col)} IS NULL'))
    for t in sorted({tcols[c]['table'] for c in new_req}):
        pairs.append((f'rows:{t}', f'SELECT count(*) FROM {_ident(t)}'))
    for t, cs in new_uq:
        nn = ' AND '.join(f'{_ident(c)} IS NOT NULL' for c in cs)
        g = ', '.join(_ident(c) for c in cs)
        pairs.append((f"dup:{t}({','.join(cs)})", f'SELECT count(*) FROM (SELECT 1 FROM {_ident(t)} WHERE {nn} GROUP BY {g} HAVING count(*) > 1) d'))
    for v in gone_vals:  # ค่า enum ที่มีแถวใช้อยู่ = Postgres ลบไม่ได้ = push ล้ม
        e, val = v.split(':', 1)[1].split('.', 1)
        users = [(c, lc['pg']) for c, lc in lcols.items() if lc['pg'] in (e, e + '[]')]
        for c, pg in users:
            t, col = c.split(':', 1)[1].split('.', 1)
            cond = f'{_lit(val)} = ANY({_ident(col)}::text[])' if pg.endswith('[]') else f'{_ident(col)}::text = {_lit(val)}'
            pairs.append((f'enumuse:{v}', f'SELECT count(*) FROM {_ident(t)} WHERE {cond}'))
    got = _counts(pairs)
    counts = {r: got[r] for r in removed if r in got}
    # ค่า enum: Prisma เตือนทุกครั้งไม่ว่ามีแถวใช้หรือไม่ (ทดสอบแล้ว) → นับเป็นของที่ต้องตัดสินเสมอ
    losses = [r for r in removed if counts.get(r, 0) > 0 or r.startswith('enumvalue:')]

    # เปลี่ยนที่ Prisma/Postgres ทำไม่ได้ = push ล้ม = คอนเทนเนอร์วนบูต (set -e) ไม่ว่าอิมเมจจะมีด่านหรือไม่
    blockers = [f"{c} ปลายทางบังคับ NOT NULL แต่ DB มี NULL {got[f'null:{c}']} แถว" for c in tighten if got.get(f'null:{c}', 0) > 0]
    blockers += [f"{c} คอลัมน์บังคับที่ไม่มี default ใน DB แต่ตาราง {tcols[c]['table']} มี {got[f'rows:' + tcols[c]['table']]} แถว"
                 for c in new_req if got.get(f"rows:{tcols[c]['table']}", 0) > 0]
    blockers += [f"unique {t}({','.join(cs)}) แต่มีค่าซ้ำ {got[f'dup:{t}(' + ','.join(cs) + ')']} กลุ่ม"
                 for t, cs in new_uq if got.get(f"dup:{t}({','.join(cs)})", 0) > 0]
    enum_in_use = {v: got.get(f'enumuse:{v}', 0) for v in gone_vals if got.get(f'enumuse:{v}', 0) > 0}

    cur_tag = stack_image_tag()
    is_older = None
    try:
        cur_sha = resolve(cur_tag or '')
        r = subprocess.run(['git', '-C', REPO, 'merge-base', '--is-ancestor', t_sha, cur_sha], capture_output=True, timeout=30)
        is_older = r.returncode == 0 and t_sha != cur_sha
    except RuntimeError:
        pass
    return {
        'target_tag': 'sha-' + t_sha[:7], 'target_sha': t_sha, 'version': version_at(t_sha),
        'guarded': has_boot_guard(t_sha), 'current_tag': cur_tag, 'is_older': is_older,
        'removed': removed, 'counts': counts, 'losses': losses,
        'empty_drops': [r for r in removed if r not in losses],
        'additions': _collapse(t_items - live), 'type_changes': type_changes + pk_changes,
        'blockers': blockers, 'enum_in_use': enum_in_use,
    }


def recount_empty(a):
    """นับ "ของว่าง" ซ้ำก่อนยิง — ระหว่างตรวจกับบูตมีหลายนาที ถ้ามีคนเขียนเข้ามา อิมเมจเก่าจะลบทิ้ง
    คืนรายการที่ไม่ว่างแล้ว (ใช้เฉพาะอิมเมจก่อน v1.252 · อิมเมจมีด่านให้ Prisma นับเองตอนบูต)"""
    got = live_data_counts([r for r in a['empty_drops'] if r.startswith(('table:', 'column:'))])
    return [f'{r} [{n}]' for r, n in got.items() if n > 0]


def verdict(a, mode, opt_in=()):
    """กฎเดียวของ deploy/rollback → (ok, lines, needs_confirm, expect_skip)
    ok=False = ปฏิเสธ · needs_confirm = จะลบข้อมูลจริง ต้องให้คนพิมพ์ยืนยันใน TTY (ปฏิเสธที่ needs_confirm=False ฝืนไม่ได้)"""
    lines = []
    L = a['losses']
    def show(title, xs, n=12):
        if xs:
            lines.append(f'{title} ({len(xs)}):')
            lines.extend(f'    - {x}' + (f'  [{a["counts"][x]} แถว/ค่า]' if x in a['counts'] else '') for x in xs[:n])
            if len(xs) > n:
                lines.append(f'    - …อีก {len(xs) - n}')
    show('ของที่มีข้อมูลและจะหาย', L)
    show('ของว่างที่ push จะลบทิ้ง (ไม่มีข้อมูลเสีย)', a['empty_drops'], 6)
    show('ของที่อิมเมจนี้ต้องเพิ่มเข้า DB', a['additions'], 6)
    show('ชนิดคอลัมน์ / PK ที่ต่างจาก DB จริง', a['type_changes'], 6)
    show('ค่า enum ที่จะหายแต่ยังมีแถวใช้อยู่', [f'{v} [{n} แถว]' for v, n in a['enum_in_use'].items()], 6)
    if any(r.startswith('table:_') for r in a['removed']):
        lines.append('หมายเหตุ: ตาราง `_X` = implicit many-to-many ที่ schema_diff ยังไม่รู้จัก — ถ้ามีจริงให้เพิ่มใน schema_items ก่อน')
    crash = list(a['blockers'])
    if not a['guarded'] or (mode == 'deploy' and a['enum_in_use'] and set(a['enum_in_use']) <= set(opt_in)):
        crash += [f'{v} ยังมีแถวใช้ {n} แถว — Postgres ลบค่า enum ที่ใช้อยู่ไม่ได้' for v, n in a['enum_in_use'].items()]
    if crash:
        show('Prisma/Postgres ทำไม่ได้ → push ล้ม → คอนเทนเนอร์วนบูต เว็บล่ม', crash, 8)
        lines.append('→ ปฏิเสธ (ฝืนไม่ได้ — ฝืนแล้วเว็บล่ม): แก้ข้อมูลที่ขัดก่อน (SQL ก่อน push แบบ enum rename ใน start.sh) หรือเลือกอิมเมจอื่น')
        return False, lines, False, False

    if not a['guarded']:
        lines.insert(0, f"⚠️  {a['target_tag']} เป็นอิมเมจก่อน v1.252 — push schema แบบ --accept-data-loss ทุก boot (ไม่มีด่าน)")
        if L or a['type_changes']:
            lines.append('→ ปฏิเสธ: อิมเมจนี้จะลบ/แปลงข้อมูลข้างบนทิ้งตอนบูต · ทางที่ถูก: revert แล้ว deploy ไปข้างหน้า '
                         'หรือเลือกอิมเมจที่ใหม่กว่า (v1.252+ มีด่าน)')
            return False, lines, True, False
        return True, lines, False, False

    if a['type_changes']:
        lines.append('→ ปฏิเสธ: ชนิดคอลัมน์/PK ต่างจาก DB — ด่านจะข้าม push ทั้งก้อน (หรือ Prisma ปฏิเสธ) โค้ดจะวิ่งบนชนิดที่ผิด '
                     '· เปลี่ยนชนิดให้ทำด้วย SQL ก่อน push ใน start.sh แล้วค่อย deploy')
        return False, lines, False, False

    if mode == 'rollback':
        if L and a['additions']:
            lines.append('→ ปฏิเสธ: ด่านจะข้าม push ทั้งก้อน (all-or-nothing) → อิมเมจนี้ไม่ได้ของที่มันต้องเพิ่ม = โค้ดเก่าพังบนตารางพวกนั้น '
                         '· ทางที่ถูก: revert แล้ว deploy ไปข้างหน้า หรือเลือกอิมเมจอื่น')
            return False, lines, False, False
        if L:
            lines.append('→ ถอยได้: ด่านจะข้าม push และเก็บของข้างบนไว้ใน DB (schemaSync = skipped เป็นเรื่องปกติของการถอย)'
                         ' · โค้ดเก่าที่ลบแล้วสร้างแถวใหม่ (เช่น OT sync) อาจทำค่าในคอลัมน์ใหม่หายได้')
        return True, lines, False, bool(L)

    blocked = [x for x in L if x not in set(opt_in)]
    if blocked:
        if a.get('is_older'):
            lines.append(f"→ ปฏิเสธ: {a['target_tag']} เก่ากว่าที่รันอยู่ = นี่คือการถอย — ใช้ scripts/ops/rollback.py {a['target_tag']} "
                         '(ด่านจะเก็บของพวกนี้ไว้) · อย่าใส่ SCHEMA_ACCEPT_DATA_LOSS')
            return False, lines, False, False
        lines.append('→ ปฏิเสธ: ด่านตอนบูตจะข้าม push ทั้งก้อน รวมของที่ release นี้ต้องเพิ่มด้วย = โค้ดใหม่พัง')
        lines.append(f"   ถ้าตั้งใจลบจริง: --set SCHEMA_ACCEPT_DATA_LOSS='{' '.join(L)}'  (ต้องพิมพ์ยืนยันเองในเทอร์มินัล)")
        lines.append('   แนะนำ: ออก release ที่ "เลิกใช้" ก่อน แล้วค่อยลบใน release ที่มีแต่การลบ')
        return False, lines, False, False
    if L:
        lines.append(f'→ จะลบของที่มีข้อมูล {len(L)} รายการตาม SCHEMA_ACCEPT_DATA_LOSS — ต้องยืนยัน')
    return True, lines, bool(L), False


def confirm_drop(count, tag, items=()):
    """ยืนยันการลบข้อมูล — ถาม/อ่านผ่าน /dev/tty (log ที่ redirect ไปไฟล์ยังเห็น prompt) · ไม่มี terminal = ไม่รับ
    กันพลาดแบบ pipe ข้อความเข้าไปเฉย ๆ ได้ — **ไม่ใช่** ขอบเขตสิทธิ์ (pty ปลอมได้ และ Portainer API เข้าตรงได้)
    ขอบเขตจริงคือกฎข้อ 3 ใน CLAUDE.md: ลบของที่รันบนพรอดต้องได้คำอนุญาตจากนัททุกครั้ง"""
    word = f'DROP {count} {tag}'
    try:
        tty = open('/dev/tty', 'r+')
    except OSError:
        print(f'\n❌ ต้องให้นัทรันเองในเทอร์มินัลแล้วพิมพ์ "{word}" — ไม่มี terminal จึงไม่รับการยืนยัน')
        return False
    with tty:
        if items:
            tty.write('\nจะหายถาวร:\n' + ''.join(f'  - {x}\n' for x in items))
        tty.write(f'พิมพ์ {word} เพื่อยืนยัน: ')
        tty.flush()
        return tty.readline().strip() == word


def _selftest():
    old = '''
model Job {
  id    String @id
  title String
  @@map("jobs")
}
enum Kind {
  A
  B @map("bee")
}'''
    new = '''
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
/// doc comment { with braces }
model Job {
  id     String  @id
  title  String
  note   String? // added
  name   String  @map("label") /// rename in code only
  events Ev[]
  @@index([title])
  @@map("jobs")
}
model Ev {
  id    String @id
  jobId String
  job   Job    @relation(fields: [jobId], references: [id])
  @@map(name: "evs")
}
enum Kind {
  A
  B @map("bee")
  C
}'''
    # ถอยจาก new ไป old: จะหาย = ตาราง evs ทั้งตาราง + คอลัมน์ note/label + ค่า enum C (ไม่รายงานคอลัมน์ของ evs ซ้ำ)
    got = removals(new, old)
    assert got == ['table:evs', 'column:jobs.label', 'column:jobs.note', 'enumvalue:Kind.C'], got
    # ไปข้างหน้า old → new ไม่ลบอะไร
    assert removals(old, new) == [], removals(old, new)
    # rename ฝั่งโค้ดที่ @map กลับชื่อเดิม = ไม่ใช่การลบ
    a = 'model T {\n  id String @id\n  foo String\n}'
    b = 'model T {\n  id String @id\n  bar String @map("foo")\n}'
    assert removals(a, b) == [], removals(a, b)
    # @@map เปลี่ยนชื่อตาราง = ตารางเดิมหายจริง
    assert removals(a, a.replace('}', '  @@map("t2")\n}')) == ['table:T'], 'table rename must count'
    # block ไม่ปิด = อ่านไม่ได้ ต้องดัง ไม่ใช่คืนว่าง
    try:
        schema_items('model X {\n  id String @id\n')
        raise AssertionError('unterminated block must raise')
    except ValueError:
        pass
    # field_specs: ชนิดใน Postgres / NOT NULL / default / unique / PK ตามที่ Prisma จะสร้าง
    spec_txt = """
model Job {
  id      String   @id @default(cuid())
  n       Int      @default(0)
  d       DateTime @db.Date
  v       String?  @db.VarChar(64)
  tags    String[]
  url     String   @default("https://x//y") // ห้ามตัดตรง // ในเครื่องหมายคำพูด
  kind    Kind
  code    String   @unique @map("job_code")
  upd     DateTime @updatedAt
  events  Ev[]
  @@unique([n, code])
  @@map("jobs")
}
model Ev {
  a String
  b String
  job   Job    @relation(fields: [a], references: [id])
  @@id([a, b])
}
enum Kind {
  A
  @@map("job_kind")
}"""
    cols, uq, pk = field_specs(spec_txt)
    J = lambda c: cols[f'column:jobs.{c}']
    assert (J('id')['pg'], J('id')['notnull'], J('id')['default']) == ('text', True, 'prisma')
    assert (J('n')['pg'], J('n')['default']) == ('integer', 'db')
    assert J('d')['pg'] == 'date' and J('v')['pg'] == 'character varying(64)' and J('v')['notnull'] is False
    assert J('tags')['pg'] == 'text[]' and J('tags')['notnull'] is False, 'scalar list = nullable ใน Postgres'
    assert J('url')['default'] == 'db' and J('kind')['pg'] == 'job_kind' and J('upd')['default'] == 'prisma'
    assert 'column:jobs.events' not in cols and 'column:jobs.job_code' in cols
    assert ('jobs', ('job_code',)) in uq and ('jobs', ('n', 'job_code')) in uq, uq
    assert pk == {'jobs': ('id',), 'Ev': ('a', 'b')}, pk

    # verdict — กฎเดียวของ deploy/rollback (ด้วยการประเมินจำลอง: ยังไม่มีอิมเมจที่มีด่านบนพรอดให้ทดสอบจริง)
    def A(**kw):
        base = dict(target_tag='sha-x', guarded=True, losses=[], empty_drops=[], additions=[], type_changes=[], counts={},
                    current_tag='sha-y', removed=[], blockers=[], enum_in_use={}, is_older=False)
        base.update(kw)
        return base
    new_tbl = ['table:mix_job_events']
    # อิมเมจเก่า (ไม่มีด่าน): มีข้อมูลจะหาย / ชนิดต่างจาก DB = ปฏิเสธ + ต้องยืนยันถ้าจะฝืน
    assert verdict(A(guarded=False, losses=new_tbl), 'rollback')[:3:2] == (False, True)
    assert verdict(A(guarded=False, type_changes=['column:J.n: text → integer']), 'rollback')[:3:2] == (False, True)
    assert verdict(A(guarded=False, empty_drops=new_tbl), 'rollback')[0] is True, 'ลบของว่าง = ไม่มีข้อมูลเสีย'
    assert verdict(A(guarded=False, losses=new_tbl), 'deploy', new_tbl)[0] is False, 'opt-in ไม่มีผลกับอิมเมจที่ไม่มีด่าน'
    # ทำไม่ได้ (NULL ขัด NOT NULL · คอลัมน์บังคับบนตารางมีแถว · unique ซ้ำ · ค่า enum ใช้อยู่) = ปฏิเสธ ฝืนไม่ได้ ทุกอิมเมจ
    for g in (True, False):
        for mode in ('rollback', 'deploy'):
            assert verdict(A(guarded=g, blockers=['x NOT NULL แต่มี NULL']), mode)[:3:2] == (False, False), (g, mode)
    assert verdict(A(guarded=False, losses=['enumvalue:K.B'], enum_in_use={'enumvalue:K.B': 3}), 'rollback')[:3:2] == (False, False)
    assert verdict(A(losses=['enumvalue:K.B'], enum_in_use={'enumvalue:K.B': 3}), 'rollback')[0] is True, 'มีด่าน+ถอย = ข้าม ไม่ลบค่า'
    assert verdict(A(losses=['enumvalue:K.B'], enum_in_use={'enumvalue:K.B': 3}), 'deploy', ['enumvalue:K.B'])[:3:2] == (False, False)
    # อิมเมจมีด่าน: ชนิด/PK ต่างจาก DB = ปฏิเสธ ฝืนไม่ได้ (ด่านข้ามทั้งก้อน / Prisma ปฏิเสธ)
    for mode in ('rollback', 'deploy'):
        assert verdict(A(type_changes=['column:J.n: text → integer']), mode)[:3:2] == (False, False), mode
    # อิมเมจมีด่าน · ถอย: ของจะหาย = ด่านเก็บไว้ (ok + คาดว่า skipped) · ต้องทั้งลบและเพิ่ม = ปฏิเสธ ฝืนไม่ได้
    assert verdict(A(losses=new_tbl), 'rollback')[0::3] == (True, True)
    assert verdict(A(losses=new_tbl, additions=['column:bookings.legacy']), 'rollback')[:3:2] == (False, False)
    assert verdict(A(additions=['column:bookings.legacy']), 'rollback')[0] is True
    # อิมเมจมีด่าน · deploy: ไม่มีใน opt-in = ปฏิเสธ · ครบ = ok แต่ต้องยืนยัน · ไม่มีอะไรหาย = ผ่าน · เป้าเก่ากว่า = บอกให้ใช้ rollback.py
    assert verdict(A(losses=new_tbl + ['column:t.c']), 'deploy', new_tbl)[0] is False
    ok, _, conf, skip = verdict(A(losses=new_tbl), 'deploy', new_tbl)
    assert (ok, conf, skip) == (True, True, False)
    assert verdict(A(additions=['table:new']), 'deploy')[:3:2] == (True, False)
    older = verdict(A(losses=new_tbl, is_older=True), 'deploy')
    assert older[0] is False and any('rollback.py' in l for l in older[1]) and not any('--set SCHEMA_ACCEPT' in l for l in older[1])
    print('schema_diff selftest OK')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        _selftest(); sys.exit(0)
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    a, b = resolve(sys.argv[1]), resolve(sys.argv[2])
    gone = removals(schema_at(a), schema_at(b))
    print(f'{a[:7]} → {b[:7]}: ' + ('ไม่มีอะไรหาย' if not gone else f'จะหาย {len(gone)} รายการ'))
    for g in gone:
        print('  -', g)
    print(f'  อิมเมจปลายทางมีด่านตอน boot: {"ใช่" if has_boot_guard(b) else "ไม่มี (push แบบยอมลบทุก boot)"}')
