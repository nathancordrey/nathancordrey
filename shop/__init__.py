"""Art print shop at /shop.

The catalog lives in shop/catalog.json and is re-read on every request, so
adding a print or marking one sold out is a JSON edit, no restart needed.

Checkout is handled entirely by Stripe Payment Links (one link per print size),
so this app never sees card data. See shop/README.md for setup.
"""

import json
import os

from flask import Blueprint, abort, render_template

_CATALOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'catalog.json')

shop = Blueprint('shop', __name__, template_folder='templates', url_prefix='/shop')


def load_catalog():
    with open(_CATALOG) as f:
        data = json.load(f)
    prints = []
    for p in data.get('prints', []):
        if p.get('hidden'):
            continue
        # A size is buyable only when it has a Payment Link and isn't sold out.
        for s in p.get('sizes', []):
            s['available'] = bool(s.get('payment_link')) and not s.get('sold_out')
        p['available'] = any(s['available'] for s in p.get('sizes', []))
        prints.append(p)
    data['prints'] = prints
    return data


@shop.app_template_filter('usd')
def usd(value):
    value = float(value)
    return '${:,.0f}'.format(value) if value.is_integer() else '${:,.2f}'.format(value)


@shop.route('/')
def index():
    return render_template('shop/index.html', catalog=load_catalog())


@shop.route('/<slug>')
def detail(slug):
    catalog = load_catalog()
    item = next((p for p in catalog['prints'] if p['slug'] == slug), None)
    if item is None:
        abort(404)
    return render_template('shop/detail.html', catalog=catalog, item=item)


@shop.route('/thanks')
def thanks():
    return render_template('shop/thanks.html', catalog=load_catalog())
