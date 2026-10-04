# Hangtag

Tap-to-sell billing and stock tracking for a clothing pop-up. Built for busy sale days on a phone or laptop — no billing machine, QR code or barcode scanner needed.

**Live app:** https://florix-technologies.github.io/hangtag/

## What it does

- **Sell in three taps:** product → size → Cash / UPI / Card. Change quantity or add a discount when you need to.
- **Live stock:** every bill takes pieces off the shelf. Sizes with 3 or fewer pieces, and sold-out sizes, are flagged.
- **Sales report:** total sales compared with the previous day or period, sales by hour or day, how customers paid (with the cash that should be in the box), best sellers, sizes that sold, a product × size grid, and every bill with cancel / restore. Download any period as a CSV file.
- **Product photos:** take a photo with your phone or pick one from your gallery. It is shrunk to a small square thumbnail.
- **Works offline** once it has been opened, and can be installed on your home screen like an app.

## Using it

1. Open the app and go to **Products**. Replace the example products with yours: name, price, sizes and how many pieces you have. Add photos, then tap **Save products**.
2. On sale day use **Sell**. On a laptop you can use the keyboard: `1`–`0` picks a product, `1`–`9` a size, then `C` cash · `U` UPI · `K` card.
3. Check **Stock** and **Reports** at any time.

### Install it on your phone

- **Android (Chrome):** open the link → menu ⋮ → **Add to Home screen** (or **Install app**).
- **iPhone (Safari):** open the link → Share → **Add to Home Screen**.

## Where your data is kept

This version keeps everything **in the browser on each device**. There is no server and no account, so:

- Your phone and your laptop each keep **their own** products and bills. To combine them, use **Products → Download backup** on one device and **Restore from backup** on the other.
- Clearing the browser's data for this site deletes it. **Download a backup after every sale day.**

The code in this repository contains no sales data, prices or photos — those stay on your devices.

## Hosting it on GitHub Pages

1. Put all the files from this folder at the top level of the repository.
2. The repository must be **public** on a free GitHub account (private repositories need a paid plan for Pages).
3. Go to **Settings → Pages → Build and deployment**. Set **Source** to *Deploy from a branch*, **Branch** to `main` and the folder to `/ (root)`, then **Save**.
4. After a minute or two the app is live at `https://<your-username>.github.io/<repository-name>/`.

To update the app later, upload the changed files again. Open the app twice afterwards: the first visit refreshes the saved offline copy, the second shows the new version.

### Pages your customers open (no sign-in)

Three pages are meant for customers, not staff. They must be reachable by anyone on the internet, over **https**, at the same address as the app:

| Page | Opened from | What it does |
|---|---|---|
| `store.html#s=<store token>` | Store → Share Store, the store QR, Copy link | The shop's mobile store: browse, choose variants, cart, name and phone, place a guest order, see its status |
| `order.html#t=<table token>` | A restaurant table's QR code | Guests order for their table |
| `receipt.html#…` | Invoice links sent by email, WhatsApp or SMS | The bill as a page the customer can print or save |

They talk to the database only through a few deliberately public functions (`hangtag_mobile_catalog`, `hangtag_place_mobile_order`, `hangtag_mobile_order_status`, `hangtag_table_menu`, `hangtag_place_table_order`, and the receipt link function); each one finds the shop by its token and checks that the shop has switched the feature on. No table is readable without signing in.

- **GitHub Pages** (public repository): nothing to configure; the pages are public with the app.
- **Vercel**: the project's **Deployment Protection** (Vercel Authentication or password protection) must be **off for the production domain**, or customers see a Vercel sign-in page instead of the store. Turn it off in *Project → Settings → Deployment Protection* (protecting only preview deployments is fine). Hangtag never changes this setting itself.
- **Any other host**: serve the files as they are, over https, with no login in front of them. `config.js` holds only the publishable key (never a secret).
- Speech recognition (voice search) and the camera scanner also need https: they work on the hosted address and on `localhost`, not on a plain `http://` address on the network.

## Files

| File | What it is |
|---|---|
| `index.html` | The app shell: page markup, stylesheet links and the start-up script tag |
| `store.html`, `store.js` | The public mobile store (see "Pages your customers open") |
| `order.html`, `order.js` | A restaurant table's ordering page (table QR) |
| `receipt.html`, `receipt.js` | The bill a customer opens from an invoice link |
| `src/` | The app's code as ES modules and stylesheets (see [ARCHITECTURE.md](ARCHITECTURE.md)) |
| `config.js` | Supabase URL and publishable key (public by design; never a secret) |
| `sw.js` | Keeps the app working offline; its file list is generated by `npm run build` |
| `manifest.webmanifest` | Name and icons used when you add it to your home screen |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | App icons |
| `.nojekyll` | Tells GitHub Pages to publish the files exactly as they are (optional) |

## Development

The app runs straight from the repository as native ES modules, with nothing to compile. The tools below need Node.js
and are only for checking and testing (`npm install` first).

| Command | What it does |
|---|---|
| `npm run build` | Updates the offline file list in `sw.js`, checks the architecture rules, bundle-checks and lints `src/`. Run it after changing anything under `src/`, and commit the updated `sw.js`. |
| `npm run check` | The same checks, without writing |
| `npm test` | Unit, database and browser tests (browser tests need Chrome and use port 3210) |
| `npm run test:unit` · `test:db` · `test:e2e` | One group of tests |

How the code is organised, and how to add a feature, is in [ARCHITECTURE.md](ARCHITECTURE.md).
