from flask import Flask, render_template
from flask_flatpages import FlatPages

app = Flask(__name__)
app.config.from_object(__name__)

#Initialize flatpages
app.config['FLATPAGES_EXTENSION'] = '.md'
pages = FlatPages(app)

recipes=[]

@app.route('/')
def index():
    page = pages.get_or_404('index')
    return render_template('page.html', page=page)

@app.route('/recipes')
def recipes():
    recipes = (p for p in pages if 'date' in p.meta and p.path[:6]=='recipe')
    latest = sorted(recipes, reverse=True, key=lambda p: p.meta['date'])
    return render_template('recipes.html', recipes=latest)
'''
@app.route('/debug')
def debug():
    return str([p.path for p in pages])
'''

@app.route('/<path:path>/')
@app.route('/<path:path>')
def page(path):
    page = pages.get_or_404(path)
    return render_template('page.html', page=page)


if __name__ == '__main__':
    app.run()
