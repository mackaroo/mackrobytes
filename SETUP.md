# MackroBytes setup

MackroBytes is one app for decluttering, listing and selling. It replaces Garage Sort, Declutter & Sell, and the MackroBytes Studio artifact.

It's plain HTML/CSS/JS with no build step. It's hosted free on GitHub Pages, and Supabase (also free) holds the database, your login and your photos. Changes sync live between your iPhone, Mac and Windows PC.

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
   - Don't upload the `mackrobytes-import` folder. It has your item data and photos.
3. Go to **Settings → Pages**. Set Source to "Deploy from a branch", choose branch `main` and folder `/ (root)`, and click **Save**.
4. After a minute or two, the app is live at `https://<your-username>.github.io/mackrobytes/`.

## 3. Bring over your Declutter & Sell items (once)
This copies all 41 items and their 20 cover photos into the app, and sets the SKU counter so new items start at MB26-0043.

Open Terminal in `claude-code-projects` and run:

```bash
node mackrobytes-import/run-import.mjs
```

It asks for the MackroBytes email and password you made in step 1.3. It doesn't save them. You can safely run it twice, because items already in the app are skipped.

## 4. Put it on each device
- **iPhone 15 Pro:** open the link in **Safari**, tap **Share → Add to Home Screen**, then open it from the new icon and sign in.
- **MacBook Pro:** open the link in Chrome and click the install icon at the right end of the address bar. In Safari, use **File → Add to Dock**.
- **Windows 11 PC:** open the link in Edge or Chrome and choose **⋯ → Apps → Install this site as an app**. It then shows up in the Start menu.

You sign in once per device. After that, everything stays in sync.

## Getting around
- **Bottom bar:** Home, Items, **+** (Add), Sort, Money. Swipe left or right anywhere on a page to move to the next tab.
- **Top right:** 🔧 opens seller Tools (fees, offers, messages, bundles, shipping, growth tips, Ask Claude). ⚙ opens Settings, where you set your name, weekly goal, SKU numbering, fees, theme and backups.
- **Items:** tap an item to open it. Swipe right from the left edge of the screen to close it.
- **Sort:** snap or pick photos of a pile, then tap **Start sorting**. Swipe each card: **right = Keep, left = Donate, up = Sell, down = Trash**. You can also use the buttons for Storage and Ask first. On a computer, the arrow keys work too.
  - **Sell** runs a "worth selling?" check first, using real fees and shipping. If it's worth it, the thing becomes an item in Items with the next SKU and its photo.
  - **Keep / Storage** asks where it's going, so **Where is it?** can find it later.
  - **Ask first** holds things that are Mom's or Dad's call until they answer.
  - **Donate pile → Log a drop-off** saves the date, place and values for taxes. The yearly total shows on the Money tab.

## AI features (free, copy & paste)
**Write my listing**, **Look it up**, **Daily audit**, **Ask Claude** and the other AI buttons all work the same way:
1. The app shows a prompt. Tap **Copy prompt**.
2. Paste it into the Claude app. When you're writing a listing, attach the item's photos too.
3. Copy Claude's whole reply, paste it back into the app, and tap **Use this reply**.

For lookups, Claude searches the web for the official title, brand, model and so on. It only fills in fields that are blank.

## Good to know
- Free Supabase projects **pause after 7 days with no use**. If the app stops loading, open the Supabase dashboard and click **Restore project**.
- Photos are resized before upload. The free tier (1 GB) holds several thousand photos.
- **Settings → Backup** saves a JSON copy of everything except photos.
- To update the app later, upload the changed files to the GitHub repo again. Devices pick up the new version the next time they open it.
