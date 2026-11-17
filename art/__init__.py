"""Private family notebook. Runtime data must live outside the checkout."""
import io
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
import uuid
import zipfile
from contextlib import contextmanager
from flask import Blueprint, abort, current_app, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.security import check_password_hash

art = Blueprint('art', __name__, url_prefix='/art', template_folder='templates')
KEYS = ('sessions', 'profiles', 'prompts', 'journal', 'plans', 'materials', 'artworks', 'trash')


def root():
    p = Path(os.environ['ART_DATA_DIR']).resolve()
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    (p / 'uploads').mkdir(mode=0o700, exist_ok=True)
    return p


@contextmanager
def database():
    db = sqlite3.connect(root() / 'notebook.sqlite3', timeout=15)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS notebook (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, extension TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, start REAL NOT NULL)')
        db.commit()
        yield db
    finally:
        db.close()


@art.before_request
def guard():
    if not os.environ.get('ART_DATA_DIR') or not os.environ.get('ART_PASSWORD_HASH') or not current_app.secret_key or current_app.secret_key == 'dev-only-change-me':
        return 'Art Table needs ART_DATA_DIR, ART_PASSWORD_HASH and a secure Flask secret configured.', 503
    if request.content_length and request.content_length > 22 * 1024 * 1024:
        abort(413)
    if request.endpoint != 'art.login' and not session.get('art_login'):
        if request.path.startswith('/art/api/'):
            return jsonify(error='Please sign in again. Your draft is still on this device.'), 401
        return redirect(url_for('art.login'))
    if request.method in ('POST', 'PUT', 'DELETE'):
        token = request.headers.get('X-CSRF-Token') or request.form.get('csrf')
        if not token or not secrets.compare_digest(token, session.get('art_csrf', '')):
            abort(403)


@art.after_request
def private(response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    return response


@art.route('/login', methods=['GET', 'POST'])
def login():
    session.setdefault('art_csrf', secrets.token_urlsafe(32))
    error = ''
    if request.method == 'POST':
        with database() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT count,start FROM attempts WHERE id=1').fetchone()
            count, start = row if row and time.time() - row[1] < 300 else (0, time.time())
            if count >= 15:
                db.rollback()
                return render_template('art_login.html', error='Please wait five minutes before trying again.'), 429
            if check_password_hash(os.environ['ART_PASSWORD_HASH'], request.form.get('password', '')):
                db.execute('DELETE FROM attempts')
                db.commit()
                session['art_login'] = True
                session['art_csrf'] = secrets.token_urlsafe(32)
                return redirect(url_for('art.index'))
            db.execute('INSERT OR REPLACE INTO attempts VALUES(1,?,?)', (count + 1, start))
            db.commit()
            error = 'That password did not match.'
    return render_template('art_login.html', error=error)


@art.post('/logout')
def logout():
    session.pop('art_login', None)
    session.pop('art_csrf', None)
    return redirect(url_for('art.login'))


@art.get('/')
def index():
    return render_template('art.html')


def validate(body):
    if not isinstance(body, dict) or any(not isinstance(body.get(k), list) for k in KEYS):
        abort(400)
    for key in KEYS:
        if len(body[key]) > 10000:
            abort(400)
        for item in body[key]:
            if not isinstance(item, dict) or any(not isinstance(v, (str, bool, int, float, type(None), dict)) for v in item.values()):
                abort(400)
    if len(json.dumps(body)) > 5 * 1024 * 1024:
        abort(413)


@art.route('/api/notebook', methods=['GET', 'PUT'])
def notebook():
    with database() as db:
        if request.method == 'GET':
            row = db.execute('SELECT revision,body FROM notebook WHERE id=1').fetchone()
            return jsonify(revision=row[0] if row else 0, data=json.loads(row[1]) if row else None)
        payload = request.get_json()
        if not isinstance(payload, dict):
            abort(400)
        body = payload.get('data')
        validate(body)
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT revision FROM notebook WHERE id=1').fetchone()
        revision = row[0] if row else 0
        if payload.get('revision') != revision:
            return jsonify(error='Another device saved changes. Download your draft, then load the shared notebook before editing again.'), 409
        db.execute('INSERT OR REPLACE INTO notebook VALUES(1,?,?)', (revision + 1, json.dumps(body)))
        db.commit()
        return jsonify(revision=revision + 1)


@art.post('/api/photos')
def upload():
    from PIL import Image, ImageOps, UnidentifiedImageError
    import warnings
    f = request.files.get('photo')
    if not f:
        abort(400)
    content = f.read(20 * 1024 * 1024 + 1)
    if len(content) > 20 * 1024 * 1024:
        return jsonify(error='Choose an image under 20 MB.'), 413
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            im = Image.open(io.BytesIO(content))
            if im.format not in ('JPEG', 'PNG', 'WEBP'):
                raise ValueError()
            extension = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}[im.format]
            im.load()
            preview = ImageOps.exif_transpose(im).convert('RGB')
            preview.thumbnail((1400, 1400))
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return jsonify(error='Choose a valid JPEG, PNG, or WebP image. Export HEIC as JPEG first.'), 400
    ident = uuid.uuid4().hex
    folder = root() / 'uploads'
    original = folder / (ident + '.' + extension)
    thumb = folder / (ident + '.preview.jpg')
    try:
        original.write_bytes(content)
        preview.save(thumb, 'JPEG', quality=88)
        with database() as db:
            db.execute('INSERT INTO uploads VALUES(?,?)', (ident, extension))
            db.commit()
    except Exception:
        original.unlink(missing_ok=True)
        thumb.unlink(missing_ok=True)
        raise
    return jsonify(id=ident)


@art.get('/photo/<ident>/<kind>')
def photo(ident, kind):
    with database() as db:
        row = db.execute('SELECT extension FROM uploads WHERE id=?', (ident,)).fetchone()
    if not row or kind not in ('original', 'preview'):
        abort(404)
    return send_file(root() / 'uploads' / (ident + ('.preview.jpg' if kind == 'preview' else '.' + row[0])), as_attachment=kind == 'original')


def make_backup(destination):
    """SQLite online backup plus immutable photos; safe while the app is running."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        snapshot = Path(tmp) / 'notebook.sqlite3'
        with database() as db, sqlite3.connect(snapshot) as target:
            db.backup(target)
            photos = target.execute('SELECT id,extension FROM uploads').fetchall()
            row = target.execute('SELECT body FROM notebook WHERE id=1').fetchone()
        with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, 'notebook.sqlite3')
            archive.writestr('notebook.json', row[0] if row else '{}')
            for ident, extension in photos:
                for name in (ident + '.' + extension, ident + '.preview.jpg'):
                    archive.write(root() / 'uploads' / name, 'uploads/' + name)


@art.get('/export')
def export():
    import tempfile
    f = tempfile.TemporaryFile()
    make_backup(f)
    f.seek(0)
    response = send_file(f, mimetype='application/zip', as_attachment=True, download_name='art-table-backup.zip')
    response.call_on_close(f.close)
    return response
