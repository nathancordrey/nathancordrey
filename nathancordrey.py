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

    # Initialize per-friend score totals
    scores = {f: {'total': 0, 'correct_winner': 0, 'exact_score': 0} for f in friends}

    # Process each game: determine actual winner, score predictions
    for game in games:
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
                game['friend_results'][friend] = {
                    'winner_correct': winner_correct,
                    'exact_score': exact,
                    'points': pts,
                    'pred': pred
                }

    # Sort leaderboard by total points
    leaderboard = sorted(
        [{'name': f, **scores[f]} for f in friends],
        key=lambda x: x['total'],
        reverse=True
    )

    # Group games by stage (preserving order they appear in JSON)
    stages_dict = OrderedDict()
    for game in games:
        stage = game.get('stage', 'Other')
        if stage not in stages_dict:
            stages_dict[stage] = []
        stages_dict[stage].append(game)
    stages = [{'name': k, 'games': v} for k, v in stages_dict.items()]

    return render_template('worldcup.html',
                           data=data,
                           leaderboard=leaderboard,
                           stages=stages,
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
