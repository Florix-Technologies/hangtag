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

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app — HTML, CSS and JavaScript in one file |
| `sw.js` | Keeps the app working offline |
| `manifest.webmanifest` | Name and icons used when you add it to your home screen |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | App icons |
| `.nojekyll` | Tells GitHub Pages to publish the files exactly as they are (optional) |
