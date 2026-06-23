from flask import (Flask, render_template, request, redirect, url_for,
                   session, flash, abort)
from flask_flatpages import FlatPages
from functools import wraps
import os
import json
import tempfile
from datetime import date
from collections import OrderedDict

# Load secrets from a .env file sitting next to this file (works no matter what
# working directory gunicorn/systemd launches from). Guarded so the site still
# runs if python-dotenv isn't installed — but you need it for the .env to load.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
except ImportError:
    pass

app = Flask(__name__)
app.config.from_object(__name__)
#Initialize flatpages
app.config['FLATPAGES_EXTENSION'] = '.md'
pages = FlatPages(app)
recipes=[]

# Resolve the worldcup data path relative to this file, so it works regardless
# of what working directory gunicorn/systemd launches the app from on Linode.
_WORLDCUP_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'worldcup.json')

# Secrets come from environment variables (keep them out of git).
#   WORLDCUP_SECRET_KEY  – signs the admin session cookie
#   WORLDCUP_ADMIN_PW    – the single shared admin password you type on your phone
app.secret_key = os.environ.get('WORLDCUP_SECRET_KEY', 'dev-only-change-me')
_ADMIN_PW = os.environ.get('WORLDCUP_ADMIN_PW')
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=True,      # requires HTTPS (you have it)
)


def _load_worldcup():
    with open(_WORLDCUP_JSON) as f:
        return json.load(f)


