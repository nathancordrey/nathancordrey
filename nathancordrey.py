from flask import Flask, render_template
from flask_flatpages import FlatPages
import os

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
    trips = (p for p in pages if p.path[:6]=='travel')
    latest = sorted(trips, reverse=True, key=lambda p: p.meta['date'])
    years=[2017]
    return render_template('travel.html', trips=latest, years=years)

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
    return render_template('page2.html', page=page, images=image_urls)



if __name__ == '__main__':
    app.run()
