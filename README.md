# Hangtag

Tap-to-sell billing, stock tracking, and sales analytics for clothing pop-ups and retail stores — powered by a **Supabase (PostgreSQL)** cloud database with real-time multi-device sync and offline resilience.

**Live app:** https://florix-technologies.github.io/hangtag/

---

## Highlights

- **Multi-Device Realtime Sync:** Ring up sales on multiple phones and laptops at the same time. Stock counts, live dashboards, and sales reports update across all devices in real time.
- **PostgreSQL Cloud Database:** Backed by Supabase PostgreSQL tables for products, inventory sizes, images, bills, and line items.
- **Works Offline:** If the venue loses WiFi or mobile network, sales keep ringing up smoothly. Transactions are safely queued locally and uploaded automatically when connectivity returns.
- **Tap-to-Sell Interface:** Product → Size → Cash / UPI / Card. Change quantity or add a discount on the fly. Full desktop keyboard shortcuts (`1`–`0` for products, `1`–`9` for sizes, `C` Cash, `U` UPI, `K` Card).
- **Live Inventory Tracking:** Stock counts decrement automatically with every bill. Restock alerts highlight sizes with 3 or fewer pieces remaining.
- **Comprehensive Reports:** Real-time revenue charts by hour, day, or month, payment breakdown, best sellers, product × size matrix, bill cancellation & restore, and 1-click CSV export.

---

## Database Setup (Supabase / PostgreSQL)

Connecting a database to Hangtag takes less than 2 minutes:

### 1. Create a Supabase Project
1. Go to [supabase.com](https://supabase.com) and create a free project.
2. In your Supabase project dashboard, open the **SQL Editor** (left sidebar).
3. Click **New Query**, paste the contents of [`schema.sql`](file:///c:/Users/RAJ/Downloads/hangtag/schema.sql), and click **Run**.

### 2. Connect Hangtag
Open Hangtag and click the **Database Status Pill** in the top navigation bar (or go to **Products → Cloud Database & Multi-Device Sync**):
1. Copy your **Project URL** and **Anon Public API Key** from Supabase (*Project Settings → API*).
2. Paste them into the Database Settings modal in Hangtag and click **Save & Connect**.
3. *(Optional)* Click **"Push Local Data to Database"** to immediately upload your existing catalog, stock, photos, and sales history to PostgreSQL.

> **Tip:** You can also pre-configure your Supabase credentials in [`config.js`](file:///c:/Users/RAJ/Downloads/hangtag/config.js).

---

## Files

| File | Description |
|---|---|
| `index.html` | Complete single-page app with POS, inventory, reports, and Supabase real-time sync |
| `schema.sql` | PostgreSQL schema script with tables, indexes, RLS policies, and Realtime publications |
| `config.js` | Optional configuration file for Supabase project credentials |
| `sw.js` | Service worker for offline caching and PWA installation |
| `manifest.webmanifest` | Web app manifest for home screen install on iOS and Android |
| `icon.svg`, `*.png` | Application icons |
| `.nojekyll` | GitHub Pages configuration |

---

## Hosting on GitHub Pages

1. Commit and push the repository to GitHub.
2. Go to **Settings → Pages → Build and deployment**.
3. Set **Source** to *Deploy from a branch*, select branch `main` and folder `/ (root)`, then click **Save**.
4. Your POS app is live at `https://<your-username>.github.io/<repository-name>/`.
