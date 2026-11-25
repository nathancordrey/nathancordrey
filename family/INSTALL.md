# Family album on nathancordrey.com — Linode install plan

**Status:** Deployment runbook for the public GitHub \`family\` development branch. The hosted branch is \`master\`. **Do not merge or expose family content until all acceptance gates are checked.** Draft PR: https://github.com/nathancordrey/nathancordrey/pull/4

## Target

- \`https://nathancordrey.com/family/\`: individual sign-in for Nathan and Rachel, Revision 1 (18 spreads) and Revision 2 (20 spreads), authenticated PDFs and images.
- \`https://nathancordrey.com/family/sharing\`: publisher-only approval, private snapshot preview, link creation/revocation.
- \`https://nathancordrey.com/album/<token>\`: guest read-only snapshot, optional PIN, expiry, revocation. No archive/original access.
- Family binary assets live **outside Git and public static paths** under \`/srv/family-album\`.
- The existing \`/art\` password remains in place during this rollout. Shared-account migration for Art is a **separate subsequent release**.

## Gate 0 — Inspect the live server and create rollback material

**Do not assume the service unit, venv path, user, or web configuration.** Connect over SSH, then discover and record:

\`\`\`bash
cd /PATH/TO/LIVE/NATHANCORDREY                  # verify actual checkout
git branch --show-current                       # must say master
git rev-parse HEAD                               # record rollback SHA
git status --short                               # investigate unexpected modifications
systemctl list-units --type=service | grep -Ei 'gunicorn|nathan'
ps -eo user,group,args | grep -E '[g]unicorn|[n]ginx: worker'
sudo nginx -T | grep -nE 'server_name|location |proxy_pass|access_log'
\`\`\`

Locate the Gunicorn unit and its \`ExecStart\` / \`User\` / \`Group\`, Python venv, Nginx TLS server block, existing environment settings, and any other reverse-proxy logging. **Do not paste secret-bearing environment output into chat.**

Back up the Nginx site configuration, record the master SHA, and verify existing site/app backups. Protect backup files with root-only permissions. Test existing routes (\`/\`, \`/art/\`, \`/recipes\`, \`/predictions\`) before changes.

**Gate:** identifiable rollback commit/config; cleanly understood existing deployment.

## Gate 1 — Test the branch without changing the live checkout

Use a separate checkout/worktree, not \`git checkout family\` in the live checkout:

\`\`\`bash
cd /PATH/TO/LIVE/NATHANCORDREY
git fetch origin family
git worktree add --detach /PATH/TO/SEPARATE/STAGING-CHECKOUT origin/family
cd /PATH/TO/SEPARATE/STAGING-CHECKOUT
/PATH/TO/EXISTING/VENV/bin/python -m pip show Flask-Login Pillow
/PATH/TO/EXISTING/VENV/bin/python -m unittest discover -s family/tests -v
\`\`\`

Install Flask-Login in an **isolated staging environment first** if missing. Do not upgrade the whole production Flask stack blindly. CI currently exercises Python 3.11 with modern Flask, Flask-Login, Pillow; the existing app's third-party imports must also work in the actual production venv.

If testing via HTTP, bind a separate Gunicorn to loopback only and use a non-public staging Nginx listener/config. Use dummy photos and a staging database first; never expose the staging environment publicly or make it share the live application's writable World Cup/art data.

**Gate:** tests pass with the actual dependencies and the existing site still functions.

## Gate 2 — Secure private filesystem layout

Determine:

- \`APP_USER\`: the dedicated Unix user running Gunicorn.
- \`NGINX_GROUP\`: the group of Nginx worker processes (typically \`www-data\` on Ubuntu; **verify**).
- If Gunicorn and Nginx run as the **same Unix user**, review and separate permissions before placing the private database on the server.

Use the following commands after defining the two values. For Ubuntu with Nginx group \`www-data\`, substitute the actual application user:

\`\`\`bash
APP_USER=REPLACE_WITH_GUNICORN_USER
NGINX_GROUP=www-data
sudo install -d -o "$APP_USER" -g "$NGINX_GROUP" -m 0710 /srv/family-album
sudo install -d -o "$APP_USER" -g "$NGINX_GROUP" -m 2750 /srv/family-album/revisions
sudo install -d -o "$APP_USER" -g "$NGINX_GROUP" -m 2750 /srv/family-album/published
\`\`\`

The \`0710\` root permits Nginx's group to traverse without listing. The database, later created with mode \`0600\`, is accessible only to the application owner. \`2750\` preserves the Nginx group on created revision/snapshot directories. The Nginx process must not be allowed to read the SQLite database or originals.

**Gate:** verified \`namei -l\` traversal, user/group access, no public directory alias for the private root.

## Gate 3 — Configure environment and create accounts

Add \`FAMILY_DATA_DIR=/srv/family-album\` to the Gunicorn service environment (prefer systemd override or protected EnvironmentFile). Keep the **existing** production \`WORLDCUP_SECRET_KEY\`, because the main Flask app currently uses it as its session-signing key; verify that it is random and at least 32 characters, without printing it. Changing it will invalidate other existing Flask sessions.

Using the **application venv and application user**, initialize SQLite and create accounts. The script expects \`FAMILY_DATA_DIR\` to be set:

\`\`\`bash
# Run from the family worktree, as APP_USER, with FAMILY_DATA_DIR set.
python family/scripts/init_family.py init
python family/scripts/init_family.py set-user nathan "Nathan"
python family/scripts/init_family.py set-user rachel "Rachel"
python family/scripts/init_family.py grant-publisher nathan
python family/scripts/init_family.py grant-publisher rachel
\`\`\`

The \`set-user\` commands prompt for unique passwords of at least 16 characters; no passwords are placed in command history, Git, or this document. Use a password manager. \`init\` is repeatable and creates all current sharing tables.

**Gate:** database exists with mode \`0600\`, accounts can authenticate in the private staging test, unpublished albums are inaccessible.

## Gate 4 — Privately transfer the prepared review assets

Prepared offline artifact: \`Family_Album_Private_Web_Viewer_Assets.zip\` (about 39 MiB). It has exactly 40 files:

\`\`\`text
revision-1/review.pdf
revision-1/spreads/spread-01.jpg ... spread-18.jpg
revision-2/review.pdf
revision-2/spreads/spread-01.jpg ... spread-20.jpg
\`\`\`

Use SSH/SFTP to upload the ZIP from your computer to your private home directory on Linode, then **securely copy it into app-user-owned storage** and extract it into \`/srv/family-album/revisions/\`. Don't put the ZIP in the Git checkout, public \`static/\` tree or \`/var/www\`.

Example once you know \`APP_USER\` and the actual file location:

\`\`\`bash
sudo install -o "$APP_USER" -g "$NGINX_GROUP" -m 0600 "$HOME/Family_Album_Private_Web_Viewer_Assets.zip" /srv/family-album/transfer.zip
sudo -u "$APP_USER" unzip -q /srv/family-album/transfer.zip -d /srv/family-album/revisions/
sudo rm /srv/family-album/transfer.zip
sudo chown -R "$APP_USER:$NGINX_GROUP" /srv/family-album/revisions
sudo find /srv/family-album/revisions -type d -exec chmod 2750 {} +
sudo find /srv/family-album/revisions -type f -exec chmod 0640 {} +
\`\`\`

Confirm exactly 18+20 JPEGs and two PDFs. Verify the PDFs are correct and all JPEGs open; no family originals are needed for this initial reviewer. The publishing feature generates separate downsized EXIF-free snapshots under \`published/\` when explicitly approved.

**Gate:** file ownership, paths and image counts verified; all binaries remain outside Git.

## Gate 5 — Configure Nginx \`internal\` file delivery and link privacy

In the **existing HTTPS server block**, preserving the site's current reverse-proxy rules:

\`\`\`nginx
location ^~ /__family_private__/ {
    internal;
    alias /srv/family-album/revisions/;
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
}
location ^~ /__family_published__/ {
    internal;
    alias /srv/family-album/published/;
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, noimageindex" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
}
\`\`\`

Never expose these aliases without \`internal\`. Ensure \`/family\` and \`/album\` continue to proxy through Flask, *not* to public files.

**Privacy gate:** the first \`/album/<token>\` request contains a bearer secret. Configure the actual access-log topology so it does not record that URL (Nginx, any upstream proxies, analytics/error trackers). A conditional \`access_log ... if=...\` with a \`map $uri\` regex for the token entry route can work; adapt it to the real Nginx config rather than pasting an untested proxy \`location\`. Retain privacy headers on redirect and image responses.

\`\`\`bash
sudo nginx -t
# Only reload after a successful syntax test and backup of the prior config.
sudo systemctl reload nginx
\`\`\`

**Gate:** external \`/__family_private__/...\` and \`/__family_published__/...\` URLs return 404/403; log exclusions are verified by reading Nginx logs.

## Gate 6 — Deployment and end-to-end security verification

After staging passes, merge the reviewed PR into \`master\`, pull \`master\` with \`--ff-only\` on the live server, ensure Flask-Login exists in the **actual service venv**, set \`FAMILY_DATA_DIR\`, then restart **only** the identified Gunicorn service. Verify the other website sections and access tests.

From a logged-out/incognito browser:

- \`/family/\` should redirect to the login page.
- Private \`/family/revisions/2/pdf\` and \`/family/revisions/2/spreads/1\` should not deliver images/PDF.
- Direct Nginx \`/__family_private__/revision-2/review.pdf\` must be blocked.
- Direct \`/__family_published__/...\` must be blocked.
- \`/album/view/<share-id>\` without an established share session must fail.
- Unexpected file names/revisions or missing storage must fail closed.

From each named account:

- Login; navigate Revision 1 (18 spreads) and Revision 2 (20 spreads), open their review PDFs.
- Logout; verify that the same URLs stop working, including in a fresh/incognito session.
- Confirm only publisher-granted users can open \`/family/sharing\`.
- Publish **one non-sensitive test spread** with explicit approval; inspect the *private snapshot preview* before link creation.
- Create a **short-expiry, PIN-protected** share link; test good/wrong PINs, then test revoked link and unpublish. Check that a prior guest session can no longer fetch an image after revocation. Inspect access logs for token leakage.
- Confirm generated images have no EXIF/GPS and no link exposes originals or the full PDF.

**Operational note:** snapshot generation currently runs inside the Gunicorn request and may hit worker timeouts for very large selections. Start with one spread; a background job queue should be introduced before heavy bulk publication.

**Gate:** all browser, Nginx and proxy tests pass before sending any real guest link.

## Gate 7 — Backups, rollback and follow-up

- Add \`family.sqlite3\`, \`revisions/\`, and \`published/\` to a protected **off-server backup**; test restoration. Never back up the database via a naive file copy during active writes—use SQLite's online backup API or a consistent snapshot.
- Record the pre-deployment \`master\` commit, the deployed commit and the prior Nginx config. If the release fails, restore prior code/config and restart the old service. **Do not delete** the private data directory.
- Leave \`/art\` on its original password until a separate shared-login migration preserves notebook data and verifies uploads/exports.
- Later: upload/edit photos, collaborative feedback, finer-grained publishing, guest access preferences, and background image tasks.

## Go / no-go rule

**No merge or public sharing** until code tests, service-user permissions, internal Nginx aliases, token-log privacy, logout/revocation, and off-server backup/restore checks have all passed.

At writing: automated GitHub tests were green (11/11); **real Linode configuration and live access-control tests have not been verified**.
