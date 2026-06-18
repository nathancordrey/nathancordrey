from flask import Flask, render_template
from flask_flatpages import FlatPages
import os
import json
from collections import OrderedDict
app = Flask(__name__)
app.config.from_object(__name__)
#Initialize flatpages
app.config['FLATPAGES_EXTENSION'] = '.md'
pages = FlatPages(app)
recipes=[]

# Resolve the worldcup data path relative to this file, so it works regardless
# of what working directory gunicorn/systemd launches the app from on Linode.
_WORLDCUP_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'worldcup.json')

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

@app.route('/worldcup')
def worldcup():
    with open(_WORLDCUP_JSON) as f:
        data = json.load(f)

    scoring = data.get('scoring', {'correct_winner': 1, 'exact_score_bonus': 2})
    friends = data['friends']
    games = data['games']

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

    # ── Matchday 1 awards: trophies for the top 3, a clown for last place. ──
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
        worst = min(md_points(f, _MD1) for f in friends)
        for f in friends:                       # clown for last place (ties allowed)
            if md_points(f, _MD1) == worst and f not in awards:
                awards[f] = '🤡'

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

    return render_template('worldcup.html',
                           data=data,
                           leaderboard=leaderboard,
                           stages=stages,
                           lb_past=lb_past,
                           lb_active=lb_active,
                           scoring=scoring)

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
