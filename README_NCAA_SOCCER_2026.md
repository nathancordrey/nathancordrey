# NCAA men's soccer — daily picks (2026)

This update is isolated to a **new competition and private pool**. The existing
World Cup pool and its matches remain as they are. Players make individual game
score picks and compete for daily and overall standings, not full brackets.

## Setup on Linode after review / merge into master

First pull master, then run the migration **before restarting** predictions:

```bash
cd /home/nathan/code/nathancordrey
git pull --ff-only origin master

# Use the existing production database connection; specify login as usual.
PGPASSWORD="<your database password>" psql -h 127.0.0.1 -U worldcup_user -d worldcup_db \
  -f sql/003_ncaa_tiebreak_winner.sql

# Use the same DATABASE_URL environment variable as predictions.service:
# If it is not already exported in the shell, export it first.
python -m predictions.seed_ncaa_mens_soccer_2026

sudo systemctl restart predictions
sudo journalctl -u predictions -n 80 --no-pager
```

Use the same virtualenv Python as the service if the default `python` does not
have the Flask dependencies.

Pool URL: `/predictions/pools/ncaa-soccer-2026`.
Only Nate is a member initially. The pool is private; invite existing accounts
through the link at `/predictions/my-pools`.

## Rules

- First-round fixtures are available to pick immediately, locking at kickoff.
- Score predictions work like the World Cup (1 correct winner + 2 exact-score bonus).
- For a tied NCAA knockout score, users also select who advances on penalty kicks.
- Enter final score plus advancing team on the NCAA admin results page.
- Daily winner indicator, round awards, cumulative NCAA total.
- World Cup wager/dollar ledger **not** applied to NCAA by default.
- Later rounds are not auto-generated; add fixtures after real winners and times
  become known, so nobody can pick an imaginary pairing.

## Sources checked Nov. 17, 2026

- [Official NCAA championship announcement](https://www.ncaa.com/news/soccer-men/article/2026-11-16/2026-ncaa-division-i-mens-soccer-championship-bracket-announced)
- [NCAA championship schedule](https://www.ncaa.com/news/soccer-men/article/2026-11-09/2026-di-mens-soccer-championship-bracket-schedule-scores)
- [First-round slate](https://tvlok.com/guide/league/college-soccer)
- [Tournament broadcasts](https://www.sportsmediawatch.com/tv-schedules/college-sports/college-soccer-tv-schedule/)

First-round kickoff times are subject to change. Check the host schools before play.