def _save_worldcup(data):
    """Write the JSON atomically so a crash mid-write can't corrupt the file."""
    folder = os.path.dirname(_WORLDCUP_JSON)
    fd, tmp = tempfile.mkstemp(dir=folder, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write('\n')
        os.replace(tmp, _WORLDCUP_JSON)   # atomic on the same filesystem
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get('wc_admin'):
            return redirect(url_for('worldcup_admin_login'))
        return view(*args, **kwargs)
    return wrapped

@app.route('/')
def index():
    page = pages.get_or_404('index')
    return render_template('page.html', page=page)
@app.route('/recipes')
def recipes():
    recipes = (p for p in pages if 'date' in p.meta and p.path[:6]=='recipe')
    latest = sorted(recipes, reverse=True, key=lambda p: p.meta['date'])
    categories = []
    blank=[]
    for r in pages:
        if r.path[:6]!='recipe':
            print('hello')
        elif r.meta['category'] in categories:
            print('hello')
        elif r.meta['category'] == None:
            print('hello')
        else:
            categories.append(r.meta['category'])
    return render_template('recipes.html', recipes=latest, categories=categories, blank=blank)
@app.route('/travel')
def travel():
    trips = (p for p in pages if 'date' in p.meta and p.path[:6]=='travel')
    latest = sorted(trips, reverse=True, key=lambda p: p.meta['date'])
    categories = []
    for t in pages:
        print(t.path)
        if t.path[:6] != 'travel':
            print('hello')
        elif t.meta['category'] in categories:
            print('hello')
        elif t.meta['category'] == None:
            print('hello')
        else:
            categories.append(t.meta['category'])
    return render_template('travel.html', trips=latest, categories=categories)
@app.route('/misc')
@app.route('/misc')
def misc():
    misc_pages = [p for p in pages if p.path.startswith('misc/')]
    latest = sorted(
        misc_pages,
        reverse=True,
        key=lambda p: p.meta.get('date', '')
    )
    return render_template('misc.html', misc_pages=latest)

'''
@app.route('/worldcup')
def worldcup():
    data = _load_worldcup()

    scoring = data.get('scoring', {'correct_winner': 1, 'exact_score_bonus': 2})
    friends = data['friends']

    # Only surface a game once its match day has arrived. Future fixtures live in
    # the data but stay hidden until 4am US Eastern on game day, so the board isn't
    # a wall of upcoming matches and picks open that morning. The 8h offset = 4 for
    # EDT (UTC-4, the offset all tournament) + 4 to roll the date over at 4am rather
    # than midnight. A fixed offset avoids a timezone-data dependency.
    import datetime as _dt
    _today_et = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=8)).date().isoformat()
    games = [g for g in data['games'] if (g.get('date') or '') <= _today_et]
    data['games'] = games   # keep the header's match count in sync with what's shown

    # Initialize per-friend score totals (by_stage holds points earned in each stage)
    scores = {f: {'total': 0, 'correct_winner': 0, 'exact_score': 0, 'by_stage': {}}
              for f in friends}

    # Process each game: determine actual winner, score predictions
    for game in games:
        stage = game.get('stage', 'Other')
        result = game.get('result')
        game['result'] = result          # normalize: ensures key always exists (None if unplayed)
        game['actual_winner'] = None
        game['friend_results'] = {}

        if result is not None:
            hs = result['home_score']
            aws = result['away_score']

            if hs > aws:
                game['actual_winner'] = 'home'
            elif hs < aws:
                game['actual_winner'] = 'away'
            else:
                game['actual_winner'] = 'draw'

            for friend in friends:
                pred = game['predictions'].get(friend, {})
                pts = 0
                winner_correct = False
                exact = False

                if pred.get('winner') == game['actual_winner']:
                    winner_correct = True
                    pts += scoring['correct_winner']
                    if (pred.get('home_score') == hs and
                            pred.get('away_score') == aws):
                        exact = True
                        pts += scoring['exact_score_bonus']

                scores[friend]['total'] += pts
                scores[friend]['correct_winner'] += int(winner_correct)
                scores[friend]['exact_score'] += int(exact)
                sb = scores[friend]['by_stage'].setdefault(
                    stage, {'points': 0, 'winners': 0, 'exact': 0})
                sb['points'] += pts
                sb['winners'] += int(winner_correct)
                sb['exact'] += int(exact)
                game['friend_results'][friend] = {
                    'winner_correct': winner_correct,
                    'exact_score': exact,
                    'points': pts,
                    'pred': pred
                }

    _MD1 = 'Group Stage: Matchday 1'

    def md_points(f, stage):
        return scores[f]['by_stage'].get(stage, {}).get('points', 0)

    # ── Matchday 1 awards: trophies for the top 3. ──
    # Only awarded once Matchday 1 has actually been played.
    awards = {}
    md1_played = any(g.get('result') is not None and g.get('stage') == _MD1
                     for g in games)
    if md1_played:
        ranked = sorted(friends,
                        key=lambda f: (md_points(f, _MD1), scores[f]['exact_score']),
                        reverse=True)
        for medal, f in zip(('🥇', '🥈', '🥉'), ranked[:3]):
            awards[f] = medal

    # Canonical tournament order for stage sections. Stages not listed here
    # (e.g. a typo or custom label) fall to the end, alphabetically.
    STAGE_ORDER = [
        'Group Stage: Matchday 1',
        'Group Stage: Matchday 2',
        'Group Stage: Matchday 3',
        'Round of 32',
        'Round of 16',
        'Round of 8',
        'Round of 4',
        'Final',
    ]
    STAGE_SHORT = {
        'Group Stage: Matchday 1': 'MD1',
        'Group Stage: Matchday 2': 'MD2',
        'Group Stage: Matchday 3': 'MD3',
        'Round of 32': 'R32',
        'Round of 16': 'R16',
        'Round of 8': 'R8',
        'Round of 4': 'R4',
        'Final': 'F',
    }

    def stage_rank(name):
        return STAGE_ORDER.index(name) if name in STAGE_ORDER else -1

    # Group games by stage.
    stages_dict = {}
    for game in games:
        stages_dict.setdefault(game.get('stage', 'Other'), []).append(game)

    # Stages that exist, in tournament order. The most advanced one is the
    # "active" matchday — it gets the correct/exact breakdown in the table;
    # earlier matchdays are settled and show just their points number.
    present = set(stages_dict.keys())
    ordered = [s for s in STAGE_ORDER if s in present]
    ordered += sorted(present - set(STAGE_ORDER))   # any custom labels last
    active = ordered[-1] if ordered else None
    lb_past = [{'full': s, 'short': STAGE_SHORT.get(s, s)} for s in ordered[:-1]]
    lb_active = ({'full': active, 'short': STAGE_SHORT.get(active, active)}
                 if active else None)

    # Display sections: most recent round on top, newest games first within.
    stages = [
        {'name': name, 'games': sorted(grp, key=lambda g: g.get('date', ''), reverse=True)}
        for name, grp in sorted(stages_dict.items(),
                                key=lambda kv: stage_rank(kv[0]), reverse=True)
    ]

    # Live leaderboard is organized by the active matchday, total as tiebreak.
    def active_points(row):
        return row['by_stage'].get(active, {}).get('points', 0) if active else 0

    leaderboard = sorted(
        [{'name': f, 'award': awards.get(f, ''), **scores[f]} for f in friends],
        key=lambda x: (active_points(x), x['total']),
        reverse=True
    )
    # Gold-highlight the row leading the active matchday (once it has points).
    for i, row in enumerate(leaderboard):
        row['is_leader'] = (i == 0 and active_points(row) > 0)

    # ── Daily wager: shows the most recent day that has results. While today's
    # games are still upcoming it stays on the last settled day (keeping that
    # day's 💰 winner visible); it flips to the new day as soon as that day's
    # first result is in. The 💰 is only awarded once a day is fully complete. ──
    DAILY_WAGER_FROM = '2026-06-19'   # ISO date the daily wager started
    wager_dates = [g.get('date') for g in games
                   if g.get('result') is not None and g.get('date')
                   and g.get('date') >= DAILY_WAGER_FROM]
    daily_label = None
    daily = {f: 0 for f in friends}
    if wager_dates:
        latest_day = max(wager_dates)
        for g in games:
            if g.get('result') is not None and g.get('date') == latest_day:
                for f in friends:
                    fr = g['friend_results'].get(f)
                    if fr:
                        daily[f] += fr['points']
        # The day is "complete" only when every game scheduled that date is in;
        # the 💰 winner is withheld until then (running points still show).
        day_complete = all(g.get('result') is not None
                           for g in games if g.get('date') == latest_day)
        winners = set()
        if day_complete:
            top = max(daily.values())
            winners = {f for f, v in daily.items() if v == top and v > 0}
        for row in leaderboard:
            row['daily'] = daily.get(row['name'], 0)
            row['daily_win'] = row['name'] in winners
        # Short, friendly date label for the column header, e.g. "Jun 19".
        d = date.fromisoformat(latest_day)
        daily_label = '{} {}'.format(d.strftime('%b'), d.day)

    # ── Season wager ledger: every player antes $1 each wager day (so a full
    # field makes a $N pot). The day's top scorer takes the pot; ties split it
    # evenly. A day in progress shows everyone down their $1 ante until it
    # settles. Net running total per player goes in the leftmost "$" column. ──
    WAGER_STAKE = 1
    n_players = len(friends)
    result_dates = [g.get('date') for g in games
                    if g.get('result') is not None and g.get('date')]
    money = {f: 0 for f in friends}
    wager_active = False
    if result_dates:
        last_result_date = max(result_dates)
        # Wager days = dates that have games, from the start through the most
        # recent day with any result (so future, all-upcoming days don't ante).
        wager_days = sorted({g.get('date') for g in games
                             if g.get('date')
                             and DAILY_WAGER_FROM <= g.get('date') <= last_result_date})
        for wd in wager_days:
            day_games = [g for g in games if g.get('date') == wd]
            complete = all(g.get('result') is not None for g in day_games)
            dp = {f: 0 for f in friends}
            for g in day_games:
                if g.get('result') is None:
                    continue
                for f in friends:
                    fr = g['friend_results'].get(f)
                    if fr:
                        dp[f] += fr['points']
            pot = WAGER_STAKE * n_players
            if complete:
                top = max(dp.values())
                day_winners = [f for f in friends if dp[f] == top and top > 0]
                if day_winners:                     # void a day nobody scored on
                    wager_active = True
                    share = pot / len(day_winners)
                    for f in friends:
                        money[f] -= WAGER_STAKE
                        if f in day_winners:
                            money[f] += share
            else:
                # In-progress day: ante is in, pot still on the table.
                wager_active = True
                for f in friends:
                    money[f] -= WAGER_STAKE

    def _fmt_money(v):
        rv = round(v, 2)
        if rv == 0:
            return '$0'
        body = '{:d}'.format(abs(int(rv))) if rv == int(rv) else '{:.2f}'.format(abs(rv))
        return ('+$' if rv > 0 else '\u2212$') + body

    for row in leaderboard:
        row['money'] = round(money.get(row['name'], 0), 2)
        row['money_str'] = _fmt_money(money.get(row['name'], 0))

    return render_template('worldcup.html',
                           data=data,
                           leaderboard=leaderboard,
                           stages=stages,
                           lb_past=lb_past,
                           lb_active=lb_active,
                           daily_label=daily_label,
                           show_money=wager_active,
                           scoring=scoring)

# ───────────────────────── World Cup admin (results entry) ─────────────────────────

@app.route('/worldcup/about')
def worldcup_about():
    data = _load_worldcup()
    scoring = data.get('scoring', {'correct_winner': 1, 'exact_score_bonus': 2})
    stats = {
        'players': len(data.get('friends', [])),
        'games': len(data.get('games', [])),
        'played': sum(1 for g in data.get('games', []) if g.get('result') is not None),
        'title': data.get('title', 'World Cup 2026'),
    }
    return render_template('worldcup_about.html', scoring=scoring, stats=stats)


@app.route('/worldcup/admin/login', methods=['GET', 'POST'])
def worldcup_admin_login():
    if session.get('wc_admin'):
        return redirect(url_for('worldcup_admin'))
    if request.method == 'POST':
        if _ADMIN_PW and request.form.get('password') == _ADMIN_PW:
            session['wc_admin'] = True
            return redirect(url_for('worldcup_admin'))
        flash('Incorrect password.')
    return render_template('worldcup_admin_login.html')


@app.route('/worldcup/admin/logout', methods=['POST'])
def worldcup_admin_logout():
    session.pop('wc_admin', None)
    return redirect(url_for('worldcup_admin_login'))


@app.route('/worldcup/admin')
@admin_required
def worldcup_admin():
    data = _load_worldcup()
    # Most recent games first, so today's fixtures sit at the top.
    games = sorted(data['games'], key=lambda g: g.get('date', ''), reverse=True)
    return render_template('worldcup_admin.html', games=games,
                           friends=data['friends'], stage_choices=_STAGE_CHOICES)


@app.route('/worldcup/admin/save', methods=['POST'])
@admin_required
def worldcup_admin_save():
    data = _load_worldcup()
    for game in data['games']:
        gid = str(game.get('id'))
        home = request.form.get('home_' + gid, '').strip()
        away = request.form.get('away_' + gid, '').strip()
        # Both boxes filled with valid numbers => final; otherwise => upcoming.
        if home != '' and away != '':
            try:
                game['result'] = {'home_score': int(home), 'away_score': int(away)}
            except ValueError:
                pass   # ignore a typo'd entry, leave that game unchanged
        else:
            game['result'] = None
    _save_worldcup(data)
    flash('Scores saved.')
    return redirect(url_for('worldcup_admin'))


_STAGE_CHOICES = [
    'Group Stage: Matchday 1', 'Group Stage: Matchday 2', 'Group Stage: Matchday 3',
    'Round of 32', 'Round of 16', 'Round of 8', 'Round of 4', 'Final',
]


def _winner_from_score(hs, aws):
    return 'home' if hs > aws else 'away' if hs < aws else 'draw'


@app.route('/worldcup/admin/game/new', methods=['POST'])
@admin_required
def worldcup_admin_add_game():
    data = _load_worldcup()
    home = request.form.get('home', '').strip()
    away = request.form.get('away', '').strip()
    if not (home and away):
        flash('Need both team names.')
        return redirect(url_for('worldcup_admin'))
    new_id = max((g.get('id', 0) for g in data['games']), default=0) + 1
    data['games'].append({
        'id': new_id,
        'stage': request.form.get('stage') or 'Group Stage: Matchday 1',
        'group': (request.form.get('group', '').strip() or None),
        'home': home,
        'away': away,
        'date': request.form.get('date', '').strip(),
        'result': None,
        'predictions': {},
    })
    _save_worldcup(data)
    flash('Added {} v {}. Now enter the picks.'.format(home, away))
    return redirect(url_for('worldcup_admin_game', gid=new_id))


@app.route('/worldcup/admin/player/new', methods=['POST'])
@admin_required
def worldcup_admin_add_player():
    data = _load_worldcup()
    name = request.form.get('name', '').strip()
    if name and name not in data['friends']:
        data['friends'].append(name)
        _save_worldcup(data)
        flash('Added player {}.'.format(name))
    return redirect(url_for('worldcup_admin'))


@app.route('/worldcup/admin/game/<int:gid>')
@admin_required
def worldcup_admin_game(gid):
    data = _load_worldcup()
    game = next((g for g in data['games'] if g.get('id') == gid), None)
    if game is None:
        abort(404)
    return render_template('worldcup_admin_game.html',
                           game=game, friends=data['friends'])


@app.route('/worldcup/admin/game/<int:gid>/picks', methods=['POST'])
@admin_required
def worldcup_admin_save_picks(gid):
    data = _load_worldcup()
    game = next((g for g in data['games'] if g.get('id') == gid), None)
    if game is None:
        abort(404)
    preds = {}
    for f in data['friends']:
        h = request.form.get('h_' + f, '').strip()
        a = request.form.get('a_' + f, '').strip()
        if h != '' and a != '':                 # both filled => a pick
            try:
                hs, aws = int(h), int(a)
            except ValueError:
                continue                         # skip a typo'd entry
            preds[f] = {'winner': _winner_from_score(hs, aws),
                        'home_score': hs, 'away_score': aws}
        # both blank => no pick for this player (omitted)
    game['predictions'] = preds
    _save_worldcup(data)
    flash('Picks saved.')
    return redirect(url_for('worldcup_admin_game', gid=gid))


# ── AI-assisted entry: type picks/results in plain English, preview, confirm ──
_OPENAI_MODEL = os.environ.get('WORLDCUP_AI_MODEL', 'gpt-4o-mini')


def _ai_context(data):
    lines = []
    for g in data['games']:
        r = g.get('result')
        rt = '{}-{}'.format(r['home_score'], r['away_score']) if r else 'not played'
        lines.append('id {}: {} (home) vs {} (away), {} [{}]'.format(
            g.get('id'), g.get('home'), g.get('away'), g.get('date', '?'), rt))
    return 'Players: {}\n\nGames:\n{}'.format(', '.join(data['friends']), '\n'.join(lines))


def _team_match(name, team):
    """Loose match of a named team to one of a game's sides."""
    n = (name or '').strip().lower()
    t = (team or '').strip().lower()
    if not n or not t:
        return False
    return n == t or n in t or t in n or n[:4] == t[:4]


def _ai_parse(text, data):
    """Ask OpenAI to turn plain-English input into structured changes.

    The model only has to NAME the winning team and the scoreline — it never
    decides home vs away. The server orients the score itself, which removes the
    most common error (flipping the scoreline when the away team is picked).
    """
    from openai import OpenAI
    client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))
    system = (
        "You convert a friends' World Cup prediction pool's updates from plain "
        "English into JSON. You are given the players and the games (with ids "
        "and the two teams in each).\n\n"
        "Each input describes either PREDICTIONS (a player's picks) or RESULTS "
        "(actual final scores):\n"
        "- \"X's picks are ...\", \"X: ...\" => predictions for player X.\n"
        "- \"final\", \"the score was\", \"result\", \"X beat Y\" => a result.\n"
        "- If unclear whether a line is a pick or a result, treat it as a "
        "PREDICTION and add a warning.\n\n"
        "For each game pick, identify: the game_id, the WINNING TEAM, and the "
        "score. Notation \"A-B TEAM\" or \"TEAM A-B\" means TEAM won A-B (A is "
        "TEAM's goals, B the opponent's). \"2-2\" with no clear winner is a "
        "draw. Do NOT reason about home vs away at all — just name the winning "
        "team exactly as it appears in the game, and give its goals and the "
        "opponent's goals. Match nicknames (Scots=Scotland, German=Germany, "
        "Para=Paraguay).\n\n"
        "Respond with ONLY this JSON object:\n"
        "{\"changes\":[{\"type\":\"prediction\" or \"result\",\"player\":name or "
        "null,\"game_id\":int,\"winner\":exact winning team name or \"draw\","
        "\"winner_goals\":int,\"loser_goals\":int,\"summary\":short line}],"
        "\"warnings\":[anything you could not map]}\n"
        "For a draw, set winner to \"draw\" and winner_goals = loser_goals = the "
        "drawn score. Only include changes the text clearly states; never invent "
        "results."
    )
    user = _ai_context(data) + '\n\nInput:\n' + text
    resp = client.chat.completions.create(
        model=_OPENAI_MODEL,
        messages=[{'role': 'system', 'content': system},
                  {'role': 'user', 'content': user}],
        response_format={'type': 'json_object'},
        temperature=0,
    )
    return json.loads(resp.choices[0].message.content)


@app.route('/worldcup/admin/ai')
@admin_required
def worldcup_admin_ai():
    return render_template('worldcup_admin_ai.html', proposed=None, raw_text='')


@app.route('/worldcup/admin/ai/parse', methods=['POST'])
@admin_required
def worldcup_admin_ai_parse():
    text = request.form.get('text', '').strip()
    if not text:
        flash('Type something to parse.')
        return redirect(url_for('worldcup_admin_ai'))
    if not os.environ.get('OPENAI_API_KEY'):
        flash('OPENAI_API_KEY is not set on the server.')
        return redirect(url_for('worldcup_admin_ai'))
    data = _load_worldcup()
    try:
        parsed = _ai_parse(text, data)
    except Exception as e:                       # noqa: BLE001 (admin-only surface)
        flash('AI parse failed: {}'.format(e))
        return redirect(url_for('worldcup_admin_ai'))
    # Validate everything the model proposed against the real data.
    by_id = {g.get('id'): g for g in data['games']}
    clean, warnings = [], list(parsed.get('warnings', []) or [])
    for ch in parsed.get('changes', []) or []:
        g = by_id.get(ch.get('game_id'))
        if g is None:
            warnings.append('Unknown game id {}'.format(ch.get('game_id')))
            continue
        # Orient the score ourselves from the named winner — the model never
        # decides home/away, so an away-team pick can't get flipped.
        try:
            wg, lg = int(ch['winner_goals']), int(ch['loser_goals'])
        except (KeyError, ValueError, TypeError):
            warnings.append('Bad score in: {}'.format(ch.get('summary', ch)))
            continue
        winner = (ch.get('winner') or '').strip()
        if winner.lower() == 'draw':
            hs = aws = wg
        elif _team_match(winner, g.get('home')):
            hs, aws = wg, lg
        elif _team_match(winner, g.get('away')):
            hs, aws = lg, wg
        else:
            warnings.append('Couldn\'t tell which team "{}" is in {} v {}'.format(
                winner, g.get('home'), g.get('away')))
            continue
        if ch.get('type') == 'prediction':
            player = ch.get('player')
            if player not in data['friends']:
                warnings.append('Unknown player "{}"'.format(player))
                continue
            clean.append({'type': 'prediction', 'player': player, 'game_id': g['id'],
                          'home_score': hs, 'away_score': aws,
                          'label': '{} predicts {} {}-{} {}'.format(
                              player, g['home'], hs, aws, g['away'])})
        elif ch.get('type') == 'result':
            clean.append({'type': 'result', 'game_id': g['id'],
                          'home_score': hs, 'away_score': aws,
                          'label': 'RESULT: {} {}-{} {}'.format(
                              g['home'], hs, aws, g['away'])})
        else:
            warnings.append('Unclear change: {}'.format(ch.get('summary', ch)))
    proposed = {'changes': clean, 'warnings': warnings, 'payload': json.dumps(clean)}
    return render_template('worldcup_admin_ai.html', proposed=proposed, raw_text=text)


# Model used for the web-search fixtures lookup (separate so you can point it at
# a search-capable model if needed).
_FIXTURES_MODEL = os.environ.get('WORLDCUP_FIXTURES_MODEL', 'gpt-4o-mini')


def _ai_fixtures(today_iso):
    """Use OpenAI web search to find today's World Cup fixtures."""
    from openai import OpenAI
    client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))
    prompt = (
        "Search the web for the FIFA World Cup 2026 matches scheduled on "
        + today_iso + ". For each match give the two teams (home team first), "
        "the stage, and the group letter if it's a group game. Use stage strings "
        "exactly like 'Group Stage: Matchday 1', 'Group Stage: Matchday 2', "
        "'Group Stage: Matchday 3', 'Round of 32', 'Round of 16', 'Round of 8', "
        "'Round of 4', or 'Final'. Use common short English team names "
        "(e.g. 'South Korea', 'Turkey', 'USA', 'Bosnia and Herzegovina'). "
        "Respond with ONLY a JSON object of the form "
        "{\"fixtures\":[{\"home\":\"..\",\"away\":\"..\","
        "\"stage\":\"..\",\"group\":\"A\"}]}. Use null for group if not "
        "applicable. If there are no matches that day, return an empty list."
    )
    resp = client.responses.create(
        model=_FIXTURES_MODEL,
        tools=[{'type': 'web_search_preview'}],
        input=prompt,
    )
    raw = resp.output_text
    start, end = raw.find('{'), raw.rfind('}')
    if start == -1 or end == -1:
        return []
    return json.loads(raw[start:end + 1]).get('fixtures', [])


@app.route('/worldcup/admin/ai/fixtures', methods=['POST'])
@admin_required
def worldcup_admin_ai_fixtures():
    if not os.environ.get('OPENAI_API_KEY'):
        flash('OPENAI_API_KEY is not set on the server.')
        return redirect(url_for('worldcup_admin_ai'))
    data = _load_worldcup()
    today_iso = date.today().isoformat()
    try:
        fixtures = _ai_fixtures(today_iso)
    except Exception as e:                       # noqa: BLE001 (admin-only surface)
        flash('Fixture lookup failed: {}'.format(e))
        return redirect(url_for('worldcup_admin_ai'))
    # Skip fixtures already in the data (same teams, same day).
    existing = {(g.get('home', '').lower(), g.get('away', '').lower(), g.get('date'))
                for g in data['games']}
    clean, warnings = [], []
    for fx in fixtures:
        home = (fx.get('home') or '').strip()
        away = (fx.get('away') or '').strip()
        if not (home and away):
            continue
        if (home.lower(), away.lower(), today_iso) in existing:
            warnings.append('Already in the pool: {} v {}'.format(home, away))
            continue
        clean.append({'type': 'game', 'home': home, 'away': away,
                      'stage': fx.get('stage') or 'Group Stage: Matchday 1',
                      'group': fx.get('group'), 'date': today_iso,
                      'label': 'Add {} v {}  ({})'.format(
                          home, away, fx.get('stage') or 'group stage')})
    if not clean and not warnings:
        warnings.append('No World Cup matches found for {}.'.format(today_iso))
    proposed = {'changes': clean, 'warnings': warnings, 'payload': json.dumps(clean)}
    return render_template('worldcup_admin_ai.html', proposed=proposed, raw_text='')


@app.route('/worldcup/admin/ai/apply', methods=['POST'])
@admin_required
def worldcup_admin_ai_apply():
    try:
        changes = json.loads(request.form.get('payload', '[]'))
    except ValueError:
        flash('Could not read the proposed changes.')
        return redirect(url_for('worldcup_admin_ai'))
    data = _load_worldcup()
    by_id = {g.get('id'): g for g in data['games']}
    applied = 0
    for ch in changes:
        typ = ch.get('type')
        if typ == 'game':                         # add a new fixture (no result)
            home = (ch.get('home') or '').strip()
            away = (ch.get('away') or '').strip()
            if home and away:
                new_id = max((g.get('id', 0) for g in data['games']), default=0) + 1
                data['games'].append({
                    'id': new_id,
                    'stage': ch.get('stage') or 'Group Stage: Matchday 1',
                    'group': (ch.get('group') or None),
                    'home': home, 'away': away,
                    'date': ch.get('date', ''),
                    'result': None, 'predictions': {}})
                applied += 1
            continue
        g = by_id.get(ch.get('game_id'))
        if g is None:
            continue
        try:
            hs, aws = int(ch['home_score']), int(ch['away_score'])
        except (KeyError, ValueError, TypeError):
            continue
        if typ == 'prediction' and ch.get('player') in data['friends']:
            g.setdefault('predictions', {})[ch['player']] = {
                'winner': _winner_from_score(hs, aws),
                'home_score': hs, 'away_score': aws}
            applied += 1
        elif typ == 'result':
            g['result'] = {'home_score': hs, 'away_score': aws}
            applied += 1
    _save_worldcup(data)
    flash('Applied {} change(s).'.format(applied))
    return redirect(url_for('worldcup_admin_ai'))
'''
@app.route('/worldcup')
def worldcup():
    return redirect('/predictions', code=301)

@app.route('/<path:path>/')
@app.route('/<path:path>')
def page(path):
    page = pages.get_or_404(path)
    if 'img_folder' in page.meta:
        print('hello')
        image_files=os.listdir(page.meta['img_folder'])
        image_urls= [f"{page.meta['img_folder']}{img}" for img in image_files if img.lower().endswith(('jpg', 'jpeg', 'png', 'gif'))]
    elif 'image' in page.meta:
        image_urls=[page.meta['image']]
    else: 
        image_urls=[]
    return render_template('page.html', page=page, images=image_urls)
if __name__ == '__main__':
    app.run()
