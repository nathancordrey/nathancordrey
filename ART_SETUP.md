# The Art Table — /art/

A private Flask blueprint with a shared SQLite notebook, editable invitations, artist paths, plans, observations, materials, and a photo gallery. Original uploads are immutable; rotation affects display only. Deleted entries remain recoverable in Recently removed. Export includes JSON, the database, originals and previews.

## Install on Linode

1. Pull `master` in the existing nathancordrey checkout.
2. Activate the site's existing Python virtual environment and run `pip install -r requirements-art.txt`.
3. Create a persistent directory **outside the repository and outside any Nginx static alias**, owned by the Gunicorn service user, mode 700. For example `/var/lib/nathancordrey-art`.
4. Set these in the existing `.env` (which nathancordrey.py loads) or service environment:

```
ART_DATA_DIR=/var/lib/nathancordrey-art
ART_PASSWORD_HASH=the-generated-hash
WORLDCUP_SECRET_KEY=your-existing-strong-Flask-secret
```

Keep your existing strong secret if already configured. The art module refuses access with the development fallback. Generate the password hash interactively inside the virtual environment, without putting the password in shell history:

```
python -c 'from getpass import getpass; from werkzeug.security import generate_password_hash; print(generate_password_hash(getpass("Family password: ")))'
```

Store the generated hash exactly as printed. In a dotenv file, single-quote its value. Do not commit secrets.

5. In the site's Nginx server block set `client_max_body_size 22m;` to accommodate phone pictures (each image limit is 20 MB). Validate Nginx configuration before reloading it.
6. Restart the existing Gunicorn service and visit `/art/` over HTTPS. The original site continues to operate if art is not configured; `/art/` reports setup is required.
7. Verify from a second browser/device that changes appear after loading the shared notebook, then upload a test picture and export a backup.

There is no new server, port, or deployment service. Do not serve the upload folder directly through Nginx: Flask protects each image request. Password attempts are limited to 15 per five-minute window across the family login.

## Everyday use

Sessions are reusable templates. A saved plan copies the invitation and adaptations so future template edits do not rewrite it. Plans can stay open, continue, finish, or be set aside. Artwork may link to a plan or stand alone, and multiple files create individual pieces with shared initial details. Edit each caption afterward.

JPEG, PNG and WebP uploads are supported. Export HEIC to JPEG first. Uploaded originals remain untouched; previews are oriented and resized for the gallery. Image location metadata is not copied to previews, but remains in original downloads.

Saving shows status in the sidebar. A network error keeps a local draft; use Retry saving after reconnecting. Conflicting device edits stop saving rather than overwrite the newer notebook. Download the local draft, load the shared version, and reapply the intended changes. Import notebook merges legacy JSON entries into the shared notebook; it does not upload image files or restore a complete server backup. Legacy exports with no IDs may need manual duplicate cleanup after repeated imports.

Unfinished form text is stored separately on the device; Recover unfinished text opens it as a new entry for review. Do not rely on this for unsaved image selections. Sign-out protects server access; local drafts remain in that browser, so use trusted family devices.

## Backup and restore

The sidebar export is a complete ZIP backup. For scheduled server backups, run from the checkout with the same virtual environment and ART_DATA_DIR:

```
python -m art.backup /secure/backup/location/art-table-YYYY-MM-DD.zip
```

Schedule daily using your existing backup system, retain historical copies, and copy them off the Linode. This repository does not install a cron job automatically. SQLite's backup API creates a consistent snapshot; immutable photo files listed in that snapshot are included. Keep backup destinations private.

To restore: stop the website service; preserve the existing data directory; extract a **trusted Art Table backup** into a new empty persistent directory; set ownership to the service user and private permissions; point ART_DATA_DIR to it; restart; verify the journal and original photo download. The ZIP contains notebook.sqlite3 and uploads/ at its root, plus readable notebook.json. Avoid extracting user-supplied archives into the live folder.

Backups and uploaded photos are never committed to Git. Removing an artwork entry is reversible and does not reclaim disk space. Monitor the data directory and available disk space through your existing server monitoring.

## Verification

```
PYTHONPATH=. python -m unittest discover -s tests -p test_art.py -v
node --check static/art/app.js
node --check static/art/shared.js
```

Tests cover unauthorized access, CSRF rejection, successful page render, optimistic save conflicts, invalid notebook data, image validation, original retention, preview serving, and restoration of a backup's database and photograph. Browser and phone verification is still required on the deployed host.
