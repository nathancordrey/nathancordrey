# Family album — Release 1: private review viewer

This branch is development-only and based on the live master branch. Do not merge/deploy until all access tests pass.

## First release
- Dedicated Flask-Login named accounts (no registration), rate-limited sign-in, CSRF for login/logout.
- Private revision dashboard, 18-spread Revision 1 and 20-spread Revision 2 viewer.
- Authenticated image/PDF routes using X-Accel-Redirect. No images or PDF binaries in public Git.
- No uploads, editing, comments or public shared links yet.

## Environment and account creation (Linode)
1. Confirm the live Python environment has flask-login installed; add it to the deployed dependency manifest.
2. Confirm master remains the branch deployed from Linode.
3. Set FAMILY_DATA_DIR=/srv/family-album in the Gunicorn service environment. Keep the path outside the Git checkout and Nginx web root.
4. Use a strong production Flask secret at least 32 characters. Existing app reads WORLDCUP_SECRET_KEY; it currently has a dev fallback, which the family blueprint explicitly refuses.
5. Create /srv/family-album/revisions/revision-1/spreads and revision-2/spreads with restricted permissions.
6. Run python family/scripts/init_family.py init; then python family/scripts/init_family.py set-user nathan Nathan and set-user rachel Rachel. Password prompts are interactive (16+ characters). Never paste passwords into commands or Git.
7. Privately transfer each revision's review.pdf into revisions/revision-1/ and revisions/revision-2/. Optionally populate spread-01.jpg through spread-18.jpg (Rev 1), through spread-20.jpg (Rev 2).
8. Give Gunicorn access to SQLite and approved files; give the Nginx process read-only access to the revisions subdirectory, not to SQLite or originals.
9. Back up the database and review files off-server.

## Nginx HTTPS server configuration
Only the following internal location grants Nginx access to authorized files. NEVER remove internal.
```nginx
location ^~ /__family_private__/ {
    internal;
    alias /srv/family-album/revisions/;
    add_header Cache-Control "private, no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```
Make sure /family requests still pass to Gunicorn; check for conflicting static aliases. Test with sudo nginx -t, then reload only after validation.

## Security release checklist
- Anonymous /family/ redirects to login.
- Anonymous private PDF and spread routes do not return X-Accel-Redirect.
- Direct /__family_private__/revision-2/review.pdf is rejected by Nginx (not publicly served).
- Authenticated users can retrieve approved assets, but cannot access arbitrary filenames.
- Logout immediately invalidates session access.
- Login and logout require CSRF, bad logins are throttled.
- Missing FAMILY_DATA_DIR, DB or production secret fails with 503.
- No private images, previews, SQLite files, passwords or PDFs in the public repository or public static path.
- Off-server backups tested; no public staging with real personal photos.

## Notes
The existing art blueprint has its own separate shared password; this viewer does not reuse it. Existing Flask sessions use WORLDCUP_SECRET_KEY, so changing it requires planning.
Print masters stay offline for now. First release uploads only reduced-size review assets securely through SSH/SFTP.
## Semi-public read-only sharing (developed on family, NOT live)

The /family/sharing page is restricted to publisher accounts. After the offline
account setup, grant each publisher permission explicitly:

    python family/scripts/init_family.py grant-publisher nathan
    python family/scripts/init_family.py grant-publisher rachel

Run the init command again during upgrades; it creates new sharing tables
idempotently without deleting existing accounts.

1. Sign in to /family and navigate to Sharing settings.
2. Choose a revision and type the *specific spread numbers* approved for sharing.
   Explicitly check the approval box; publishing copies only the selected spreads.
3. Open the publisher-only snapshot preview; verify every selected spread before
   issuing a link.
4. Create a share link, optionally protected by a PIN, with 7-, 30-, 90-day, or
   no expiration. Only the hash of the link secret is saved in SQLite. The actual
   link is shown once; keep it in a private channel.
5. A recipient follows the secret link at /album/<token> (and enters the PIN if
   configured). The token is exchanged for a private session and redirected to
   tokenless /album/view/<id> URLs. All image requests recheck revocation/expiry.
6. Revoking an individual link stops all future page/image reads immediately.
   Unpublishing a snapshot disables all links for that snapshot.

This is a read-only *snapshot* feature; editing the source draft does not alter
the published images. Images are resized and re-encoded as JPEG without EXIF,
GPS, or attached original file metadata.

Guests never access the private archive, original uploads, draft PDFs, editor
data or login pages through share links. Share links can be forwarded and
screenshots cannot be prevented; keep the PIN option for more sensitive shares.

The Flask app must register BOTH blueprints. /family is private management;
/album is the guest read-only viewer. Do not redirect /album to a static
directory or Nginx public alias.

### Additional internal Nginx location

Inside the EXISTING TLS server block, add:

```nginx
location ^~ /__family_published__/ {
    internal;
    alias /srv/family-album/published/;
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, noimageindex" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```

