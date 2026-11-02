# Shop (`/shop`)

A small art print shop. The catalog is `shop/catalog.json`; checkout is Stripe Payment Links, so card data never touches this server.

## Add or change a print

1. Put the image in `static/images/shop/` (about 1600px on the long side, JPG).
2. Add an entry to `prints` in `shop/catalog.json`:

```json
{
  "slug": "heron-at-dusk",
  "title": "Heron at Dusk",
  "medium": "Giclée on Hahnemühle Photo Rag",
  "description": "Watercolor, 2026.",
  "image": "images/shop/heron-at-dusk.jpg",
  "sizes": [
    {"label": "8 × 10 in", "price": 35, "payment_link": "https://buy.stripe.com/...", "edition": "Open edition"},
    {"label": "11 × 14 in", "price": 55, "payment_link": "https://buy.stripe.com/...", "edition": "Limited edition of 25"}
  ]
}
```

The JSON is re-read on every request, so changes go live without a restart.

- A size with no `payment_link` shows **Coming soon**.
- `"sold_out": true` on a size shows **Sold out**.
- `"hidden": true` on a print removes it from the shop.
- Set `artist`, `tagline`, `about`, and `contact_email` at the top of the file.

## Stripe setup (once)

1. **Products:** one Stripe product per print, one price per size.
2. **Payment Links:** one link per size. For each:
   - Collect shipping address; add a flat shipping rate.
   - Turn on automatic tax (needs Stripe Tax and the home-state registration added in Stripe).
   - Limited editions: **Limit the number of payments** to the edition size so the link shuts off when it sells out. Then add `"sold_out": true` here.
   - After payment, redirect to `https://nathancordrey.com/shop/thanks`.
3. Paste each link's URL into the matching `payment_link`.

## Orders

Stripe emails a receipt to the buyer and a notification to the account owner. Ship from the Stripe dashboard's payment details (shipping address is on each payment). Order prints from the lab in batches; drop-shipping via the FinerWorks API is a later step.
