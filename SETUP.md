# MackroBytes setup

MackroBytes tracks items by SKU, finds the right item from a sale receipt, and totals payouts.

It's plain HTML/CSS/JS with no build step. It's hosted free on GitHub Pages, and Supabase (also free) holds the database, your login and your photos. Changes sync live between your devices.

Setup takes about 20 minutes, once.

## 1. Supabase (database, login, photos)
1. Go to https://supabase.com, sign up and click **New project**. Pick any name and the region closest to Michigan (East US). Save the database password somewhere safe.
2. Open **SQL Editor → New query**. Paste all of `schema.sql` and click **Run**. It should say "Success".
3. Go to **Authentication → Users → Add user → Create new user**. Enter your email and a new password, and tick **Auto confirm user**.
4. Go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". After this, only the account you just made can sign in.
5. Go to **Project Settings → API**. Copy the **Project URL** and the **anon / publishable key** into `config.js` in place of the `YOUR_...` placeholders.

The anon key is safe to publish. The database refuses anyone who isn't signed in.

## 2. GitHub Pages (hosting)
1. On github.com, create a new repository named `mackrobytes`. It has to be **Public** for free Pages. Your data stays private because it lives in Supabase behind your login, not in the repo.
2. Upload **only the files in this `mackrobytes` folder**. Use **Add file → Upload files** and drag them in.
3. Go to **Settings → Pages**. Set Source to "Deploy from a branch", choose branch `main` and folder `/ (root)`, and click **Save**.
4. After a minute or two, the app is live at `https://<your-username>.github.io/mackrobytes/`.

## 3. Put it on each device
- **iPhone 15 Pro:** open the link in **Safari**, tap **Share → Add to Home Screen**, then open it from the new icon and sign in.
- **MacBook Pro:** open the link in Chrome and click the install icon at the right end of the address bar. In Safari, use **File → Add to Dock**.
- **Windows 11 PC:** open the link in Edge or Chrome and choose **⋯ → Apps → Install this site as an app**. It then shows up in the Start menu.

You sign in once per device. After that, everything stays in sync.

## Getting around
- **Add item:** drag in photos, enter a name, pick a box, and get the SKU to write on the bag.
- **Mark listed:** enter the price and where it's listed.
- **Record sale:** enter what it sold for, pick the item, and enter your total payout. The app shows which box to pull it from.
- **Click a status pill** on a row to change its status.
- **Click any row** to change its details or delete it. Moving a sold item back to an earlier status undoes the sale.

## Good to know
- Free Supabase projects **pause after 7 days with no use**. If the app stops loading, open the Supabase dashboard and click **Restore project**.
- Photos are resized before upload. The free tier (1 GB) holds several thousand photos.
- **Settings → Save backup file** saves a JSON copy of everything except photos.
- iPhone HEIC photos can't be read in Chrome. Use JPEG or PNG files.
- Only the app's own files go to the public GitHub repo; `.gitignore` lists them. A new app file has to be added there first.
- Bug fixes go live when Claude pushes them, and new features wait until you say "push". Devices pick up the new version the next time they open it.