This path must only be readable through a backend-authorized
X-Accel-Redirect. Do **not** remove the internal directive. Never add a public
alias serving /srv/family-album, and never serve SQLite or originals this way.
Grant Nginx read/traverse access only to /srv/family-album/revisions and
/srv/family-album/published as necessary, not the database. Make sure the
Gunicorn worker can create and rename snapshot files in published/. Configure
ACLs or group permissions intentionally; a root directory set to 0700 without
the proper ACL will block Nginx internal delivery.

The /album/<token> path contains a bearer secret. Exclude these token-bearing
URLs from HTTP access logs (including reverse proxies, analytics and error
trackers), avoid referrer leakage, and keep link screenshots private. Other
album URLs have no bearer token. Consider request throttling on the
token-entry and guest PIN endpoints as a further defense. Avoid collecting
or exposing submitted PIN values.

Run nginx -t and reload only after validation. Run the test suite in the
actual deployed virtualenv BEFORE exposing private photos:

    python -m unittest discover -s family/tests -v

### Sharing-specific acceptance tests
- [ ] Unauthorized user (including a valid non-publisher account) cannot publish.
- [ ] A snapshot cannot be created without explicit approval and CSRF.
- [ ] Publisher preview requires authentication.
- [ ] Direct /__family_published__/... request is blocked.
- [ ] Tokenless /album/view/... without the granted session fails.
- [ ] Correct PIN grants access; wrong PIN fails and throttles.
- [ ] Link with no PIN still requires a secret to grant the viewing session.
- [ ] Expired, revoked, or unpublished shares reject all subsequent image requests.
- [ ] Public JPEG copies contain no EXIF/GPS.
- [ ] Printed or original photo PDFs remain private and are never shared.

### Not yet implemented
The existing /art blueprint still uses its older shared password. A migration
to the shared personal-account system is planned but is not included in this
sharing change. Do not remove ART_PASSWORD_HASH or alter /art access before its
separate migration has been validated. Publication currently approves a set of
*whole spreads*, not individual images within a spread. A later editor can
introduce more fine-grained selections without changing the snapshot principle.

## Preparing the initial two revision asset sets

A reproducible offline exporter lives at family/scripts/export_spreads.py.
From a trusted local computer, with PyMuPDF and Pillow installed:

    python family/scripts/export_spreads.py --revision 1 --input /private/revision1.pdf --output-root /private/transfer
    python family/scripts/export_spreads.py --revision 2 --input /private/revision2.pdf --output-root /private/transfer

Each generated 3200px-wide JPEG is a two-page facing spread rendered from the
corresponding review PDF. The script refuses to overwrite nonempty spread
directories and checks output JPEGs for EXIF. Do not regenerate or modify the
source photographs.

Copy revision1.pdf to /private/transfer/revision-1/review.pdf and revision2.pdf
to /private/transfer/revision-2/review.pdf. The ready-made package created in
the development conversation contains this exact folder layout:

    revision-1/review.pdf
    revision-1/spreads/spread-01.jpg ... spread-18.jpg
    revision-2/review.pdf
    revision-2/spreads/spread-01.jpg ... spread-20.jpg

Upload over SSH/SFTP into /srv/family-album/revisions. Do NOT add this transfer
package to the public Git repository or site static directory. Verify file
permissions and use a private off-server backup.

The guest-sharing tool creates derived web copies under the separate
/srv/family-album/published directory; only explicitly selected and approved
spreads can be published. Guest share links must never point at source review
PDFs or the private original photographs.

## Private spread discussions (Nathan + Rachel only)

The authenticated revision viewer now shows an editor-only **Private layout notes**
section below each spread, with new discussions, replies, open counts, and
resolve/reopen controls. Discussions are scoped to a **revision and spread**;
they do not move or become public when a new revision is published. There are
no editor notes in the /album guest blueprint, shared snapshot files, or PDFs.

No separate registration, passwords or new storage directory is required.
Only accounts already granted the `family_publishers` role can read/write
these discussions. Other signed-in family accounts cannot see the notes.
All write routes require CSRF and comments are length-limited and escaped
in HTML.

**Mandatory upgrade order on existing Linode:**

```bash
cd /home/nathan/code/nathancordrey
git pull --ff-only origin family
export FAMILY_DATA_DIR=/srv/family-album
python family/scripts/init_family.py init
python -m unittest discover -s family/tests -v
sudo systemctl restart nathancordrey
```

The `init` command adds the `family_comments` table and indexes with
CREATE TABLE IF NOT EXISTS and preserves existing family accounts, album
snapshots, and links. **Run `init` before restarting Gunicorn.** The live
service already has `FAMILY_DATA_DIR` in its systemd override, but your
interactive shell may not have it exported in a new SSH session.

The comment data lives in `/srv/family-album/family.sqlite3`, covered by
the same private SQLite backup routine. Do not add this DB to GitHub.
